import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { TeamStatus } from '../../../shared/types'
import { errorText, formatDate } from '../lib'
import { Modal } from './Modal'

const POLL_MS = 2000

/** Settings section for sharing this vault with up to a few PCs on the office network, or joining one. */
export function TeamPanel({ onRoleChange }: { onRoleChange: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<TeamStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [joining, setJoining] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.vault.team.status())
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // While sharing, keep join requests and the code countdown fresh.
  const sharing = status?.role === 'host' && status.running
  useEffect(() => {
    if (!sharing) return
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [sharing, refresh])

  const act = async (fn: () => Promise<TeamStatus>, reload = false): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await fn()
      if (reload) return window.location.reload()
      if (next.role !== status?.role) onRoleChange()
      setStatus(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Team Sharing (office network)</h2>
      {error && <div className="error-banner">{error}</div>}
      {status === null && <p className="muted">…</p>}

      {status?.role === 'personal' && (
        <>
          <p>
            Share this vault with the other PCs in the office, or join a vault another PC is sharing. Everything stays on
            your local network; nothing goes to the internet.
          </p>
          <div className="actions start">
            <button className="primary" disabled={busy} onClick={() => void act(() => window.vault.team.enableHost())}>
              Share this vault
            </button>
            <button disabled={busy} onClick={() => setJoining(true)}>
              Join a team vault…
            </button>
          </div>
        </>
      )}

      {status?.role === 'host' && (
        <>
          {status.error && <div className="error-banner">{status.error}</div>}
          {status.running && (
            <>
              <p>
                This PC is the <strong>host</strong>. Keep it switched on with the app open while others work. If Windows asks
                about the firewall, allow access on <strong>Private networks</strong>.
              </p>
              <dl className="facts">
                <dt>Host address</dt>
                <dd className="mono">
                  {status.addresses.length
                    ? status.addresses.map((a) => (status.port === 47321 ? a : `${a}:${status.port}`)).join('  or  ')
                    : 'No network connection found'}
                </dd>
                <dt>Pairing code</dt>
                <dd>
                  {status.code ? (
                    <>
                      <span className="mono pairing-code">{status.code.code}</span>{' '}
                      <span className="muted">valid until {new Date(status.code.expiresAt).toLocaleTimeString()}</span>
                    </>
                  ) : (
                    <span className="muted">None. Create one when the next PC is ready to join.</span>
                  )}
                </dd>
                <dt>Security code</dt>
                <dd className="mono">{status.fingerprint}</dd>
              </dl>
              <div className="actions start">
                <button disabled={busy} onClick={() => void act(() => window.vault.team.newCode())}>
                  New pairing code
                </button>
              </div>

              {status.pending.length > 0 && (
                <>
                  <h3>Waiting for approval</h3>
                  <ul className="team-list">
                    {status.pending.map((p) => (
                      <li key={p.id}>
                        <span>
                          <strong>{p.deviceName}</strong> <span className="muted">{p.address ?? ''}</span>
                        </span>
                        <span className="actions">
                          <button className="primary" disabled={busy} onClick={() => void act(() => window.vault.team.approve(p.id))}>
                            Approve
                          </button>
                          <button disabled={busy} onClick={() => void act(() => window.vault.team.deny(p.id))}>
                            Deny
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <h3>Connected PCs</h3>
              {status.devices.length === 0 ? (
                <p className="muted">No PCs have joined yet.</p>
              ) : (
                <ul className="team-list">
                  {status.devices.map((d) => (
                    <li key={d.id}>
                      <span>
                        <strong>{d.name}</strong>{' '}
                        <span className="muted">
                          joined {formatDate(d.createdAt)}
                          {d.lastSeenAt ? `, last seen ${new Date(d.lastSeenAt).toLocaleString()}` : ''}
                        </span>
                      </span>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Remove ${d.name}? It will lose access to this vault immediately.`)) {
                            void act(() => window.vault.team.revoke(d.id))
                          }
                        }}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="actions start">
            {!status.running && (
              <button className="primary" disabled={busy} onClick={() => void act(() => window.vault.team.enableHost())}>
                Try again
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => {
                if (window.confirm('Stop sharing? Other PCs will not reach this vault until you share it again.')) {
                  void act(() => window.vault.team.disableHost())
                }
              }}
            >
              Stop sharing
            </button>
          </div>
        </>
      )}

      {status?.role === 'client' && (
        <>
          <p>
            This PC uses the team vault on <strong>{status.hostName}</strong>. All projects, credentials and documents you see
            are stored on that PC.
          </p>
          <dl className="facts">
            <dt>Host</dt>
            <dd className="mono">
              {status.address}
              {status.port === 47321 ? '' : `:${status.port}`}
            </dd>
            <dt>Status</dt>
            <dd>{status.error ?? 'Online'}</dd>
            <dt>Security code</dt>
            <dd className="mono">{status.fingerprint}</dd>
          </dl>
          <div className="actions start">
            <button disabled={busy} onClick={() => void refresh()}>
              Check connection
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (window.confirm('Leave the team vault? This PC goes back to its own local vault.')) {
                  void act(() => window.vault.team.leave(), true)
                }
              }}
            >
              Leave team vault
            </button>
          </div>
        </>
      )}

      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </section>
  )
}

function JoinDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<{ requestId: string; hostName: string; fingerprint: string } | null>(null)

  useEffect(() => {
    if (!waiting) return
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const result = await window.vault.team.joinStatus(waiting.requestId)
        if (stopped) return
        if (result === 'approved') return window.location.reload()
        if (result === 'pending') {
          setTimeout(() => void poll(), POLL_MS)
          return
        }
        setWaiting(null)
        setError(result === 'denied' ? 'The host PC denied the request.' : 'The request expired. Ask for a new pairing code.')
      } catch (err) {
        if (stopped) return
        setWaiting(null)
        setError(errorText(err))
      }
    }
    void poll()
    return () => {
      stopped = true
    }
  }, [waiting])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setWaiting(await window.vault.team.join({ address, code, deviceName }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (waiting) {
    return (
      <Modal title="Waiting for approval" onClose={onClose}>
        <p>
          Request sent to <strong>{waiting.hostName}</strong>. Approve it on that PC under Settings, Team Sharing.
        </p>
        <p>
          Both PCs should show the same security code: <span className="mono">{waiting.fingerprint}</span>
        </p>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Join a team vault" onClose={busy ? () => undefined : onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <p className="hint">
          While joined, this PC shows the host&apos;s vault instead of its own. Your local vault stays on this PC and comes back
          if you leave.
        </p>
        <label>
          Host address
          <input autoFocus placeholder="e.g. 192.168.1.20" value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          Pairing code
          <input placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          Name for this PC
          <input placeholder="e.g. Rahim's laptop" maxLength={80} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !address || !code || !deviceName}>
            {busy ? 'Connecting…' : 'Send join request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
