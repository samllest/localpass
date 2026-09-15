# LocalPass

LocalPass is a Windows-first Electron password manager with an encrypted local vault and a Chrome extension for login capture and optional account selection autofill.

## Features

- AES-256-GCM encryption for stored passwords; the vault key is derived from the master password with scrypt.
- Multiple accounts for the same website identity.
- Version history for password updates.
- Chrome extension login capture through the localhost bridge.
- Chrome extension account picker that fills the selected username and password.

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

The packaged application is independently deployable. It stores vault databases under Electron's user data directory in `databases/`.

## Chrome extension

1. Start LocalPass and unlock the vault.
2. Open `chrome://extensions`, enable Developer mode, and choose Load unpacked.
3. Select the `chrome-extension/` directory.
4. Open a login page. When saved credentials exist for the hostname, choose an account from the LocalPass picker to fill the form.
5. After a successful login submission, the extension sends the captured username and password to the LocalPass localhost bridge.

The bridge listens only on `127.0.0.1:35320`. It rejects capture and lookup requests while the vault is locked.

## Database

The runtime initializes the schema from the logic in `src/main/db.js`. The equivalent safe initialization SQL is in `database/init.sql`. It creates the apps and credential version tables and does not contain any real credentials.

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
