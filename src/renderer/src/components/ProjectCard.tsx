import type { Project } from '../../../shared/types'
import { formatDate } from '../lib'
import { ExternalLink } from './ExternalLink'

export function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }): React.JSX.Element {
  return (
    <article
      className={`card clickable${project.archivedAt ? ' archived' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="card-head">
        <h3>{project.name}</h3>
        <span className={`badge status-${project.status}`}>{project.archivedAt ? 'archived' : project.status}</span>
      </div>
      {project.description && <p className="muted clamp">{project.description}</p>}
      {project.websiteUrl && <ExternalLink url={project.websiteUrl} />}
      {project.techStack.length > 0 && (
        <div className="chips">
          {project.techStack.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="card-foot muted">Updated {formatDate(project.updatedAt)}</div>
    </article>
  )
}
