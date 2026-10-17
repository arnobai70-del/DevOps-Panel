import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AppInfo, BackupCounts, BackupStatus } from '../../../shared/types'
import { Modal } from '../components/Modal'
import { TeamPanel } from '../components/TeamPanel'
import { errorText, formatBytes } from '../lib'

const MIN_PASSPHRASE = 10

export function Settings(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [dialog, setDialog] = useState<'backup' | 'restore' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadStatus = useCallback(async () => setStatus(await window.vault.backups.status()), [])

  useEffect(() => {
    void window.vault.app.info().then((appInfo) => {
      setInfo(appInfo)
      // A joined PC has no vault of its own to back up; the host makes the backups.
      if (appInfo.mode !== 'client') void loadStatus()
    })
  }, [loadStatus])

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      {info?.mode === 'client' ? (
        <section className="panel">
          <h2>Backup</h2>
          <p className="muted">This PC uses a team vault. Backups are made on the host PC, where the data is stored.</p>
        </section>
      ) : (
        <section className="panel">
          <h2>Backup</h2>
          <p>
            {status === null
              ? '…'
              : status.lastBackupAt
                ? `Last backup: ${new Date(status.lastBackupAt).toLocaleString()}`
                : 'No backup has been made from this vault yet.'}
          </p>
          <p className="muted">
            A backup is one encrypted <code>.apv</code> file with all projects, credentials, documents, notes and links. Save it
            on a USB drive or another disk. It can only be opened with its passphrase, so store the passphrase separately.
          </p>
          {message && <div className="notice">{message}</div>}
          <div className="actions start">
            <button className="primary" onClick={() => setDialog('backup')}>
              Back up now…
            </button>
            <button onClick={() => setDialog('restore')}>Restore from backup…</button>
          </div>
        </section>
      )}
      <TeamPanel onRoleChange={() => void window.vault.app.info().then(setInfo)} />
      <section className="panel">
        <h2>Storage</h2>
        <dl className="facts">
          <dt>Mode</dt>
          <dd>
            {info === null
              ? '…'
              : info.mode === 'client'
                ? 'Team vault (data is stored on the host PC)'
                : info.mode === 'folder'
                  ? 'Team folder sync (a full copy on this PC, synced through a shared folder)'
                  : info.mode === 'host'
                    ? 'Team host (data stays on this PC and is shared on the office network)'
                    : 'Personal Local (data stays on this PC)'}
          </dd>
          <dt>Data folder</dt>
          <dd className="mono">{info?.dataDir ?? '…'}</dd>
          <dt>Key protection</dt>
          <dd>
            {info === null
              ? '…'
              : info.keyProtection === 'safeStorage'
                ? 'Protected by Windows (DPAPI)'
                : 'Not protected by the OS on this machine'}
          </dd>
          <dt>Version</dt>
          <dd>{info?.version ?? '…'}</dd>
        </dl>
      </section>
      {dialog === 'backup' && (
        <BackupDialog
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null)
            setMessage(text)
            void loadStatus()
          }}
        />
      )}
      {dialog === 'restore' && <RestoreDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

const describeCounts = (c: BackupCounts): string =>
  `${c.projects} projects, ${c.credentials} credentials, ${c.documents} documents, ${c.notes} notes, ${c.links} links`

function BackupDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }): React.JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (passphrase.length < MIN_PASSPHRASE) return setError(`Use at least ${MIN_PASSPHRASE} characters.`)
    if (passphrase !== confirmation) return setError('The two passphrases do not match.')
    setBusy(true)
    setError(null)
    try {
      const result = await window.vault.backups.create(passphrase)
      if (result) onDone(`Backup saved to ${result.path} (${formatBytes(result.bytes)}): ${describeCounts(result.counts)}.`)
      else setBusy(false)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Back up now" onClose={busy ? () => undefined : onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label>
          Backup passphrase
          <input type="password" autoFocus autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <label>
          Repeat passphrase
          <input type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </label>
        <p className="hint">
          Write this passphrase down and keep it apart from the backup file. Without it the backup cannot be restored, and
          nobody can recover it.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Backing up…' : 'Choose where to save…'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RestoreDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await window.vault.backups.restore(passphrase)
      if (result) {
        setDone(
          `Restored the backup from ${new Date(result.backupCreatedAt).toLocaleString()}: ${describeCounts(result.counts)}. ` +
            `Your previous data was kept in ${result.safetyCopyDir}.`
        )
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Modal title="Restore complete" onClose={() => window.location.reload()}>
        <p>{done}</p>
        <div className="actions">
          <button className="primary" onClick={() => window.location.reload()}>
            Open restored vault
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Restore from backup" onClose={busy ? () => undefined : onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <p>
          Restoring replaces everything in this vault with the contents of the backup. The backup is fully checked first; if
          anything is wrong, nothing changes. Your current data is moved to a safety folder, not deleted.
        </p>
        <label>
          Backup passphrase
          <input type="password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          Replace the current vault with the backup
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !agreed || !passphrase}>
            {busy ? 'Checking and restoring…' : 'Choose backup file…'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
