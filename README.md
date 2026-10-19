# LocalPass

LocalPass is a Windows-first Electron password manager with an encrypted local vault and a Chrome extension for login capture and optional account selection autofill.

## Features

- AES-256-GCM encryption for stored passwords; the vault key is derived from the master password with scrypt.
- Multiple accounts for the same website identity.
- Version history for password updates.
- Chrome extension login capture through the localhost bridge.
- Chrome extension account picker that fills the selected username and password.
- Chrome-inspired three-column workspace with a persistent website list and account details, plus password checkup and settings. Narrow windows switch between the list and details.
- Website names, browser tab titles, cached local favicons, and complete addresses with ports.
- Search by website, display name, tab title, port, or username; group multiple accounts and sort by name or latest update.
- Local checks for reused and weak passwords, with links to affected accounts (no online breach check).
- Cryptographically generated passwords, masked version history, and confirmed individual or batch deletion.
- Light, dark, and system themes; keyboard search with Ctrl/Cmd+K and accessible dialogs.
- Encrypted vault backup import/export. Backups currently require the original vault's encryption key.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Build the production renderer and main process:

```bash
npm run build
```

Build a Windows installer:

```bash
npm run build:win
```

To share the desktop app with other people, run `npm run package:distribution` after building. Deploy the resulting download bundle to WSL with `deploy/wsl/deploy.sh`. See [WSL 发布说明](docs/WSL发布说明.md) for commands, installation steps and data locations. WSL serves downloads only; each person installs the desktop app and keeps a separate local vault.

The packaged application is independently deployable. It stores vault databases under Electron's user data directory in `databases/`.

## Chrome extension

1. Start LocalPass and unlock the vault.
2. Open `chrome://extensions`, enable Developer mode, and choose Load unpacked.
3. Select the `chrome-extension/` directory.
4. Open a login page. When saved credentials exist for the host and port, choose an account from the LocalPass picker to fill the form.
5. After a successful login submission, the extension sends the captured username and password to the LocalPass localhost bridge.

The bridge listens only on `127.0.0.1:35320`. It rejects capture and lookup requests while the vault is locked.

The account picker opens only when a login username or password field is focused or clicked. Selecting an account, leaving the field, pressing Escape, submitting the login, or navigating away closes it. Page mutations never reopen it, and stale lookup responses are ignored.

After changing extension code, reload LocalPass in `chrome://extensions` and refresh the website tab. Restarting the desktop app alone does not update scripts already injected into a tab.

The extension also recognizes SPA logins backed by another API origin or port: after an explicit login attempt, a same-site route change with the login fields gone and no visible login error confirms the capture. Credentials stay associated with the website's host and port, not the API server. Unrelated cross-origin POST requests alone never trigger saving.

Traditional form logins such as Jenkins are supported across full-page POST/302 redirects. The extension waits for the destination document to report that the login fields and visible login errors are absent before saving; a destination that still shows a login form or error cancels the capture. Reload extension version 1.2.0 or newer and refresh the login page to use this behavior.

Run the extension regression checks with `npm run test:extension`. They use the project's Electron in a hidden window with a temporary profile, a local fixture page, and simulated account responses; no real vault or browser profile is accessed.

## Database

The runtime initializes the schema from the logic in `src/main/db.js`. The equivalent safe initialization SQL is in `database/init.sql`. It creates the apps and credential version tables and does not contain any real credentials.

Settings shows the signed-in account and the current SQLite file, with an action to reveal it in Explorer. Development builds store databases in `.localpass-data/databases/` inside the project, outside Vite's output folder and redirected AppData. This directory is excluded from Git; keep it when replacing a project checkout. On first use, existing accounts and available vaults are copied from the previous AppData directory using consistent SQLite snapshots; the originals are retained and missing vaults are never replaced with blank files. Packaged Windows builds continue to use `%APPDATA%/localpass/databases/`. Keep `system.db` (the account catalog) together with the account's `user_*.db` file. Export an encrypted backup from Settings before moving data between environments. Login requires an existing, valid vault and never silently creates a replacement when its file is missing. Only registration creates new vaults.

## Project layout

- `src/main/`: Electron main process, encrypted database access, authentication, and localhost bridge.
- `src/preload/`: context-isolated IPC API exposed to the renderer.
- `src/renderer/`: Vue user interface for the vault.
- `chrome-extension/`: Chrome Manifest V3 content script and background service worker.
- `native-messaging/`: optional native messaging host integration.
- `database/init.sql`: reproducible database schema.
- `NOFX_QUEST.md`: NOFX Developer Quest project identifier.

## Security notes

- Never commit `.env`, API keys, passwords, or real vault database files.
- `.env.example` contains only development variable names.
- Clipboard contents are cleared after 30 seconds when they still contain a copied password.
- Extension credentials are requested only from the local bridge after the vault has been unlocked.
