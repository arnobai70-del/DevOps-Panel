# AGENCY PROJECT VAULT — LOCAL PC EDITION
## Desktop App | Offline-first | No VPS | PC Storage | 3 Developers

**Version:** 2.0 (revised specification)  
**Date:** 17 October 2026  
**Status:** Development blueprint; application has not been built  
**Target:** Windows 10/11 (64-bit); extend to macOS/Linux later if needed  
**Audience:** Agency's 3 developers

> **সিদ্ধান্ত:** এটি Web Portal নয়। এটি PC-তে install করা একটি সহজ **Desktop Software**। কোনো VPS, website hosting, online database, paid cloud কিংবা বাধ্যতামূলক Gmail login নেই। Install করে সরাসরি Dashboard খুলবে। Project, website details, credentials/API keys, documents, notes ও links—এই কাজগুলোই মূল scope।

---

## 1. এক নজরে: ঠিক কী বানাতে হবে

**Application name:** Agency Project Vault (পরিবর্তনযোগ্য)।

- `.exe` installer দিয়ে প্রত্যেক developer নিজের PC-তে app install করবেন।
- প্রথমবার app খুললেই সরাসরি **Dashboard**; login form, registration, email verification বা internet বাধ্যতামূলক নয়।
- **+ Add Project** দিয়ে যত খুশি project যোগ করা যাবে।
- প্রতিটি project-এ website/domain/hosting/link, login credentials, API keys, documents এবং notes রাখা যাবে।
- Documents-এ **Name, Purpose, Description, Category, Tags** এবং actual file থাকবে।
- ফাইলগুলো Windows PC-এর disk-এ থাকবে। কোনো remote server-এ স্বয়ংক্রিয়ভাবে যাবে না।
- ৩ জনই সব project দেখবেন; **Role, RBAC, client account, employee module নেই**।
- প্রয়োজন হলে একটি developer-এর PC-কে **Local Team Host** করে LAN-এর মাধ্যমে বাকি দুজনকে একই data দেখানো যাবে। আলাদা VPS লাগবে না।
- Google/Gmail sign-in ভবিষ্যতে optional feature হতে পারে; v1 চালাতে এর দরকার নেই।

### Must-have feature checklist

| Feature | Expected behavior |
|---|---|
| Direct Dashboard | Launch → Dashboard (no login). |
| Projects | Add, edit, archive, restore, search, filter. |
| Website details | Live site URL, admin URL, hosting/domain/provider, GitHub link, tech stack. |
| Secret Vault | Website logins, passwords, API keys, tokens, custom secret fields; hidden by default. |
| Documents | Upload, preview supported types, download/export, replace version, delete/restore. |
| Metadata | Mandatory document name & purpose; optional description and tags. |
| Notes & Links | Simple project-specific notes and URLs. |
| Backups | Create/restore encrypted portable backup, remind user of backup status. |
| Team mode | Optional LAN share: all 3 PC apps connect to data stored on ONE host PC. |

### Explicitly do NOT build

VPS, website, public web portal, payment processing, billing, CRM, employee attendance, Kanban, complex tasks, client portal, complicated permissions, mandatory login, cloud account, cloud sync, subscription, browser extension, password autofill, AI modules, external API integrations, public internet endpoint.

---

## 2. সবচেয়ে গুরুত্বপূর্ণ বিষয়: তিনটি PC এবং একই ডেটা

**ফ্যাক্ট:** শুধু ৩টি PC-তে একই software install করলেই একই data তিনটি PC-তে নিজে থেকে দেখা যাবে না। যদি PC-A-তে file রাখা হয়, PC-B সেটি দেখতে হলে data transfer/shared storage/network connection লাগবে।

### Mode A — Personal Local (default; zero setup)

```text
PC-A: Agency Vault App → PC-A storage (projects + files)
PC-B: Agency Vault App → PC-B storage (separate)
PC-C: Agency Vault App → PC-C storage (separate)
```

