# Agency Project Vault

Offline-first Windows desktop app for an agency's projects, website details, credentials/API keys,
documents, notes and links. No VPS, no cloud database, no login: install it and the Dashboard opens.

The full specification is in [docs/SPEC.md](docs/SPEC.md) (original: `docs/Agency_Project_Vault_Master_Plan.docx`).

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Electron + React + TypeScript skeleton, SQLite migrations, safe IPC, direct Dashboard, add project | done |
| 2 | Project edit/archive, encrypted credentials, documents, notes & links | done |
| 3 | Encrypted backup/restore, Windows installer | done |
| 4 | Optional LAN Team Mode (one host PC, two clients) | done |

## Install (Windows)

Each pull request's CI builds the installer: open the PR's **Checks → CI → Artifacts** and download
`AgencyProjectVault-Setup`. For a release, push a tag such as `v0.2.0`; the Release workflow attaches
`AgencyProjectVault-Setup-<version>.exe` to a GitHub Release.

The installer is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC": choose
**More info → Run anyway**. Installing per user needs no admin rights. Uninstalling keeps the vault data.

See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) for backups and [docs/TEAM_MODE.md](docs/TEAM_MODE.md) for sharing
one vault between PCs on the office network.

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
    ipc/            IPC handlers (sender check + zod validation) and the shared vault method table
    team/           LAN Team Mode: HTTPS host, pairing, pinned client, role config
    services/       projects, credentials, encryption, documents, notes/links, Vault
    db/             database open + versioned migrations
  renderer/         React UI (no Node, no fs, sandboxed)
  shared/           types, constants and zod schemas used by both sides
tests/unit/         vitest
docs/               specification
```

## Data location

`%APPDATA%\AgencyProjectVault\` holds `vault.sqlite`, `vault.key`, `files/`, `backups/`, `logs/` and `team/`
(Team Mode role, host certificate, joined-PC token).
Documents are stored as `files/<xx>/<uuid>.bin`; the original filename is kept only in the database.
Uninstalling the app does not delete this folder.

## Security baseline

- Renderer runs with `contextIsolation`, `sandbox` and no `nodeIntegration`; strict CSP; navigation away from the app is blocked.
- Every IPC call checks the sender frame and validates input with zod in the main process.
- Stored links must be `http(s)`; `javascript:`, `file:` and other schemes are rejected.
- DevTools are disabled in packaged builds.
- Credential usernames, passwords, API keys and extra fields are encrypted with AES-256-GCM (random nonce, AAD bound to
  the record and field). The vault key is generated on first run and protected with Windows DPAPI via Electron
  `safeStorage`. Settings shows whether OS key protection is active.
- The page never receives secrets in lists; Reveal fetches one field on click and auto-hides after 20 s or when the
  window loses focus. Copy happens in the main process and clears the clipboard after 30 s if unchanged (best effort).
- Edits carry a revision number; a stale edit is rejected with "changed since you opened it" instead of overwriting.
- Documents are chosen only through the native file picker (the page gets an opaque token, never a path), copied with
  a streamed SHA-256, size-capped at 50 MB, and verified against the hash on export. Only images and plain-text types are
  previewed in the app; executable types can be exported but never launched. Deletes are soft, so files can be recovered.

- Backups are a single `.apv` file: scrypt (N=2^17) derives the key from the passphrase, AES-256-GCM encrypts a gzip of
  the database snapshot, documents, vault key and a SHA-256 manifest. Restore decrypts into a staging folder,
  verifies everything, and only then swaps it in, keeping the previous vault in `backups/pre-restore-<date>/`.
- Team Mode (optional) serves the host's vault over HTTPS on the LAN only, with a pinned self-signed certificate,
  code-proven pairing (HMAC over the certificate fingerprint), approval on the host, and revocable per-device tokens.
  Joined PCs run the same validated vault operations remotely and never open the host's database file. See
  [docs/TEAM_MODE.md](docs/TEAM_MODE.md).
