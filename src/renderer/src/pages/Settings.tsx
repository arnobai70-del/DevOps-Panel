import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../shared/types'

export function Settings(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.vault.app.info().then(setInfo)
  }, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <section className="panel">
        <h2>Storage</h2>
        <dl className="facts">
          <dt>Mode</dt>
          <dd>Personal Local (data stays on this PC)</dd>
          <dt>Data folder</dt>
          <dd className="mono">{info?.dataDir ?? '…'}</dd>
          <dt>Version</dt>
          <dd>{info?.version ?? '…'}</dd>
        </dl>
      </section>
    </div>
  )
}
