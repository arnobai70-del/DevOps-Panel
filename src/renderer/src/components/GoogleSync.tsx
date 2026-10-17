import { useCallback, useEffect, useState } from 'react'
import type { TeamStatus } from '../../../shared/types'
import { errorText } from '../lib'

const POLL_MS = 5000
const SKIP_KEY = 'apv.skipGoogleSignIn'

/** Whether this PC chose to stay offline instead of signing in (a per-PC convenience only). */
export function signInSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1'
  } catch {
    return false
  }
}

function setSkipped(value: boolean): void {
  try {
    if (value) localStorage.setItem(SKIP_KEY, '1')
    else localStorage.removeItem(SKIP_KEY)
  } catch {
    // Without storage the sign-in screen simply shows again next time.
  }
}

/** Whether this PC has a Google OAuth client, and a way to import its JSON file when it does not. */
function useClientSetup(): { configured: boolean | null; importFile: () => Promise<void>; importError: string | null } {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  useEffect(() => {
    void window.vault.app.info().then((info) => setConfigured(info.googleConfigured))
  }, [])
  const importFile = async (): Promise<void> => {
    setImportError(null)
    try {
      if (await window.vault.team.importGoogleClient()) setConfigured(true)
    } catch (err) {
      setImportError(errorText(err))
    }
  }
  return { configured, importFile, importError }
}

function ClientSetup({ importFile, importError }: { importFile: () => Promise<void>; importError: string | null }): React.JSX.Element {
  return (
    <>
      <p className="hint">
        This copy of the app has no Google sign-in set up yet. Choose the OAuth client file you downloaded from Google Cloud
        (client_secret_….json). It is kept only in this PC&apos;s app data folder.
      </p>
      {importError && <div className="error-banner">{importError}</div>}
      <button onClick={() => void importFile()}>Choose Google OAuth file…</button>
    </>
  )
}

/** Signs in with Google and starts syncing; the page reloads so it shows the merged team data. */
function useConnect(): { connect: () => Promise<void>; cancel: () => void; busy: boolean; error: string | null } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.vault.team.connectGoogle()
      setSkipped(false)
      window.location.reload()
    } catch (err) {
      const text = errorText(err)
      if (!/cancelled/i.test(text)) setError(text)
      setBusy(false)
    }
  }
  const cancel = (): void => void window.vault.team.cancelGoogleSignIn()
  return { connect, cancel, busy, error }
}

/** First screen on a PC that is not signed in: one button, nothing else to fill in. */
export function SignInScreen({ onSkip }: { onSkip: () => void }): React.JSX.Element {
  const { connect, cancel, busy, error } = useConnect()
  const { configured, importFile, importError } = useClientSetup()
  return (
    <div className="welcome">
      <div className="welcome-box">
        <h1>Agency Project Vault</h1>
        <p>
          Sign in with the Google account whose Drive keeps the team&apos;s data. Use the same account on every PC: everyone
          sees and edits the same projects, credentials, documents, notes and links.
        </p>
        {error && <div className="error-banner">{error}</div>}
        {configured === false ? (
          <ClientSetup importFile={importFile} importError={importError} />
        ) : busy ? (
          <>
            <p className="muted">Finish signing in in the browser window that just opened…</p>
            <button onClick={cancel}>Cancel</button>
          </>
        ) : (
          <button className="primary large" onClick={() => void connect()}>
            Sign in with Google
          </button>
        )}
        <p className="hint">
          The app only sees the files it creates in that Drive (an &quot;Agency Project Vault&quot; folder), nothing else.
        </p>
        {!busy && (
          <button
            className="link"
            onClick={() => {
              setSkipped(true)
              onSkip()
            }}
          >
            Use on this PC only for now
          </button>
        )}
      </div>
    </div>
  )
}