- Install করেই ব্যবহার করা যাবে, 100% offline।
- প্রতিটি PC-র data **আলাদা** থাকবে; shared/team view হবে না।
- Demo, personal usage বা LAN unavailable হলে উপযোগী।

### Mode B — Shared Team Vault (recommended for 3 developers)

```text
                 OFFICE Wi-Fi / LAN (private network)
   Developer PC-B ─────────┐
                          │
   Developer PC-C ─────────┼──> PC-A: App + Local Team Host
                          │        │
   Developer PC-A ─────────┘        ├── vault.sqlite (local file)
                                   ├── encrypted document files
                                   └── local backups
```

- **PC-A-ই host**; এখানে data physically থাকবে। PC-B/C-তে কেবল একই installed application থাকবে।
- Host PC-তে app-এর **Enable Team Sharing** চালু করে একটি pairing code/QR তৈরি করা হবে। PC-B/C-তে **Join Team Vault** → pair; এরপর সবার project একই হবে।
- ৩ জনই সব projects, credentials, notes এবং documents add/edit/view করতে পারবেন। আলাদা project permission নেই।
- PC-A on থাকতে হবে, এবং তিনটি PC একই trusted LAN/Wi-Fi-এ থাকতে হবে। PC-A বন্ধ/offline হলে অন্য PC-তে shared data available হবে না।
- Shared mode-এ client PC-B/C সরাসরি SQLite file খুলবে **না**; host PC একটি authenticated local-only service-এর মাধ্যমে data দেবে। এতে file corruption/conflict কমবে।
- **ইন্টারনেট লাগে না**, তবে LAN লাগে। Router বা private hotspot যথেষ্ট।
- বাইরে থেকে একই data দেখতে চাইলে পরবর্তীতে **VPN** বা আলাদা sync design প্রয়োজন; app-এর প্রথম version-এ রাখার দরকার নেই।

**Product decision:** Installer একই থাকবে। Dashboard default direct open হবে। Settings থেকে Personal Local ↔ Shared Team Vault বেছে নেওয়া যাবে। প্রথম release-এ Team Mode প্রয়োজন হলে সেটি সম্পূর্ণ test করেই release করতে হবে; অর্ধেক implementation নয়।

---

## 3. User Experience: যতটা সম্ভব সহজ

### First run

1. User `AgencyProjectVault-Setup.exe` চালাবেন; normal Windows installer।
2. Shortcut তৈরি হবে; software launch।
3. **সরাসরি Dashboard**: project না থাকলে “No projects yet” এবং বড় `+ Add Project` button।
4. Team vault দরকার হলে শুধু Settings → Team Sharing → **Host / Join**।
5. Optional theme, data folder এবং backup folder নির্বাচন করা যাবে।

### Dashboard layout

```text
┌─────────────────────────────────────────────────────────┐
│ Agency Project Vault      Search...      + Add Project   │
├───────────────┬─────────────────────────────────────────┤
│ Dashboard     │  All Projects   [Grid] [List]          │
│ Projects      │                                         │
│ Documents     │  [Project 01]  [Project 02]  [+ Add]   │
│ Credentials   │                                         │
│ Settings      │  Recently Updated / Backup status       │
└───────────────┴─────────────────────────────────────────┘
```

UI: clean dark/light theme, large readable buttons, responsive window sizes, drag-and-drop documents, keyboard search (`Ctrl+K` optional), loading/progress/error/empty states। No unnecessary animations or modules।

### Project detail tabs

`Overview | Credentials | Documents | Notes & Links`

- **Overview:** project name, status, website, domain, host, tech stack, short description, important links।
- **Credentials:** card/list by service; username/password/API key; Save, Copy, Reveal, Edit, Delete।
- **Documents:** filename, display name, purpose, category, date, file size; Upload/Preview/Export/Edit/Delete।
- **Notes & Links:** plain text/Markdown notes; clickable URLs।

---

## 4. Screen forms এবং Validation

