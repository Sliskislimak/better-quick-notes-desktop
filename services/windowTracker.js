// windowTracker.js · follows the foreground Windows application.
//
// Uses koffi (prebuilt FFI) to call user32/kernel32/dwmapi directly:
//   - SetWinEventHook for foreground, minimize, move/size and location events
//     (out-of-context hooks are delivered through the Electron main thread's
//     message loop, so callbacks run on the JS thread)
//   - a polling loop as a safety net, because some apps (UWP hosts, elevated
//     windows, games) do not deliver every event to unelevated listeners
//
// Emitted events (all payloads use physical screen pixels):
//   'target'         (info | null)  foreground moved to another app window, or to
//                                   something we never attach to (desktop, taskbar…)
//   'own-focus'      ()             one of our own windows became foreground
//   'target-bounds'  (info)         the tracked window moved or resized
//   'target-minimized' (info)       the tracked window was minimized
//   'target-title'   (info)         the tracked window's title changed

const { EventEmitter } = require('events');
const path = require('path');

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_SYSTEM_MOVESIZESTART = 0x000A;
const EVENT_SYSTEM_MOVESIZEEND = 0x000B;
const EVENT_SYSTEM_MINIMIZESTART = 0x0016;
const EVENT_SYSTEM_MINIMIZEEND = 0x0017;
const EVENT_OBJECT_DESTROY = 0x8001;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const EVENT_OBJECT_NAMECHANGE = 0x800C;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;
const OBJID_WINDOW = 0;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const GA_ROOTOWNER = 3;
const VK_LBUTTON = 0x01;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const SW_RESTORE = 9;

// Shell surfaces that should never get a sticky note bar.
const SHELL_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow', 'MultitaskingViewFrame', 'TaskSwitcherWnd',
  'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'TopLevelWindowForOverflowXamlIsland',
  'Windows.UI.Core.CoreWindow', '#32768', 'tooltips_class32', 'SysShadow'
]);
const SHELL_PROCESSES = new Set([
  'searchhost.exe', 'searchapp.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe',
  'lockapp.exe', 'textinputhost.exe', 'searchui.exe'
]);

let native = null;
let nativeError = null;

function loadNative() {
  if (native || nativeError) return native;
  if (process.platform !== 'win32') {
    nativeError = new Error('Window tracking is only implemented for Windows.');
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const dwmapi = koffi.load('dwmapi.dll');

    const RECT = koffi.struct('QN_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const WinEventProc = koffi.proto('void __stdcall QN_WinEventProc(intptr_t hook, uint32_t event, intptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)');

    native = {
      koffi,
      WinEventProc,
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ QN_RECT *rect)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)'),
      FindWindowExW: user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
      BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
      AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool attach)'),
      GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
      keybd_event: user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'),
      SetWinEventHook: user32.func('intptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, intptr_t hmod, QN_WinEventProc *cb, uint32_t pid, uint32_t thread, uint32_t flags)'),
      UnhookWinEvent: user32.func('bool __stdcall UnhookWinEvent(intptr_t hook)'),
      GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t handle)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t proc, uint32_t flags, _Out_ uint8_t *buf, _Inout_ uint32_t *size)'),
      DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ QN_RECT *rect, uint32_t size)'),
      RECT_SIZE: koffi.sizeof(RECT)
    };
  } catch (e) {
    nativeError = e;
    native = null;
  }
  return native;
}

const toNum = (h) => (typeof h === 'bigint' ? Number(h) : (h || 0));

