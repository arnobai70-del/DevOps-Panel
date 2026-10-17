# Backup and restore guide

## What a backup contains

One encrypted `.apv` file with everything in the vault: projects, credentials (still encrypted), documents,
notes, links and the vault key. It is protected by a passphrase you choose, so it can be restored on any PC,
including a new one.

The file is encrypted with AES-256-GCM using a key derived from your passphrase with scrypt. Without the
passphrase the backup cannot be opened, and nobody (including the developers) can recover it.

## Make a backup

1. Open **Settings → Back up now…**
2. Enter a passphrase of at least 10 characters, twice.
3. Choose where to save the file. A USB drive or another disk is best; a copy on the same disk does not
   protect against a disk failure.
4. Write the passphrase down and keep it somewhere other than the backup file.

The Dashboard reminds you when the vault has never been backed up or the last backup is more than 7 days old.
Make a backup before updating the app.

## Restore

1. Install the app (on the same or a new PC) and open **Settings → Restore from backup…**
2. Enter the backup passphrase, tick **Replace the current vault with the backup**, and choose the `.apv` file.
3. The app checks the whole backup first: passphrase, every file's checksum, the database's integrity, and that
   the key opens the credentials. If anything is wrong, nothing is changed.
4. The current vault is moved, not deleted, to `backups\pre-restore-<date>\` inside the data folder, then the
   backup is put in its place. Click **Open restored vault**.

To undo a restore, close the app and move the files from that `pre-restore-…` folder back into the data folder.

## Where the data lives

`%APPDATA%\AgencyProjectVault\` (shown in Settings). Uninstalling the app does not delete it.