### 4.1 Add/Edit Project

| Field | Required | Examples / rule |
|---|---|---|
| Project name | Yes | `New Singapur Telecom`, 1–150 chars |
| Description | No | short summary |
| Project type | No | Website / Software / Mobile / Other |
| Status | No | Active / Paused / Completed / Archived |
| Live website URL | No | `https://example.com` |
| Admin URL | No | WordPress / custom admin panel URL |
| Domain provider / Hosting | No | provider name; **password এখানে নয়** |
| Repository URL | No | GitHub URL |
| Tech stack / tags | No | `Laravel`, `React` |
| Developer name | No | purely informational, access restriction নয় |

### 4.2 Add/Edit Credential

| Field | Required | Examples / handling |
|---|---|---|
| Project | Yes | connected project |
| Service name | Yes | Website Admin / Cloudflare / Affiliate |
| Service URL | No | login page |
| Username / email | No | can be sensitive; encrypted in storage |
| Password | No | encrypted at rest, masked by default |
| API key / API secret | No | named secret fields, encrypted |
| Extra fields | No | label + plain/secret value |
| Purpose / notes | No | why this login exists; do not paste secrets into notes |

- **Reveal** and **Copy** buttons require explicit click; no plaintext on project cards.
- When a secret is shown, auto-hide after short timeout/window focus loss where feasible.
- Search only service name and tags; **never index plaintext passwords/keys**.
- Clipboard content can persist in other applications; do not claim guaranteed auto-clear.

### 4.3 Upload/Edit Document

| Field | Required | Meaning |
|---|---|---|
| Project | Yes | which project it belongs to |
| Document name | Yes | descriptive display title |
| Purpose | Yes | কেন এই ডকুমেন্ট রাখা হচ্ছে |
| Description | No | use instructions / context |
| Category | No | Requirement / Design / Legal / Config / Others |
| File | Yes | PDF, DOCX, XLSX, TXT, PNG, JPG, ZIP etc. |
| Tags | No | searchable terms |
| Version | Auto/No | default v1, new upload may increment |

- Originals stored under app-controlled folder with generated UUID filenames (to prevent overwrite/path traversal), original filename shown only in UI।
- Preview only supported safe formats. Unknown/unsafe types: export/open with OS confirmation; do not execute embedded content in app renderer।
- Configurable file size cap: default **50 MB per file**; large uploads can be supported later via streaming।
- Display `Name`, `Purpose`, `Size`, `Version`, `Added/Updated`, `Actions`।
- User may export/copy original file back out anytime।

### 4.4 Notes and Links

- Note title + text; autosave debounced safely or explicit Save; clear unsaved indicator।
- Links: label, validated `http/https` URL, short purpose।
- Avoid opening arbitrary protocols (`javascript:`, `file:`, `powershell:`) from records।

---

## 5. Technical Architecture (No VPS)

**Recommended stack:** **Electron + React + TypeScript + SQLite (embedded) + Node.js main-process file APIs**. This makes a familiar Windows `.exe` app; end users do NOT need to install Node.js or database software separately.

```text
┌──────────────────── Windows Desktop App ─────────────────┐
│ React Renderer (Dashboard, Projects, Forms)              │
│                │  safe IPC via preload API               │
│ Electron Main Process                                    │
│ ├─ Project Service                                       │
│ ├─ Credential/Encryption Service                         │
│ ├─ Document Service (filesystem)                         │
│ ├─ SQLite Repository (one local .sqlite file)            │
│ ├─ Backup/Restore Service                                │
│ └─ OPTIONAL Team Host Service (private LAN only)         │
└───────────────┬───────────────────────────────────────────┘
                │
         Windows PC Disk
         ├── vault.sqlite
         ├── files/ (documents)
         ├── backups/
         └── logs/ (redacted errors only)
```

### “Database” আসলে কী?