function readWideString(fn, hwnd, max = 512) {
  const buf = Buffer.alloc(max * 2);
  const n = fn(hwnd, buf, max);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

const exeCache = new Map(); // pid -> { exePath, ts }

function processImagePath(pid) {
  const cached = exeCache.get(pid);
  if (cached && Date.now() - cached.ts < 60_000) return cached.exePath;
  let exePath = '';
  const h = native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (toNum(h)) {
    try {
      const buf = Buffer.alloc(1024 * 2);
      const size = [1024];
      if (native.QueryFullProcessImageNameW(h, 0, buf, size)) {
        exePath = buf.toString('utf16le', 0, size[0] * 2);
      }
    } finally {
      native.CloseHandle(h);
    }
  }
  exeCache.set(pid, { exePath, ts: Date.now() });
  if (exeCache.size > 256) exeCache.delete(exeCache.keys().next().value);
  return exePath;
}

function windowBounds(hwnd) {
  const rect = {};
  // Extended frame bounds exclude the invisible resize borders Windows 10/11
  // add around every window, so the bar lines up with the visible edge.
  const hr = native.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, native.RECT_SIZE);
  if (hr !== 0 || rect.right === undefined) {
    if (!native.GetWindowRect(hwnd, rect)) return null;
  }
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

// UWP apps (Calculator, Photos, Settings…) are all framed by
// ApplicationFrameHost.exe; the real app owns the CoreWindow child.
function uwpAppProcess(frameHwnd, framePid) {
  let child = 0;
  for (let i = 0; i < 8; i++) {
    child = toNum(native.FindWindowExW(frameHwnd, child, 'Windows.UI.Core.CoreWindow', null));
    if (!child) return null;
    const pidOut = [0];
    native.GetWindowThreadProcessId(child, pidOut);
    if (pidOut[0] && pidOut[0] !== framePid) {
      const exePath = processImagePath(pidOut[0]);
      if (exePath) return { pid: pidOut[0], exePath };
    }
  }
  return null;
}

function describeWindow(rawHwnd) {
  if (!loadNative()) return null;
  let hwnd = toNum(rawHwnd);
  if (!hwnd || !native.IsWindow(hwnd)) return null;

  // Dock to the application's main window, not to one of its owned dialogs.
  const root = toNum(native.GetAncestor(hwnd, GA_ROOTOWNER));
  if (root && root !== hwnd && native.IsWindowVisible(root)) {
    const rb = windowBounds(root);
    if (rb && rb.width > 50 && rb.height > 50) hwnd = root;
  }

  const pidOut = [0];
  native.GetWindowThreadProcessId(hwnd, pidOut);
  const windowPid = pidOut[0];
  let pid = windowPid;
  let exePath = processImagePath(pid);
  if (/\\applicationframehost\.exe$/i.test(exePath)) {
    const app = uwpAppProcess(hwnd, pid);
    if (app) ({ pid, exePath } = app);
  }
  const processName = exePath ? path.win32.basename(exePath) : '';
  return {
    hwnd,
    pid,
    windowPid,
    exePath,
    process: processName,
    processKey: processName.toLowerCase(),
    title: readWideString(native.GetWindowTextW, hwnd),
    className: readWideString(native.GetClassNameW, hwnd, 256),
    bounds: windowBounds(hwnd),
    minimized: !!native.IsIconic(hwnd),
    maximized: !!native.IsZoomed(hwnd),
    visible: !!native.IsWindowVisible(hwnd)
  };
}

function sameBounds(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

class WindowTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ownPid = options.ownPid || process.pid;
    this.isExcluded = options.isExcluded || (() => false);
    this.pollMs = options.pollMs || 250;
    this.target = null;
    this.lastForeground = 0;
    this.ownFocused = false;
    this.hooks = [];
    this.locationHook = 0;
    this.callbacks = [];
    this.timer = null;
    this.paused = false;
    this.available = !!loadNative();
    this.error = nativeError;
  }

  start() {
    if (!this.available) return false;
    this.installGlobalHooks();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.refreshForeground(true);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const h of this.hooks) native.UnhookWinEvent(h);
    this.hooks = [];
    this.removeLocationHook();
    for (const cb of this.callbacks) {
      try { native.koffi.unregister(cb); } catch { /* already gone */ }
    }
    this.callbacks = [];
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (this.paused) {
      this.target = null;
      this.removeLocationHook();
      this.emit('target', null);
    } else {
      this.refreshForeground(true);
    }
  }

  registerCallback(fn) {
    const cb = native.koffi.register(fn, native.koffi.pointer(native.WinEventProc));
    this.callbacks.push(cb);
    return cb;
  }

  installGlobalHooks() {
    try {
      const onSystemEvent = this.registerCallback((hook, event, hwnd, idObject) => {
        try {
          if (event === EVENT_SYSTEM_FOREGROUND) this.refreshForeground(false, hwnd);
          else if (event === EVENT_SYSTEM_MINIMIZESTART || event === EVENT_SYSTEM_MINIMIZEEND) this.checkTarget();
          else if (event === EVENT_SYSTEM_MOVESIZESTART || event === EVENT_SYSTEM_MOVESIZEEND) this.checkTarget();
          else if (event === EVENT_OBJECT_DESTROY && idObject === OBJID_WINDOW && this.target && toNum(hwnd) === this.target.hwnd) {
            this.refreshForeground(true);
          }
        } catch (e) { this.emit('error', e); }
      });
      const flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
      const ranges = [
        [EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND],
        [EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND],
        [EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND],
        [EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY]
      ];
      for (const [min, max] of ranges) {
        const h = toNum(native.SetWinEventHook(min, max, 0, onSystemEvent, 0, 0, flags));
        if (h) this.hooks.push(h);
      }
      // Foreground changes to our own windows are skipped above, so watch them
      // separately for the own-focus signal.
      const own = toNum(native.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, onSystemEvent, this.ownPid, 0, WINEVENT_OUTOFCONTEXT));
      if (own) this.hooks.push(own);
    } catch (e) {
      this.emit('error', e);
    }
  }

  // Location/name events are very chatty system-wide, so they are only
  // hooked for the process that currently owns the tracked window.
  installLocationHook(pid) {
    this.removeLocationHook();
    if (!pid) return;
    try {
      if (!this.locationCallback) {
        this.locationCallback = this.registerCallback((hook, event, hwnd, idObject) => {
          try {
            if (!this.target || idObject !== OBJID_WINDOW || toNum(hwnd) !== this.target.hwnd) return;
            if (event === EVENT_OBJECT_LOCATIONCHANGE) this.checkTarget();
            else if (event === EVENT_OBJECT_NAMECHANGE) this.checkTitle();
          } catch (e) { this.emit('error', e); }
        });
      }
      this.locationHook = toNum(native.SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE, 0, this.locationCallback, pid, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
    } catch (e) {
      this.emit('error', e);
    }
  }

  removeLocationHook() {
    if (this.locationHook) native.UnhookWinEvent(this.locationHook);
    this.locationHook = 0;
  }

  poll() {
    if (this.paused) return;
    this.refreshForeground(false);
    this.checkTarget();
  }

  refreshForeground(force, hintHwnd) {
    if (this.paused) return;
    const fg = toNum(hintHwnd) || toNum(native.GetForegroundWindow());
    if (!fg) return;
    if (!force && fg === this.lastForeground) return;
    this.lastForeground = fg;

    const info = describeWindow(fg);
    if (!info) return;

    if (info.pid === this.ownPid) {
      if (!this.ownFocused) {
        this.ownFocused = true;
        this.emit('own-focus');
      }
      return;
    }
    this.ownFocused = false;

    const attachable = info.process && info.visible && !info.minimized
      && !SHELL_CLASSES.has(info.className)
      && !SHELL_PROCESSES.has(info.processKey)
      && info.bounds && info.bounds.width > 120 && info.bounds.height > 80
      && !this.isExcluded(info);

    if (!attachable) {
      if (this.target) {
        this.target = null;
        this.removeLocationHook();
      }
      this.emit('target', null);
      return;
    }

    const changed = !this.target || this.target.hwnd !== info.hwnd;
    const prevPid = this.target && this.target.windowPid;
    this.target = info;
    if (changed && prevPid !== info.windowPid) this.installLocationHook(info.windowPid);
    this.emit('target', info);
  }

  checkTarget() {
    const t = this.target;
    if (!t) return;
    if (!native.IsWindow(t.hwnd)) {
      this.target = null;
      this.removeLocationHook();
      this.emit('target', null);
      return;
    }
    const minimized = !!native.IsIconic(t.hwnd);
    if (minimized && !t.minimized) {
      t.minimized = true;
      this.emit('target-minimized', t);
      return;
    }
    if (!minimized && t.minimized) {
      t.minimized = false;
      t.bounds = windowBounds(t.hwnd);
      this.emit('target-bounds', t);
      return;
    }
    if (minimized) return;
    const b = windowBounds(t.hwnd);
    if (b && !sameBounds(b, t.bounds)) {
      t.bounds = b;
      t.maximized = !!native.IsZoomed(t.hwnd);
      this.emit('target-bounds', t);
    }
  }

  checkTitle() {
    const t = this.target;
    if (!t) return;
    const title = readWideString(native.GetWindowTextW, t.hwnd);
    if (title && title !== t.title) {
      t.title = title;
      this.emit('target-title', t);
    }
  }

  getTarget() { return this.target; }
}

