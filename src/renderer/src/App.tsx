import { useEffect, useState } from 'react'
import { SignInScreen, signInSkipped, SyncBadge } from './components/GoogleSync'
import { Dashboard } from './pages/Dashboard'
import { ProjectDetail } from './pages/ProjectDetail'
import { Settings } from './pages/Settings'

type Route = { page: 'dashboard' } | { page: 'settings' } | { page: 'project'; projectId: string }

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ page: 'dashboard' })
  // A PC that is not signed in starts on the Google sign-in screen.
  const [needsSignIn, setNeedsSignIn] = useState<boolean | null>(null)
  useEffect(() => {
    void window.vault.team.status().then(
      (status) => setNeedsSignIn((status.role === 'personal' || status.role === 'folder') && !signInSkipped()),
      () => setNeedsSignIn(false)
    )
  }, [])

  const nav = (page: 'dashboard' | 'settings', label: string): React.JSX.Element => (
    <button
      className={`nav-item${route.page === page || (page === 'dashboard' && route.page === 'project') ? ' active' : ''}`}
      onClick={() => setRoute({ page })}
    >
      {label}
    </button>
  )

  if (needsSignIn === null) return <div className="welcome" />
  if (needsSignIn) return <SignInScreen onSkip={() => setNeedsSignIn(false)} />

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Agency Project Vault</div>
        <nav>
          {nav('dashboard', 'Dashboard')}
          {nav('settings', 'Settings')}
        </nav>
        <SyncBadge />
      </aside>
      <main className="content">
        {route.page === 'dashboard' && <Dashboard onOpen={(projectId) => setRoute({ page: 'project', projectId })} onSettings={() => setRoute({ page: 'settings' })} />}
        {route.page === 'project' && (
          <ProjectDetail projectId={route.projectId} onBack={() => setRoute({ page: 'dashboard' })} />
        )}
        {route.page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