`SQLite` হলো software-এর ডেটা সাজিয়ে রাখার **একটি local file**, online database/server নয়। Project name, document purpose, filename, relation, search index রাখতে সাহায্য করে। Documents actual files হিসেবে disk-এ থাকবে; database-এ বিশাল PDF ঢোকাতে হবে না। User-কে database install/configure করতে হবে না।

JSON files দিয়ে single-PC prototype করা সম্ভব, কিন্তু atomic update, relationship, search, data corruption recovery এবং simultaneous changes-এর জন্য embedded SQLite বেশি নির্ভরযোগ্য। **কোনো MySQL/PostgreSQL server নয়**।

### Electron Security Rules

- Renderer: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- Only typed, allowlisted methods via `contextBridge` preload; never expose raw filesystem or arbitrary command IPC.
- Electron app loads packaged local UI, not remote website; restrictive CSP, no arbitrary navigation or remote code.
- Validate all IPC inputs via schema (`zod`) plus service-level checks; guard paths and file sizes.
- Keep all secrets, encryption keys and SQLite/file operations in main process; never renderer localStorage.
- Disable developer tools in production builds unless support explicitly enabled, with no secret logging.

---

## 6. Local Data Folder এবং File Structure

**Default Windows location (per OS user):** `%APPDATA%\\AgencyProjectVault` বা Electron `app.getPath('userData')`। Settings-এ storage location দেখাবে; data folder move-এর জন্য guided migration থাকবে। Install directory (`Program Files`) data storage হিসেবে ব্যবহার করা যাবে না।

```text
AgencyProjectVault/
  vault.sqlite                 # structured local metadata
  files/
    ab/abcdef...bin            # managed attachment (encrypted if vault key configured)
    6c/6c89...bin
  thumbnails/                  # disposable previews only
  backups/
    backup-YYYY-MM-DD.apv      # encrypted portable backup
  config.json                  # non-secret preferences
  logs/                        # minimal, never record passwords or API tokens
```

**Important:** `%APPDATA%` user-profile folder-এর ভিতর। Disk C: বা অন্য location নির্বাচন করা যায়; installer-এর সাথে data delete হবে না। Portable backup-এর মাধ্যমে অন্য PC-তে data restore করা যাবে।

**Encryption:** credential fields should always be encrypted; optionally encrypt attachments. For a single Windows user, machine/user-protected key storage (Windows DPAPI) can protect at rest. Portable backup/transfer MUST use an independent recovery passphrase because DPAPI-only keys cannot be restored on another machine. Team host holds the shared vault data/key; clients use authenticated encrypted LAN transport. See §9.

---