// Bring a window to the foreground. Windows only lets the foreground process
// do this freely; when our hotkey handler is running we usually are allowed,
// and the Alt-key / AttachThreadInput fallback covers the rest.
function focusWindow(hwndLike) {
  if (!loadNative()) return false;
  const hwnd = toNum(hwndLike);
  if (!hwnd || !native.IsWindow(hwnd)) return false;
  if (native.IsIconic(hwnd)) native.ShowWindow(hwnd, SW_RESTORE);
  if (native.SetForegroundWindow(hwnd) && toNum(native.GetForegroundWindow()) === hwnd) return true;

  const fg = toNum(native.GetForegroundWindow());
  const fgThread = fg ? native.GetWindowThreadProcessId(fg, [0]) : 0;
  const ourThread = native.GetCurrentThreadId();
  let attached = false;
  try {
    if (fgThread && fgThread !== ourThread) attached = native.AttachThreadInput(ourThread, fgThread, true);
    native.keybd_event(VK_MENU, 0, 0, 0);
    native.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    native.BringWindowToTop(hwnd);
    native.SetForegroundWindow(hwnd);
  } finally {
    if (attached) native.AttachThreadInput(ourThread, fgThread, false);
  }
  return toNum(native.GetForegroundWindow()) === hwnd;
}

function hwndFromBrowserWindow(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function isLeftButtonDown() {
  if (!loadNative()) return false;
  return (native.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
}

function foregroundWindow() {
  if (!loadNative()) return 0;
  return toNum(native.GetForegroundWindow());
}

module.exports = {
  WindowTracker,
  describeWindow,
  focusWindow,
  foregroundWindow,
  hwndFromBrowserWindow,
  isLeftButtonDown,
  nativeAvailable: () => !!loadNative(),
  nativeError: () => nativeError
};
