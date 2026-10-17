# Team sync with a Google sign-in

## সংক্ষেপে (বাংলা)

1. প্রথমবার app খুললে শুধু **Sign in with Google** আসে। যে Gmail-এর Google Drive-এ টিমের ডেটা থাকবে, সেটা দিয়ে sign in করুন।
2. অন্য প্রতিটা PC-তেও একই Gmail দিয়ে sign in করুন। ফোল্ডার বাছাই, team passphrase, Google Drive for desktop, কিছুই লাগে না।
3. প্রথম PC-র ডেটা Drive-এ যায়। পরের PC-গুলো sign in করলেই সেই ডেটা পায়, আর নিজেদের ডেটাও তাতে যোগ হয়। সবাই সবকিছু দেখতে ও edit করতে পারে।
4. Sync নিজে থেকেই চলে: কোনো পরিবর্তনের ১–২ সেকেন্ড পরে, আর প্রতি ১৫ সেকেন্ডে। কোনো PC বা সার্ভার চালু রাখতে হয় না।
5. Sidebar-এর নিচে সবুজ বিন্দু মানে sync হয়েছে। লাল মানে sync হয়নি; কারণ দেখতে মাউস রাখুন।

Gmail-টাই এখন সুরক্ষা: যার কাছে ওই Gmail-এর password থাকবে, সে সব credential দেখতে পাবে। তাই ওই account-এ 2-step verification চালু রাখুন।

## One-time setup for the build (Google Cloud OAuth client)

Google requires every app that signs in to Google to have its own OAuth client. Create it once with the Google
account that owns the project:

1. Open <https://console.cloud.google.com>, create a project.
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **OAuth consent screen** (Google Auth Platform): app name and support email; audience **External** (or
   **Internal** for a Workspace domain). The app asks only for `openid`, `email` and `drive.file`, which are
   non-sensitive scopes, so no Google verification is needed. **Publish** the app so sign-ins do not expire after
   7 days.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**.
5. Put the client ID and secret in `src/main/google/client.ts`. For installed apps Google does not treat the client
   secret as confidential; each sign-in is protected by PKCE.

## How it works

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
