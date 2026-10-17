import { useEffect, useState, type FormEvent } from 'react'
import { PROJECT_STATUSES, PROJECT_TYPES } from '../../../shared/constants'
import type { Project, ProjectInput } from '../../../shared/types'
import { errorText, splitList } from '../lib'
import { Modal } from './Modal'

export function ProjectForm({
  project,
  onCancel,
  onSaved
}: {
  project?: Project
  onCancel: () => void
  onSaved: (project: Project) => void
}): React.JSX.Element {
  const [form, setForm] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    type: project?.type ?? '',
    status: project?.status ?? 'active',
    websiteUrl: project?.websiteUrl ?? '',
    adminUrl: project?.adminUrl ?? '',
    hostingName: project?.hostingName ?? '',
    domainProvider: project?.domainProvider ?? '',
    repositoryUrl: project?.repositoryUrl ?? '',
    developerName: project?.developerName ?? '',
    techStack: project?.techStack.join(', ') ?? '',
    tags: project?.tags.join(', ') ?? ''
  })
  const [fields, setFields] = useState(() =>
    (project?.customFields ?? []).map((f) => ({ key: crypto.randomUUID(), label: f.label, value: f.value }))
  )
  // Names already used on other projects, offered as suggestions so the same field is spelled the same way.
  const [knownLabels, setKnownLabels] = useState<string[]>([])
  useEffect(() => {
    window.vault.projects.list({ includeArchived: true }).then(
      (all) => setKnownLabels([...new Set(all.flatMap((p) => p.customFields.map((f) => f.label)))].sort()),
      () => undefined
    )
  }, [])
  const setField = (key: string, part: 'label' | 'value', value: string): void =>
    setFields((list) => list.map((f) => (f.key === key ? { ...f, [part]: value } : f)))
  const addField = (): void => setFields((list) => [...list, { key: crypto.randomUUID(), label: '', value: '' }])
  const removeField = (key: string): void => setFields((list) => list.filter((f) => f.key !== key))
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
      techStack: splitList(form.techStack),
      tags: splitList(form.tags),
      customFields: fields
        .filter((f) => f.label.trim() || f.value.trim())
        .map(({ label, value }) => ({ label, value }))
    }
    try {
      onSaved(
        project
          ? await window.vault.projects.update({ id: project.id, revision: project.revision, input })
          : await window.vault.projects.create(input)
      )
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Modal title={project ? 'Edit Project' : 'Add Project'} onClose={onCancel}>
      <form className="form" onSubmit={(e) => void submit(e)}>
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
        <div className="row">
          <label>
            Tech stack (comma separated)
            <input placeholder="Laravel, React" value={form.techStack} onChange={set('techStack')} />
          </label>
          <label>
            Tags (comma separated)
            <input value={form.tags} onChange={set('tags')} />
          </label>
        </div>
        <fieldset className="extras">
          <legend>Custom fields</legend>
          {fields.length === 0 && (
            <p className="hint">Add any detail this form does not have, e.g. Client phone, cPanel username, Renewal date.</p>
          )}
          {fields.map((f, i) => (
            <div className="input-row" key={f.key}>
              <input
                aria-label={`Field ${i + 1} name`}
                placeholder="Field name"
                maxLength={100}
                list="custom-field-names"
                value={f.label}
                onChange={(e) => setField(f.key, 'label', e.target.value)}
              />
              <input
                aria-label={`Field ${i + 1} value`}
                placeholder="Value"
                maxLength={2000}
                value={f.value}
                onChange={(e) => setField(f.key, 'value', e.target.value)}
              />
              <button type="button" aria-label={`Remove field ${i + 1}`} onClick={() => removeField(f.key)}>
                Remove
              </button>
            </div>
          ))}
          <datalist id="custom-field-names">
            {knownLabels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <button type="button" onClick={addField} disabled={fields.length >= 50}>
            + Add field
          </button>
        </fieldset>
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
    </Modal>
  )
}
