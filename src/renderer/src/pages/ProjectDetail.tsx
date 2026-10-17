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
  // Teammates' changes arrive in the background; refreshing remounts the tab with fresh data.
  const [remoteChange, setRemoteChange] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => window.vault.app.onRemoteChange(() => setRemoteChange(true)), [])
  const refresh = (): void => {
    setRemoteChange(false)
    setGeneration((g) => g + 1)
    void reload()
  }

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
      {remoteChange && (
        <div className="notice reminder">
          <span>Your team made changes. Refresh to see them.</span>
          <button onClick={refresh}>Refresh</button>
        </div>
      )}
      <div className="tabs" role="tablist" key={generation}>
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
      {tab === 'overview' && <OverviewTab key={generation} project={project} onChanged={setProject} onDeleted={onBack} />}
      {tab === 'credentials' && <CredentialsTab key={generation} projectId={project.id} />}
      {tab === 'documents' && <DocumentsTab key={generation} projectId={project.id} />}
      {tab === 'notes' && <NotesLinksTab key={generation} projectId={project.id} />}
    </div>
  )
}
