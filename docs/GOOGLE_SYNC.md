# Team sync with a Google sign-in

## সংক্ষেপে (বাংলা)

1. প্রথমবার app খুললে শুধু **Sign in with Google** আসে। যে Gmail-এর Google Drive-এ টিমের ডেটা থাকবে, সেটা দিয়ে sign in করুন।
2. অন্য প্রতিটা PC-তেও একই Gmail দিয়ে sign in করুন। ফোল্ডার বাছাই, team passphrase, Google Drive for desktop, কিছুই লাগে না।
3. প্রথম PC-র ডেটা Drive-এ যায়। পরের PC-গুলো sign in করলেই সেই ডেটা পায়, আর নিজেদের ডেটাও তাতে যোগ হয়। সবাই সবকিছু দেখতে ও edit করতে পারে।
4. Sync নিজে থেকেই চলে: কোনো পরিবর্তনের ১–২ সেকেন্ড পরে, আর প্রতি ১৫ সেকেন্ডে। কোনো PC বা সার্ভার চালু রাখতে হয় না।
5. Sidebar-এর নিচে সবুজ বিন্দু মানে sync হয়েছে। লাল মানে sync হয়নি; কারণ দেখতে মাউস রাখুন।

Gmail-টাই এখন সুরক্ষা: যার কাছে ওই Gmail-এর password থাকবে, সে সব credential দেখতে পাবে। তাই ওই account-এ 2-step verification চালু রাখুন।

## Google OAuth client (one time)

The app needs the Google Cloud OAuth client (type **Desktop app**, scope `drive.file`, Google Drive API enabled).
Nothing about it is kept in the source code. The app looks for it in this order:

1. `APV_GOOGLE_CLIENT_ID` / `APV_GOOGLE_CLIENT_SECRET`, or a JSON file named by `APV_GOOGLE_OAUTH_FILE` (development).
2. `google-oauth.json` in the app's data folder (`%APPDATA%\AgencyProjectVault`). The sign-in screen offers
   **Choose Google OAuth file…** when nothing else is found; it copies the `client_secret_….json` downloaded from
   Google Cloud there.
3. `google-oauth.json` next to the installed `.exe`.
4. Built into the installer from the repository's GitHub Actions secrets `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` (Settings → Secrets and variables → Actions). With these set, no PC has to choose a
   file.

For installed apps Google does not treat the client secret as confidential (it ships inside every desktop app);
each sign-in is protected by PKCE. `google-oauth.json` and `client_secret*.json` are git-ignored.

## Backups in Google Drive

Settings → Backup → **Back up to Google Drive…** writes the usual encrypted `.apv` backup (its own passphrase) into
the app's Drive folder under `backups/`. **Restore from Google Drive…** lists them on any PC signed in to the same
account. After a restore on a synced PC the restored rows are published as fresh edits, so they reach the other PCs;
rows the team added after the backup stay.

## How it works

- An expired or revoked sign-in shows "Sign in again" in Settings; syncing resumes after it.
- Sign-in uses the OAuth loopback flow: the system browser opens Google's page, Google redirects to a one-time
  server on `127.0.0.1`, and the app exchanges the code (with PKCE) for tokens. Only the refresh token is stored,
  in `google/account.json`, protected by Windows DPAPI like the vault key.
- With the `drive.file` scope the app sees only files it created. On first sign-in it creates a folder
  **Agency Project Vault** in My Drive (found again later by an app property), holding:
  - `team.json`: the team id and the team key. The first PC's vault key becomes the team key; every later PC
    re-encrypts its own credentials with it (the old key file is kept as `vault.key.before-team`).
  - `records/<table>/<row id>/<device id>.rec` and `files/<uuid>.bin`: the same encrypted per-row, per-PC
    records and document files that folder sync uses (see [TEAM_SYNC.md](TEAM_SYNC.md)), stored as flat Drive
    files named by their path. The latest edit wins per row; deletes travel as tombstones.
- Each sync round lists the folder once and downloads only files whose checksum changed.
- A PC that used folder sync or nothing before keeps its data and brings it along when it signs in. Office-network
  (LAN) and folder teams set up with earlier versions keep working and keep their controls in Settings.
