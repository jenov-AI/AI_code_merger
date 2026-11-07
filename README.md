# JSON Merge Studio

A minimalist Electron app for exploring a workspace, viewing files in a tabbed code viewer (ACE editor) and merging two JSON arrays by one or more configurable main keys.

## Getting started

1. npm install
2. npm start

## Workflow

- First launch: pick a workspace folder. It is stored in settings and listed under recent workspaces next time (entries whose folder no longer exists are cleaned up automatically).
- Check two .json files in the explorer (maximum two; the remaining checkboxes are disabled while two are checked). When the second file is checked, a merge dialog opens where you choose which file is the main (old) one, the main keys to compare, and whether to overwrite the main file.
- You can add multiple main keys (for example filename + location). An object from the new file only replaces an object from the old file when ALL key values match. If any key differs (same filename but different location), the object is kept/added as a separate entry instead of overwriting.
- If overwrite is off, a new file is created next to the main file: name_merged.json, name_merged (1).json, name_merged (2).json... depending on conflicts. If overwrite is on, the main file is replaced atomically (temp file + rename).
- Double-click any file to open it in a read-only tab (VS Code style tabs, closable).
- The explorer refreshes automatically every 3 seconds. Polling is async, guarded against overlapping runs and skipped while the window is hidden.
- The sun/moon button in the top bar toggles dark/light theme. Theme, current workspace and recents are persisted.

## Project structure

- main.js - Electron main process: settings store, strict I/O validation, merge logic
- preload.js - IPC bridge (contextIsolation on, nodeIntegration off, sandbox on)
- src/renderer/ - UI (HTML + CSS + vanilla JS, ACE editor loaded from cdnjs)

## Validation notes

- Every file path coming from the UI is resolved and verified to stay inside the workspace (path traversal protection).
- JSON files must contain a root array of objects and every object must contain ALL the main keys, otherwise the merge fails with a descriptive error.
- Composite key comparison is type-aware: the number 1 and the string 1 are treated as different values.
- New merged files are written with the wx flag, so an existing file can never be overwritten by accident; conflicts increment a numeric suffix.
- Symlinks are skipped in the explorer to avoid infinite loops; tree size and depth are capped for very large workspaces.
- If the ACE CDN is unreachable, files fall back to a plain text viewer.
- Settings are stored in the OS user data folder as settings.json.
