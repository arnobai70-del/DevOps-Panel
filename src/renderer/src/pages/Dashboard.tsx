import { useCallback, useEffect, useState } from 'react'
import type { BackupStatus, Project } from '../../../shared/types'
import { ProjectCard } from '../components/ProjectCard'
import { ProjectForm } from '../components/ProjectForm'
import { errorText } from '../lib'

const REMIND_AFTER_DAYS = 7

function backupReminder(status: BackupStatus | null): string | null {
  if (!status?.hasData) return null
  if (!status.lastBackupAt) return 'This vault has never been backed up.'
  const days = Math.floor((Date.now() - new Date(status.lastBackupAt).getTime()) / 86_400_000)
  return days >= REMIND_AFTER_DAYS ? `Last backup was ${days} days ago.` : null
}

export function Dashboard({
  onOpen,
  onSettings
}: {
  onOpen: (projectId: string) => void
  onSettings: () => void
}): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [teamProblem, setTeamProblem] = useState<string | null>(null)

  useEffect(() => {
    void window.vault.team.status().then(
      (team) => {
        if (team.role === 'client') {
          setTeamProblem(team.error)
        } else {
          window.vault.backups.status().then(setBackup, () => setBackup(null))
        }
      },
      () => undefined
    )
  }, [])
  const reminder = backupReminder(backup)

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

  // Teammates' projects show up as soon as folder sync brings them in.
  useEffect(() => window.vault.app.onRemoteChange(() => void load(search, showArchived)), [search, showArchived, load])

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

      {teamProblem && <div className="error-banner">{teamProblem}</div>}
      {!teamProblem && error && <div className="error-banner">{error}</div>}
      {reminder && (
        <div className="notice reminder">
          <span>{reminder} Keep an encrypted copy on another drive.</span>
          <button onClick={onSettings}>Back up now</button>
        </div>
      )}

      {projects === null ? (
        !error && !teamProblem && <p className="muted">Loading…</p>
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
