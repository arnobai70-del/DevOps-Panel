import { useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'

type Page = 'dashboard' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'settings', label: 'Settings' }
]

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Agency Project Vault</div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item${page === item.id ? ' active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">{page === 'dashboard' ? <Dashboard /> : <Settings />}</main>
    </div>
  )
}
