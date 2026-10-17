import { useState } from 'react'
import type { Project } from '../../../shared/types'
import { errorText, formatDate } from '../lib'
import { ExternalLink } from './ExternalLink'
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
  onChanged
}: {
  project: Project
  onChanged: (project: Project) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
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