/** Sidebar line that shows whether this PC is in sync with the team. */
export function SyncBadge(): React.JSX.Element | null {
  const [status, setStatus] = useState<TeamStatus | null>(null)
  const refresh = useCallback(async () => {
    try {
      setStatus(await window.vault.team.status())
    } catch {
      // Keep the last known state.
    }
  }, [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  if (status?.role !== 'google') return null
  const state = status.error ? 'error' : status.lastSyncAt ? 'ok' : 'busy'
  return (
    <button
      className={`sync-badge ${state}`}
      title={status.error ?? `Signed in as ${status.email}. Click to sync now.`}
      onClick={() => void window.vault.team.syncNow().then(setStatus, () => refresh())}
    >
      <span className="dot" />
      <span>
        {state === 'error' ? 'Not synced' : state === 'ok' ? `Synced ${new Date(status.lastSyncAt!).toLocaleTimeString()}` : 'Syncing…'}
        <small>{status.email}</small>
      </span>
    </button>
  )
}

/** Settings section for the Google account. */
export function AccountPanel({ status, onChange }: { status: TeamStatus; onChange: () => void }): React.JSX.Element {
  const { connect, cancel, busy, error } = useConnect()
  const { configured, importFile, importError } = useClientSetup()
  const [actionError, setActionError] = useState<string | null>(null)

  if (status.role === 'google') {
    return (
      <section className="panel">
        <h2>Google account</h2>
        {status.error && <div className="error-banner">{status.error}</div>}
        {error && <div className="error-banner">{error}</div>}
        {status.error && /sign in again/i.test(status.error) && (
          <div className="actions start">
            <button className="primary" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Finish signing in in the browser…' : 'Sign in again'}
            </button>
          </div>
        )}
        {actionError && <div className="error-banner">{actionError}</div>}
        <p>
          Everything syncs through <strong>{status.email}</strong>&apos;s Google Drive. Changes reach the other PCs within
          seconds while they are online, and arrive when they next open the app if not.
        </p>
        <dl className="facts">
          <dt>Last sync</dt>
          <dd>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Not yet'}</dd>
          {status.pending > 0 && (
            <>
              <dt>Waiting</dt>
              <dd>{status.pending} change(s) still arriving</dd>
            </>
          )}
        </dl>
        <div className="actions start">
          <button onClick={() => void window.vault.team.syncNow().then(onChange, (err: unknown) => setActionError(errorText(err)))}>
            Sync now
          </button>
          <button
            onClick={() => {
              if (!window.confirm('Sign out of Google on this PC? This PC keeps its copy of the data but stops syncing.')) return
              void window.vault.team.signOutGoogle().then(() => window.location.reload(), (err: unknown) => setActionError(errorText(err)))
            }}
          >
            Sign out
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="panel">
      <h2>Google account</h2>
      {error && <div className="error-banner">{error}</div>}
      <p>
        Not signed in. This PC keeps its data to itself. Sign in with the team&apos;s Google account to share everything with
        the other PCs.
      </p>
      <div className="actions start">
        {configured === false ? (
          <ClientSetup importFile={importFile} importError={importError} />
        ) : busy ? (
          <>
            <span className="muted">Finish signing in in the browser…</span>
            <button onClick={cancel}>Cancel</button>
          </>
        ) : (
          <button className="primary" onClick={() => void connect()}>
            Sign in with Google
          </button>
        )}
      </div>
    </section>
  )
}

/** Dashboard notice on a PC that is not signed in yet, so sharing is always one click away. */
export function SignInBanner(): React.JSX.Element | null {
  const [show, setShow] = useState(false)
  const { connect, cancel, busy, error } = useConnect()
  const { configured, importFile, importError } = useClientSetup()
  useEffect(() => {
    void window.vault.team.status().then((s) => setShow(s.role !== 'google'))
  }, [])
  if (!show) return null
  return (
    <div className="notice reminder">
      <span>
        {error ?? importError ?? 'This PC is not shared with the team yet. Sign in with the team\'s Google account to share everything.'}
      </span>
      {configured === false ? (
        <button onClick={() => void importFile()}>Choose Google OAuth file…</button>
      ) : busy ? (
        <button onClick={cancel}>Cancel sign-in</button>
      ) : (
        <button className="primary" onClick={() => void connect()}>
          Sign in with Google
        </button>
      )}
    </div>
  )
}