## 7. Local SQLite Schema (suggested minimum)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT, status TEXT NOT NULL DEFAULT 'active',
  website_url TEXT, admin_url TEXT, hosting_name TEXT,
  domain_provider TEXT, repository_url TEXT,
  tech_stack_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  service_name TEXT NOT NULL, service_url TEXT,
  username_cipher BLOB, secrets_cipher BLOB,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL, purpose TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', category TEXT,
  original_filename TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT, file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL, url TEXT NOT NULL, purpose TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_credentials_project ON credentials(project_id);
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_projects_name ON projects(name);
```

**Notes:** `secrets_cipher` = versioned AES-GCM ciphertext bundle (`nonce + tag + ciphertext + key_version`) of named fields. Never put plaintext API keys in SQLite. Use parameterized queries and transactions. v1 can store document tags/version history in additional tables as necessary. Never place a live SQLite database on a shared network drive or sync it file-by-file while being written; use the Team Host service instead.

---

## 8. Functions, IPC and Internal Service Contracts

Renderer code does not call `fs` or SQLite directly. It calls narrow, typed `window.vault` methods.

```ts
interface VaultAPI {
  projects: {
    list(query?: string): Promise<ProjectSummary[]>;
    create(input: ProjectInput): Promise<Project>;
    update(id: string, patch: ProjectPatch, revision: number): Promise<Project>;
    archive(id: string): Promise<void>;
  };
  credentials: {
    list(projectId: string): Promise<CredentialSummary[]>;
    save(input: CredentialInput): Promise<void>;
    reveal(id: string, field: string): Promise<string>;
    remove(id: string): Promise<void>;
  };
  documents: {
    list(projectId: string): Promise<DocumentSummary[]>;
    importFile(projectId: string, metadata: DocumentMetadata): Promise<DocumentSummary>;
    exportFile(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  notes: { list(projectId: string): Promise<Note[]>; save(input: NoteInput): Promise<void> };
  backups: { create(): Promise<BackupResult>; restore(): Promise<RestoreResult> };
  team: { enableHost(): Promise<PairingInfo>; join(code: string): Promise<void> };
}
```

- `importFile` opens native OS file picker; renderer must not supply an unrestricted filesystem path.
- `exportFile` uses native Save dialog and writes outside the managed folder only with user confirmation.
- All write actions validate input, create audit-free (or minimal) timestamp/revision metadata, commit atomically.
- Team mode implements equivalent actions through host-validated LAN protocol; UI functions stay identical.
- No public REST API or externally accessible web service needed.

---

## 9. Security (simple UI, real protection)

No login means anyone using an unlocked Windows session can open the app. **This is an intentional tradeoff**, not a security guarantee. Sensitive logins/API keys must still be protected at rest and shown only on click.

### Minimum rules

1. Windows user account and disk encryption (BitLocker where available) recommended.
2. Encrypt stored credential secret values with **AES-256-GCM**, unique random nonce per encryption; store a versioned encrypted blob. Never invent custom cryptography.
3. Use Windows DPAPI to protect local key at rest; provide **portable recovery-passphrase encrypted backup** for cross-PC restoration.
4. Optional `Lock Secrets` setting with a local vault PIN/passphrase if developers want an extra barrier (not required for direct dashboard).
5. Never log passwords, tokens, file contents, clipboard data or decrypted keys.
6. Never open untrusted documents inside Electron privileged renderer. Use safe image/PDF preview implementation; export others for external programs.
7. Protect against path traversal (`../`), symbolic-link escapes, overwrites, ZIP bombs and unsafe extension execution.
8. **Team mode:** host pairing requires short-lived code, user-approved devices, TLS with certificate pinning, random device credentials, revocation in host settings, and firewall limited to **Private network/LAN**. No port forwarding or open internet exposure.
9. Team mode operates with equal access for all paired developers, by design. New PC pairing needs host approval.
10. Backups are encrypted; backup encryption key and recovery instructions must be saved separately. An encrypted backup without its passphrase cannot be restored.

**Do not store a Gmail/Google access token by default.** Google sign-in is unnecessary for direct dashboard. If added later, make it opt-in with documented internet/OAuth dependency.

---

## 10. Main Workflows

### Add project

Dashboard → `+ Add Project` → Name (+ optional details) → Save → Project page → Add Credentials / Documents / Notes.

### Save secret

Project → Credentials → Add → service + username/secret → Encrypt → Save → masked list → click Reveal/Copy when needed.

### Save document

Project → Documents → `+ Upload` → choose file → Document Name + Purpose (required) → description optional → Save → file written to managed PC folder + metadata committed → view/export later.

**Atomicity:** write temporary file first, compute hash, rename to final storage path, commit DB metadata; on any failure clean temporary file. Run orphan-file cleanup on next launch. Handle disk-full and interrupted copy gracefully.

### Backup

Settings → Backup Now → consistent SQLite snapshot + managed document files + manifest + checksums → one encrypted `.apv` archive → Save dialog → user selects drive/USB/location. Automatic local backup can run on app close/daily use, with bounded retention and explicit free-space checks.

### Restore

Settings → Restore → choose `.apv` → enter backup recovery passphrase → verify integrity/version → create pre-restore safety copy → import atomically → show restored projects/files count. Reject corrupt or unsupported backup gracefully. Prefer restore into empty/new vault rather than overwrite without confirmation.

### Team join

On PC-A: Settings → Enable Team Sharing → Show short pairing code. On PC-B/C: Settings → Join Team Vault → enter code; host approves devices → both clients immediately show host's projects. When host unavailable, show `Team Vault offline`, not silently divergent copies.

---

## 11. Sharing Conflict and Data Consistency

- Team host is **single writer for shared vault**, transactions serialized by SQLite; client devices never edit database directly.
- Add integer `revision` or server-side updated version to mutable records. Edits include expected revision; if stale, show “This item changed. Reload/Compare” instead of silently overwriting.
- Documents are content-addressed or UUID-path files; concurrent upload gets a new object, never corrupts an existing file.
- Interrupted transfer retries; verify SHA-256 after upload; present useful error messages.
- Deleted items are soft-deleted for 30 days if feasible; archiving hides project but keeps files/credentials intact.
- Offline clients cannot modify shared data unless a robust, separately specified conflict-resolution sync feature is built. v1: **no offline editing of shared vault**.

---

## 12. Project Repository / Folder Layout

```text
agency-project-vault/
  README.md
  package.json
  electron-builder.yml
  tsconfig.json
  src/
    renderer/
      app/
      pages/Dashboard.tsx
      pages/Projects.tsx
      pages/ProjectDetail.tsx
      pages/Documents.tsx
      pages/Settings.tsx
      components/ProjectCard.tsx
      components/CredentialForm.tsx
      components/DocumentForm.tsx
    main/
      index.ts              # Electron app lifecycle/windows
      preload.ts            # narrow, safe IPC bridge
      ipc/handlers.ts
      services/projects.ts
      services/credentials.ts
      services/documents.ts
      services/backup.ts
      services/encryption.ts
      services/team-host.ts # optional local LAN service
      db/schema.sql
      db/migrations/
      db/repository.ts
      security/validation.ts
    shared/
      types.ts
      schemas.ts
  tests/
    unit/
    integration/
    e2e/
  scripts/
    package-win.ps1
```

Use migrations and compatible backup versions; don't wipe existing data during app updates. `app.getPath('userData')` chooses writable user data directory. Releases should be signed if possible to reduce SmartScreen warnings.

---

## 13. Implementation Phases

### Phase 1 — working offline app (highest priority)

1. Electron + React + TypeScript setup; Windows installer.
2. First launch direct dashboard; no login.
3. SQLite initialization/migrations in PC local folder.
4. Add/edit/search/archive projects.
5. Credentials with encryption and masked reveal/copy.
6. Upload/preview/export documents with Name/Purpose/Description.
7. Notes, links, data integrity and basic error states.
8. Backup/restore portable encrypted archive.
9. Windows install/uninstall/update test; preserve files.

### Phase 2 — 3 developer shared LAN mode (if everyone needs identical data)

1. Local Team Host service (inside same software).
2. Pairing/approval/revocation; secure transport.
3. Clients reuse same typed operations via LAN.
4. Optimistic concurrency, file transfer, disconnect/reconnect behavior.
5. Simultaneous edits/upload tests from 3 PCs.
6. Host backup and disaster recovery tests.

### Phase 3 — polish only

Improve search, drag/drop, keyboard shortcuts, theme, installer icon, smooth update/migration, accessibility. No enterprise features unless explicitly requested.

---

## 14. QA / Test Acceptance Checklist

### Functional

- [ ] Windows installer launches successfully on a clean PC without a database runtime or Node.js install.
- [ ] First launch opens Dashboard immediately, **no account/sign-in**.
- [ ] Create 50 sample projects, find by search, edit, archive and restore.
- [ ] Save a website username/password/API key; DB file does not contain any plaintext secret.
- [ ] Password masked on list; Reveal and Copy function correctly.
- [ ] Store PDF/DOCX/XLSX/PNG/ZIP with mandatory Name and Purpose, optional Description.
- [ ] Exported document hash matches original file.
- [ ] Deleting a project does not silently delete protected files; recovery is understood.
- [ ] Disk-full, large/invalid file, duplicate names and app kill mid-write handled without corrupt data.
- [ ] Backup on PC-A restores to PC-D/clean Windows profile with portable key/passphrase.
- [ ] App reinstall/update retains existing vault data.

### Optional LAN team sharing

- [ ] One PC hosts; two other PCs join using pairing and get same projects/files.
- [ ] All 3 can add/edit/view every project; no role restrictions.
- [ ] Simultaneous editing shows conflict instead of data loss.
- [ ] Host shutdown shows offline state; reconnect recovers.
- [ ] Devices not paired cannot query host; revocation works.
- [ ] No public internet port; Private LAN firewall rules only.

### Security

- [ ] Credentials are encrypted at rest; backup encrypted.
- [ ] No raw secrets in debug logs, renderer localStorage or crash report.
- [ ] Path traversal, unsafe URL scheme, unexpected IPC payload are rejected.
- [ ] Native file dialogs and previews do not allow arbitrary code execution.
- [ ] Backup restore refuses bad password/damaged archive and leaves current data intact.

**Release gate:** mark v1 done only after functional tests pass, a real backup→restore rehearsal succeeds and no critical security defect remains.

---

## 15. No-VPS Deployment and Operating Guide

1. Developer builds signed (if available) Windows installer: `npm ci` → `npm run build` → `npm run dist:win` (exact scripts to define in `package.json`).
2. Distribute installer privately via USB/shared folder or GitHub Releases; signing is recommended.
3. Each developer installs app; it starts from desktop shortcut directly to Dashboard.
4. Local mode: ready immediately. Team mode: choose one reliable PC as Host; two others join it by LAN pairing.
5. Confirm configured Data Folder in Settings. Ensure disk has space for future documents.
6. Run encrypted backup before upgrades and regularly; keep a copy off the host disk (USB/external drive).
7. Use versioned schema migrations, preserve old data and rollback if migration fails.
8. Uninstall app does **not** auto-delete user vault data; clear data only by separate explicit action.

### Cost breakdown

- VPS/server rent: **0**.
- Hosting/domain/subscription: **0** for this product.
- Required external DB: **0**.
- Needed: Windows PCs, disk space, app development effort; LAN/router only if shared Team Mode.
- Optional: code-signing certificate, external drive for safer backup.

---

## 16. Final Developer Instructions / Non-Negotiables

1. Build a real installable **desktop app**, not a website.
2. **No VPS, no required internet, no required Gmail login**.
3. Launch directly to Dashboard; `+ Add Project` prominent.
4. Project information, credentials, API keys, documents, purposes/descriptions, notes and links are the entire v1 scope.
5. Save in **PC disk** using embedded SQLite + managed files. This is not an external DB service.
6. 3 developers have equal access. If they need one shared vault, implement **LAN host on one PC**; do not pretend installations auto-sync.
7. Credential encryption and encrypted portable backup are mandatory despite simplified login.
8. No data-loss shortcuts: atomic writes, migrations, tested restore, conflict handling.
9. Keep app small/simple, no unnecessary modules.
10. Deliver source code, Windows installer, README, sample tests and backup-restore guide.

### One sentence for a coding AI

> Build “Agency Project Vault” as a polished, minimal, offline-first Windows desktop application using Electron + React + TypeScript with local embedded SQLite and PC filesystem storage. Open Dashboard without login; support unlimited projects, secure credential/API-key vault, purpose-labeled documents, notes and links, encrypted backups, and optional three-PC shared LAN mode hosted by one developer's PC. Do not use a VPS, cloud database, website portal or unnecessary enterprise modules. Implement, test, package and document end to end.

---

**Version 2 correction:** This document **replaces** the previous VPS/web-portal-oriented architecture. This is an implementation specification; no installer or application is claimed to exist yet.
