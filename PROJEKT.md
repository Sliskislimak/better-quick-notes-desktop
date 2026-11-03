# Quick Notes Desktop — inspiracja i założenia

## Inspiracja

UI/UX i sposób pracy z notatkami pochodzą z rozszerzenia Chrome **[Quick Notes](https://github.com/quicknotes/quick-notes)** ([@mthcht](https://github.com/mthcht)). Ten projekt to **samodzielna aplikacja Windows (Electron)**, a nie fork rozszerzenia — przenosi ten sam wygląd i edytor na natywne okna aplikacji (`.exe`), z vaultem Obsidian i opcjonalnym Google Drive.

Powiązany fork rozszerzenia (Chrome + vault/Drive): [Sliskislimak/better-quick-notes](https://github.com/Sliskislimak/better-quick-notes).

## Założenia

1. **Parzystość wizualna z Quick Notes** — motywy, kształty panelu, pasek narzędzi, stos notatek na aplikację, tagi, podgląd Markdown, split, wyszukiwanie, historia; skróty edytora jak w rozszerzeniu (`Ctrl+B/I/U`, `Ctrl+Shift+X/L` itd.).
2. **Przypięcie do procesu Windows** — notatka wiąże się z `process` (np. `Code.exe`), nie z URL; śledzenie HWND, granic i minimalizacji (Win32 przez `koffi`).
3. **Stany okna** — rozwinięty panel, zwinięty pasek u góry docelowego okna, pasek w stanie idle (niska przezroczystość), daemon w zasobniku.
4. **Globalne skróty** — `Alt+Shift+Q`, `Alt+Shift+W`, `Alt+Shift+A` (konfigurowalne w Ustawieniach).
5. **Markdown + vault** — zapis `${title}_${id6}.md` z YAML (`title`, `app_name`, `process`, daty, tagi `quicknotes` + `desktop-app`); chokidar dla edycji z Obsidian.
6. **Google Drive (opcjonalnie)** — OAuth aplikacji desktopowej, folder ID, PATCH bez duplikatów; tokeny w `safeStorage`.
7. **Lokalnie, bez telemetrii** — stan w `%APPDATA%`; sync tylko na życzenie użytkownika.
8. **Windows 10/11 x64** — Electron 40+, Node 22 LTS, `electron-builder` (NSIS + portable).

Szczegóły instalacji: [README.md](README.md).
