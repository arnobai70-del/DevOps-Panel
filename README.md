# Agency Project Vault

Offline-first Windows desktop app for an agency's projects, website details, credentials/API keys,
documents, notes and links. No VPS, no cloud database, no login: install it and the Dashboard opens.

The full specification is in [docs/SPEC.md](docs/SPEC.md) (original: `docs/Agency_Project_Vault_Master_Plan.docx`).

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Electron + React + TypeScript skeleton, SQLite migrations, safe IPC, direct Dashboard, add project | done |
| 2 | Project edit/archive, encrypted credentials, documents, notes & links | planned |
| 3 | Encrypted backup/restore, Windows installer | planned |
| 4 | Optional LAN Team Mode (one host PC, two clients) | planned |

## Development

Requires Node.js 22+.

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests (SQLite in memory)
npm run typecheck
npm run build      # bundle main, preload and renderer into out/
npm run dist:win   # Windows NSIS installer into dist/ (run on Windows)
```

## Layout

```text
src/
  main/             Electron main process: owns SQLite, files and all secrets
    index.ts        app lifecycle, hardened BrowserWindow
    preload.ts      the only bridge: a narrow, typed window.vault API
    ipc/            IPC handlers (sender check + zod validation)
    services/       ProjectService, Vault
    db/             database open + versioned migrations
  renderer/         React UI (no Node, no fs, sandboxed)
  shared/           types, constants and zod schemas used by both sides
tests/unit/         vitest
docs/               specification
```

## Data location

`%APPDATA%\AgencyProjectVault\` holds `vault.sqlite`, `files/`, `backups/` and `logs/`.
Uninstalling the app does not delete this folder.

## Security baseline

- Renderer runs with `contextIsolation`, `sandbox` and no `nodeIntegration`; strict CSP; navigation away from the app is blocked.
- Every IPC call checks the sender frame and validates input with zod in the main process.
- Stored links must be `http(s)`; `javascript:`, `file:` and other schemes are rejected.
- DevTools are disabled in packaged builds.
