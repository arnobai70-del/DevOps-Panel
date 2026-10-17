import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import { ProjectCard } from '../components/ProjectCard'
import { ProjectForm } from '../components/ProjectForm'

export function Dashboard(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (query: string) => {
    try {
      setProjects(await window.vault.projects.list({ search: query || undefined }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(search), 150)
    return () => clearTimeout(t)
  }, [search, load])

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
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}

      {adding && (
        <ProjectForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            void load(search)
          }}
        />
      )}
    </div>
  )
}
