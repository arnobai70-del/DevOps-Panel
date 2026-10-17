# Team sync through Google Drive / OneDrive / Dropbox

## সংক্ষেপে (বাংলা)

1. যে PC-তে এখন project আর credential আছে, সেখানে Google Drive for desktop (বা OneDrive/Dropbox) install করুন, তারপর Drive-এর ভেতরে একটা ফোল্ডার বানান, যেমন `My Drive\Agency Vault`।
2. App-এ **Settings → Team Sharing → Create team folder…** চাপুন। ওই ফোল্ডারটা বেছে নিন, একটা team name দিন আর একটা team passphrase দিন (কমপক্ষে ১০ অক্ষর)।
3. Google Drive-এ ওই ফোল্ডারটা টিমের বাকিদের সাথে **Share** করুন (Editor হিসেবে)।
4. বাকিদের PC-তে Google Drive for desktop থাকতে হবে, আর শেয়ার করা ফোল্ডারটা তাদের Drive-এ দেখা যেতে হবে। "Shared with me" থেকে **Add shortcut to Drive** দিন।
5. তাদের app-এ **Settings → Team Sharing → Join team folder…** চাপবেন আর শুধু passphrase দেবেন। ফোল্ডার বাছতে হবে না: app নিজেই Google Drive (G:\My Drive, Shared drives), OneDrive বা Dropbox-এর ভেতরে team ফোল্ডারটা খুঁজে নেয়। না পেলে তখন হাতে ফোল্ডার বাছার অপশন আসে।

এরপর সবাই একই project, credential, document, note আর link দেখবে ও ব্যবহার করতে পারবে। কোনো PC চালু রাখতে হয় না। সার্ভার, domain বা VPS লাগে না। Drive-এ সবকিছু encrypted অবস্থায় থাকে।

## How it works

- Every PC keeps a full copy of the vault in its own SQLite database, so the app works offline and nothing has to
  stay on.
- The shared folder gets a subfolder `AgencyProjectVault-Team/` with:
  - `team.json`, which holds the team id and name and the **team key**, wrapped with a key derived from the team
    passphrase (scrypt N=2^17, AES-256-GCM).
  - `records/<table>/<row id>/<device id>.rec`: one encrypted file per row per PC that changed it. A file holds the
    whole row and a stamp, which is the edit time, kept above every stamp that PC has seen.
  - `files/<uuid>.bin`: the encrypted document files.
- **Sync round.** The app syncs every 15 seconds, 1.5 seconds after any change on this PC, and on **Sync now**. Each
  round first writes the rows that changed here, then reads the files that changed in the folder. A record is applied
  when its stamp is newer than what this PC has, so the latest edit of a row wins on every PC.
- **No overwrites.** PCs never write each other's files, so Drive or OneDrive never has to merge anything.
- **Deletes.** A removed credential, note, link or document syncs as a normal change, because it is a soft delete.
  A deleted project syncs as a tombstone that removes it and its contents everywhere.
- **Credentials.** Credentials stay encrypted with the vault key, and in a team every PC uses the same team key.
  When a PC joins, its existing credentials are re-encrypted with the team key. The old key file is kept as
  `vault.key.before-team`.
- **Encryption in the folder.** Records and files are encrypted with keys derived from the team key (HKDF,
  AES-256-GCM, bound to the table, row and device). Google, Microsoft or anyone else with only the folder sees
  ciphertext and row counts.

## Good to know

- **Passphrase.** Anyone with the folder **and** the passphrase can read everything. Share the passphrase in person
  or by phone, not next to the folder link.
- **Two people editing the same item.** If two people edit the same item before syncing, the later edit wins. An edit
  form that is open while a teammate's change arrives says "changed since you opened it" instead of overwriting.
- **Offline.** Changes made offline sync when the PC is back online.
- **Backups.** Backups still work on any PC. Restoring a backup is blocked while folder sync is on. Stop syncing
  first, so an old backup does not spread to the whole team.
- **Leaving.** **Stop syncing** keeps this PC's copy and stops exchanging changes.
- **Network sharing.** Folder sync and office-network sharing (Settings → "On the office network only") cannot be on
  at the same time.

## Troubleshooting

| Problem | Fix |
|---|---|
| "The team folder is not available" | Start Google Drive / OneDrive and check the folder still exists at the same path. |
| "No team vault found in this folder" | Pick the folder the team was created in (the one that contains `AgencyProjectVault-Team`). |
| "Wrong team passphrase" | Ask the person who created the team for the exact passphrase. |
| Teammate's change not showing | Wait for the cloud app to finish uploading/downloading, then press **Sync now**. |
| "Waiting: N change(s)…" | A document file is still uploading on the other PC; it completes on a later sync. |
