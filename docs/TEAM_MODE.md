# Team Mode guide (office network)

Team Mode lets up to three PCs work on one vault. One PC is the **host**: the vault stays on its disk.
The other PCs **join** it and see and edit the same projects, credentials, documents, notes and links.
Everything travels over the local network only; no internet, VPS or cloud account is involved.

## Set up the host (PC-A)

1. Open **Settings → Team Sharing → Share this vault**.
2. If Windows Defender Firewall asks, tick **Private networks** and choose **Allow access**. Do not allow
   public networks.
3. Settings now shows the **host address** (for example `192.168.1.20`), a **pairing code** such as
   `K7QD-3MXA` and a **security code**. A pairing code is valid for 10 minutes and for one PC; press
   **New pairing code** for the next PC.

The host PC must be switched on, with the app open, while others are working.

## Join from another PC (PC-B, PC-C)

1. Open **Settings → Team Sharing → Join a team vault…**
2. Enter the host address, the pairing code and a name for this PC, then **Send join request**.
3. Check that the security code shown matches the one on the host.
4. On the host, approve the request under **Waiting for approval**. The joined PC switches to the team vault
   automatically.

While joined, a PC's own local vault is kept untouched on its disk. **Leave team vault** switches back to it.

## Everyday use

- When two people edit the same item, the second save is refused with "changed since you opened it" instead of
  overwriting; reload and try again.
- If the host is off or unreachable, the Dashboard shows **Team Vault offline** and nothing can be changed
  until it is back. There is no offline editing of the team vault, so copies never drift apart.
- Documents uploaded from a joined PC are checked with SHA-256 on arrival, and downloads are checked again
  before they are saved or opened.

## Removing a PC

On the host, **Settings → Team Sharing → Connected PCs → Remove** cuts that PC off immediately. To let it back,
pair it again with a new code.

## Backups

Backups are made on the host, from **Settings → Backup**, and include every PC's work. Joined PCs have
nothing of the team vault on disk to back up. Restoring a backup on the host also restores its list of
connected PCs as it was when the backup was made, so check that list afterwards.

## How it is protected

- The host serves HTTPS on port 47321 with its own certificate. When a PC joins, both sides prove they know
  the pairing code over that certificate (HMAC), so a machine in the middle cannot pair or impersonate the
  host. Joined PCs then accept only that certificate.
- The pairing code never crosses the network. Five wrong attempts burn the code.
- Each joined PC gets a random access token, stored on that PC protected by Windows (DPAPI) and on the host
  only as a SHA-256 hash. Removing a PC revokes its token.
- Only private network addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x, link-local) are served.
- Joined PCs can only call the same vault operations the app uses locally, with the same validation.
- All joined PCs have the same access to everything; there are no per-project permissions, by design.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Team Vault offline" | Turn on the host PC and open the app. Check both PCs are on the same Wi-Fi/LAN. |
| Joining times out | On the host, allow the app through Windows Firewall on Private networks (Windows Security → Firewall → Allow an app). Make sure the Wi-Fi is set as a **Private** network. |
| "Port 47321 is already in use" | Another program uses that port on the host. Close it and press **Try again**. |
| "presented a different certificate" | The host was reinstalled or its data folder replaced. Leave the team vault and join again. |
| Pairing code rejected | Codes expire after 10 minutes and after one PC. Create a new code on the host. |
