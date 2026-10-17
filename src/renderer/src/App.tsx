import { useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { ProjectDetail } from './pages/ProjectDetail'
import { Settings } from './pages/Settings'

type Route = { page: 'dashboard' } | { page: 'settings' } | { page: 'project'; projectId: string }

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ page: 'dashboard' })

  const nav = (page: 'dashboard' | 'settings', label: string): React.JSX.Element => (
    <button
      className={`nav-item${route.page === page || (page === 'dashboard' && route.page === 'project') ? ' active' : ''}`}
      onClick={() => setRoute({ page })}
    >
      {label}
    </button>
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Agency Project Vault</div>
        <nav>
          {nav('dashboard', 'Dashboard')}
          {nav('settings', 'Settings')}
        </nav>
      </aside>
      <main className="content">
        {route.page === 'dashboard' && <Dashboard onOpen={(projectId) => setRoute({ page: 'project', projectId })} />}
        {route.page === 'project' && (
          <ProjectDetail projectId={route.projectId} onBack={() => setRoute({ page: 'dashboard' })} />
        )}
        {route.page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
