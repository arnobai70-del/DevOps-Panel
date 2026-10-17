import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import { CredentialsTab } from '../components/CredentialsTab'
import { DocumentsTab } from '../components/DocumentsTab'
import { NotesLinksTab } from '../components/NotesLinksTab'
import { OverviewTab } from '../components/OverviewTab'
import { errorText } from '../lib'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'documents', label: 'Documents' },
  { id: 'notes', label: 'Notes & Links' }
] as const
type Tab = (typeof TABS)[number]['id']

export function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }): React.JSX.Element {
  const [project, setProject] = useState<Project | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setProject(await window.vault.projects.get(projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) {
    return (
      <div className="page">
        <button onClick={onBack}>← Back</button>
        <div className="error-banner">{error}</div>
      </div>
    )
  }
  if (!project) return <div className="page muted">Loading…</div>

  return (
    <div className="page">
      <header className="page-header">
        <button className="ghost" onClick={onBack} aria-label="Back to projects">
          ←
        </button>
        <h1>{project.name}</h1>
        <span className="badge">{project.archivedAt ? 'archived' : project.status}</span>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <OverviewTab project={project} onChanged={setProject} />}
      {tab === 'credentials' && <CredentialsTab projectId={project.id} />}
      {tab === 'documents' && <DocumentsTab projectId={project.id} />}
      {tab === 'notes' && <NotesLinksTab projectId={project.id} />}
    </div>
  )
}
