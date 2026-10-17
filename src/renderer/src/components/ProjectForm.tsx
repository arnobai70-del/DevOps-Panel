import { useState, type FormEvent } from 'react'
import { PROJECT_STATUSES, PROJECT_TYPES } from '../../../shared/constants'
import type { ProjectInput } from '../../../shared/types'

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function ProjectForm({
  onCancel,
  onSaved
}: {
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [form, setForm] = useState({
    name: '',
    description: '',
    type: '',
    status: 'active',
    websiteUrl: '',
    adminUrl: '',
    hostingName: '',
    domainProvider: '',
    repositoryUrl: '',
    developerName: '',
    techStack: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const input: ProjectInput = {
      ...form,
      type: (form.type || null) as ProjectInput['type'],
      status: form.status as ProjectInput['status'],
      techStack: splitList(form.techStack)
    }
    try {
      await window.vault.projects.create(input)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add project">
      <form className="modal" onSubmit={(e) => void submit(e)}>
        <h2>Add Project</h2>
        <label>
          Project name *
          <input autoFocus required maxLength={150} value={form.name} onChange={set('name')} />
        </label>
        <label>
          Description
          <textarea rows={3} maxLength={2000} value={form.description} onChange={set('description')} />
        </label>
        <div className="row">
          <label>
            Type
            <select value={form.type} onChange={set('type')}>
              <option value="">—</option>
              {PROJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={form.status} onChange={set('status')}>
              {PROJECT_STATUSES.filter((s) => s !== 'archived').map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Live website URL
            <input type="url" placeholder="https://example.com" value={form.websiteUrl} onChange={set('websiteUrl')} />
          </label>
          <label>
            Admin URL
            <input type="url" value={form.adminUrl} onChange={set('adminUrl')} />
          </label>
        </div>
        <div className="row">
          <label>
            Hosting
            <input value={form.hostingName} onChange={set('hostingName')} />
          </label>
          <label>
            Domain provider
            <input value={form.domainProvider} onChange={set('domainProvider')} />
          </label>
        </div>
        <div className="row">
          <label>
            Repository URL
            <input type="url" value={form.repositoryUrl} onChange={set('repositoryUrl')} />
          </label>
          <label>
            Developer
            <input value={form.developerName} onChange={set('developerName')} />
          </label>
        </div>
        <label>
          Tech stack (comma separated)
          <input placeholder="Laravel, React" value={form.techStack} onChange={set('techStack')} />
        </label>
        <p className="hint">Passwords and API keys go in Credentials, not here.</p>
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
    </div>
  )
}
