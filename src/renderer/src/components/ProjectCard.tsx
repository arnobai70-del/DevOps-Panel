import type { Project } from '../../../shared/types'

export function ProjectCard({ project }: { project: Project }): React.JSX.Element {
  return (
    <article className="card">
      <div className="card-head">
        <h3>{project.name}</h3>
        <span className={`badge status-${project.status}`}>{project.status}</span>
      </div>
      {project.description && <p className="muted clamp">{project.description}</p>}
      {project.websiteUrl && (
        <a className="link" href={project.websiteUrl} target="_blank" rel="noreferrer">
          {project.websiteUrl}
        </a>
      )}
      {project.techStack.length > 0 && (
        <div className="chips">
          {project.techStack.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="card-foot muted">Updated {new Date(project.updatedAt).toLocaleDateString()}</div>
    </article>
  )
}
