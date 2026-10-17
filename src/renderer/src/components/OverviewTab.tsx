import { useState, type FormEvent } from 'react'
import type { Project } from '../../../shared/types'
import { errorText, formatDate } from '../lib'
import { ExternalLink } from './ExternalLink'
import { Modal } from './Modal'
import { ProjectForm } from './ProjectForm'

/** Shows a custom field; a value that is a plain web link opens in the browser. */
function FieldRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const isLink = /^https?:\/\/\S+$/i.test(value)
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ? isLink ? <ExternalLink url={value} /> : value : '—'}</dd>
    </>
  )
}

export function OverviewTab({
  project,
  onChanged,
  onDeleted
}: {
  project: Project
  onChanged: (project: Project) => void
  onDeleted: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggleArchive(): Promise<void> {
    if (!project.archivedAt && !confirm('Archive this project? It will be hidden from the dashboard; nothing is deleted.')) return
    try {
      onChanged(await (project.archivedAt ? window.vault.projects.restore(project.id) : window.vault.projects.archive(project.id)))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const url = (value: string | null): React.ReactNode => (value ? <ExternalLink url={value} /> : '—')
  const text = (value: string | null): React.ReactNode => value || '—'

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Overview</h2>
        <div className="actions">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button onClick={() => void toggleArchive()}>{project.archivedAt ? 'Restore' : 'Archive'}</button>
          <button className="danger" onClick={() => setDeleting(true)}>
            Delete
          </button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {project.description && <p>{project.description}</p>}
      <dl className="facts">
        <dt>Type</dt>
        <dd>{text(project.type)}</dd>
        <dt>Live website</dt>
        <dd>{url(project.websiteUrl)}</dd>
        <dt>Admin URL</dt>
        <dd>{url(project.adminUrl)}</dd>
        <dt>Hosting</dt>
        <dd>{text(project.hostingName)}</dd>
        <dt>Domain provider</dt>
        <dd>{text(project.domainProvider)}</dd>
        <dt>Repository</dt>
        <dd>{url(project.repositoryUrl)}</dd>
        <dt>Developer</dt>
        <dd>{text(project.developerName)}</dd>
        <dt>Tech stack</dt>
        <dd>{project.techStack.join(', ') || '—'}</dd>
        <dt>Tags</dt>
        <dd>{project.tags.join(', ') || '—'}</dd>
        {project.customFields.map((f, i) => (
          <FieldRow key={i} label={f.label} value={f.value} />
        ))}
        <dt>Created</dt>
        <dd>{formatDate(project.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(project.updatedAt)}</dd>
      </dl>
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
      {editing && (
        <ProjectForm
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={(p) => {
            setEditing(false)
            onChanged(p)
          }}
        />
      )}
    </section>
  )
}

/** Permanent delete, guarded by typing the project name. Archive is the reversible alternative. */
function DeleteProjectDialog({
  project,
  onClose,
  onDeleted
}: {
  project: Project
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await window.vault.projects.delete(project.id)
      onDeleted()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Delete project" onClose={busy ? () => undefined : onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <p>
          This permanently deletes <strong>{project.name}</strong> with all its credentials, documents, notes and links. It
          cannot be undone, except by restoring a backup. To only hide it from the dashboard, use Archive instead.
        </p>
        <label>
          Type the project name to confirm
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project.name} />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary danger-fill" disabled={busy || typed.trim() !== project.name}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
