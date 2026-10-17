import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import { ProjectCard } from '../components/ProjectCard'
import { ProjectForm } from '../components/ProjectForm'
import { errorText } from '../lib'

export function Dashboard({ onOpen }: { onOpen: (projectId: string) => void }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (query: string, includeArchived: boolean) => {
    try {
      setProjects(await window.vault.projects.list({ search: query || undefined, includeArchived }))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(search, showArchived), 150)
    return () => clearTimeout(t)
  }, [search, showArchived, load])

  return (
    <div className="page">
      <header className="page-header">
        <h1>All Projects</h1>
        <input
          className="search"
          type="search"
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search projects"
        />
        <label className="toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <button className="primary" onClick={() => setAdding(true)}>
          + Add Project
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="empty">
          <h2>{search ? 'No matching projects' : 'No projects yet'}</h2>
          {!search && (
            <button className="primary large" onClick={() => setAdding(true)}>
              + Add Project
            </button>
          )}
        </div>
      ) : (
        <div className="grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => onOpen(p.id)} />
          ))}
        </div>
      )}

      {adding && (
        <ProjectForm
          onCancel={() => setAdding(false)}
          onSaved={(project) => {
            setAdding(false)
            onOpen(project.id)
          }}
        />
      )}
    </div>
  )
}
