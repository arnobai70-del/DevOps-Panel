import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Link, Note } from '../../../shared/types'
import { errorText, formatDate } from '../lib'
import { ExternalLink } from './ExternalLink'

export function NotesLinksTab({ projectId }: { projectId: string }): React.JSX.Element {
  return (
    <div className="two-col">
      <Notes projectId={projectId} />
      <Links projectId={projectId} />
    </div>
  )
}

function Notes({ projectId }: { projectId: string }): React.JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setNotes(await window.vault.notes.list(projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function add(): Promise<void> {
    try {
      await window.vault.notes.save({ projectId, title: 'New note', body: '' })
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Notes</h2>
        <button onClick={() => void add()}>+ Add Note</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notes.length === 0 && <p className="muted">No notes yet.</p>}
      {notes.map((n) => (
        <NoteEditor key={n.id} note={n} onChanged={load} />
      ))}
    </section>
  )
}

function NoteEditor({ note, onChanged }: { note: Note; onChanged: () => Promise<void> }): React.JSX.Element {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = title !== note.title || body !== note.body

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await window.vault.notes.save({ id: note.id, revision: note.revision, projectId: note.projectId, title, body })
      setError(null)
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    if (!confirm(`Delete note "${note.title}"?`)) return
    try {
      await window.vault.notes.remove(note.id)
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="note">
      <input className="note-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" />
      <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note text" />
      {error && <div className="error-banner">{error}</div>}
      <div className="note-foot">
        <span className="muted small-text">{dirty ? 'Unsaved changes' : `Saved ${formatDate(note.updatedAt)}`}</span>
        <div className="actions">
          <button className="danger" onClick={() => void remove()}>
            Delete
          </button>
          <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Links({ projectId }: { projectId: string }): React.JSX.Element {
  const [links, setLinks] = useState<Link[]>([])
  const [form, setForm] = useState({ label: '', url: '', purpose: '' })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLinks(await window.vault.links.list(projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault()
    try {
      await window.vault.links.save({ projectId, ...form })
      setForm({ label: '', url: '', purpose: '' })
      setError(null)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function remove(link: Link): Promise<void> {
    try {
      await window.vault.links.remove(link.id)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Links</h2>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ul className="links">
        {links.map((l) => (
          <li key={l.id}>
            <div>
              <ExternalLink url={l.url} label={l.label} />
              {l.purpose && <div className="muted small-text">{l.purpose}</div>}
            </div>
            <button className="ghost" aria-label={`Delete ${l.label}`} onClick={() => void remove(l)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form className="form compact" onSubmit={(e) => void add(e)}>
        <input required placeholder="Label" maxLength={150} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        <input required type="url" placeholder="https://…" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
        <input placeholder="Purpose (optional)" maxLength={500} value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} />
        <button type="submit">+ Add Link</button>
      </form>
    </section>
  )
}
