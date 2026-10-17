import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { CredentialField, CredentialSave, CredentialSummary } from '../../../shared/types'
import { errorText } from '../lib'
import { ExternalLink } from './ExternalLink'
import { Modal } from './Modal'

const AUTO_HIDE_MS = 20_000

export function CredentialsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const [items, setItems] = useState<CredentialSummary[] | null>(null)
  const [editing, setEditing] = useState<CredentialSummary | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await window.vault.credentials.list(projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(c: CredentialSummary): Promise<void> {
    if (!confirm(`Delete the "${c.serviceName}" credential?`)) return
    try {
      await window.vault.credentials.remove(c.id)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section>
      <div className="section-head">
        <p className="muted">Secrets are encrypted on this PC and stay hidden until you click Reveal or Copy.</p>
        <button className="primary" onClick={() => setEditing('new')}>
          + Add Credential
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty small">No credentials yet.</div>
      ) : (
        <div className="list">
          {items.map((c) => (
            <article key={c.id} className="card">
              <div className="card-head">
                <div>
                  <h3>{c.serviceName}</h3>
                  {c.serviceUrl && <ExternalLink url={c.serviceUrl} />}
                </div>
                <div className="actions">
                  <button onClick={() => setEditing(c)}>Edit</button>
                  <button className="danger" onClick={() => void remove(c)}>
                    Delete
                  </button>
                </div>
              </div>
              {c.fields.length === 0 && <p className="muted">No secret fields saved.</p>}
              {c.fields.map((f) => (
                <SecretField key={f.key} credentialId={c.id} field={f.key} label={f.label} />
              ))}
              {c.notes && <p className="muted pre">{c.notes}</p>}
            </article>
          ))}
        </div>
      )}
      {editing && (
        <CredentialForm
          projectId={projectId}
          credential={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </section>
  )
}

function SecretField({
  credentialId,
  field,
  label
}: {
  credentialId: string
  field: CredentialField
  label: string
}): React.JSX.Element {
  const [value, setValue] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (value === null) return
    const hide = (): void => setValue(null)
    const timer = setTimeout(hide, AUTO_HIDE_MS)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('blur', hide)
    }
  }, [value])

  async function reveal(): Promise<void> {
    try {
      setValue(value === null ? await window.vault.credentials.reveal(credentialId, field) : null)
    } catch (err) {
      setStatus(errorText(err))
    }
  }

  async function copy(): Promise<void> {
    try {
      await window.vault.credentials.copy(credentialId, field)
      setStatus('Copied')
      setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setStatus(errorText(err))
    }
  }

  return (
    <div className="secret-row">
      <span className="secret-label">{label}</span>
      <code className="secret-value">{value ?? '••••••••••'}</code>
      <button onClick={() => void reveal()}>{value === null ? 'Reveal' : 'Hide'}</button>
      <button onClick={() => void copy()}>Copy</button>
      {status && <span className="muted small-text">{status}</span>}
    </div>
  )
}

type StandardKey = 'username' | 'password' | 'apiKey' | 'apiSecret'
const STANDARD: { key: StandardKey; label: string; secret: boolean }[] = [
  { key: 'username', label: 'Username / email', secret: false },
  { key: 'password', label: 'Password', secret: true },
  { key: 'apiKey', label: 'API key', secret: true },
  { key: 'apiSecret', label: 'API secret', secret: true }
]

function CredentialForm({
  projectId,
  credential,
  onCancel,
  onSaved
}: {
  projectId: string
  credential?: CredentialSummary
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const has = (key: string): boolean => !!credential?.fields.some((f) => f.key === key)
  const [serviceName, setServiceName] = useState(credential?.serviceName ?? '')
  const [serviceUrl, setServiceUrl] = useState(credential?.serviceUrl ?? '')
  const [notes, setNotes] = useState(credential?.notes ?? '')
  const [values, setValues] = useState<Record<StandardKey, string>>({ username: '', password: '', apiKey: '', apiSecret: '' })
  const [cleared, setCleared] = useState<Set<StandardKey>>(new Set())
  const [extras, setExtras] = useState<{ id?: string; label: string; value: string }[]>(
    credential?.fields
      .filter((f) => f.key.startsWith('extra:'))
      .map((f) => ({ id: f.key.slice('extra:'.length), label: f.label, value: '' })) ?? []
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const input: CredentialSave = {
      id: credential?.id,
      revision: credential?.revision,
      projectId,
      serviceName,
      serviceUrl,
      notes,
      // An empty box means "leave as is"; Remove clears a saved value.
      extras: extras
        .filter((x) => x.label.trim() || x.value)
        .map((x) => ({ id: x.id, label: x.label, value: x.id && x.value === '' ? undefined : x.value }))
    }
    for (const { key } of STANDARD) {
      if (cleared.has(key)) input[key] = null
      else if (values[key] !== '') input[key] = values[key]
    }
    try {
      await window.vault.credentials.save(input)
      onSaved()
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Modal title={credential ? 'Edit Credential' : 'Add Credential'} onClose={onCancel}>
      <form className="form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <div className="row">
          <label>
            Service name *
            <input autoFocus required maxLength={150} placeholder="Website Admin / Cloudflare" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
          </label>
          <label>
            Login URL
            <input type="url" value={serviceUrl} onChange={(e) => setServiceUrl(e.target.value)} />
          </label>
        </div>
        {STANDARD.map(({ key, label, secret }) => {
          const saved = has(key) && !cleared.has(key)
          return (
            <label key={key}>
              {label}
              <div className="input-row">
                <input
                  type={secret ? 'password' : 'text'}
                  autoComplete="new-password"
                  placeholder={saved ? 'Saved (leave blank to keep)' : ''}
                  disabled={cleared.has(key)}
                  value={values[key]}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                />
                {has(key) && (
                  <button
                    type="button"
                    onClick={() =>
                      setCleared((s) => {
                        const next = new Set(s)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }
                  >
                    {cleared.has(key) ? 'Undo' : 'Remove'}
                  </button>
                )}
              </div>
            </label>
          )
        })}
        <fieldset className="extras">
          <legend>Extra fields</legend>
          {extras.map((x, i) => (
            <div key={x.id ?? `new-${i}`} className="input-row">
              <input placeholder="Label" value={x.label} onChange={(e) => setExtras((xs) => xs.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
              <input
                type="password"
                autoComplete="new-password"
                placeholder={x.id ? 'Saved (leave blank to keep)' : 'Value'}
                value={x.value}
                onChange={(e) => setExtras((xs) => xs.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
              />
              <button type="button" onClick={() => setExtras((xs) => xs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setExtras((xs) => [...xs, { label: '', value: '' }])}>
            + Add field
          </button>
        </fieldset>
        <label>
          Purpose / notes
          <textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="hint">Notes are not encrypted. Do not paste secrets here.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
