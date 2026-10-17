import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { DOCUMENT_CATEGORIES } from '../../../shared/constants'
import type { DocumentMetadata, DocumentPreview, DocumentSummary, PickedFile } from '../../../shared/types'
import { errorText, formatBytes, formatDate, splitList } from '../lib'
import { Modal } from './Modal'

export function DocumentsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  const [editing, setEditing] = useState<DocumentSummary | 'new' | null>(null)
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDocs(await window.vault.documents.list(projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const run = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section>
      <div className="section-head">
        <p className="muted">Files are copied into the vault folder on this PC. Name and purpose are required.</p>
        <button className="primary" onClick={() => setEditing('new')}>
          + Upload
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {docs === null ? (
        <p className="muted">Loading…</p>
      ) : docs.length === 0 ? (
        <div className="empty small">No documents yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Purpose</th>
              <th>Category</th>
              <th>Size</th>
              <th>Version</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  <strong>{d.displayName}</strong>
                  <div className="muted small-text">{d.originalFilename}</div>
                </td>
                <td>{d.purpose}</td>
                <td>{d.category ?? '—'}</td>
                <td>{formatBytes(d.fileSize)}</td>
                <td>v{d.version}</td>
                <td>{formatDate(d.updatedAt)}</td>
                <td className="actions">
                  <button onClick={() => setPreviewing(d)}>Preview</button>
                  <button
                    onClick={run(async () => {
                      if (await window.vault.documents.exportFile(d.id)) setNotice(`Exported ${d.originalFilename}.`)
                    })}
                  >
                    Export
                  </button>
                  <button onClick={() => setEditing(d)}>Edit</button>
                  <button
                    className="danger"
                    onClick={run(async () => {
                      if (!confirm(`Delete "${d.displayName}"? The file is kept in the vault folder and can be recovered.`)) return
                      await window.vault.documents.remove(d.id)
                      await load()
                    })}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <DocumentForm
          projectId={projectId}
          doc={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
      {previewing && <PreviewModal doc={previewing} onClose={() => setPreviewing(null)} />}
    </section>
  )
}

function DocumentForm({
  projectId,
  doc,
  onCancel,
  onSaved
}: {
  projectId: string
  doc?: DocumentSummary
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [form, setForm] = useState({
    displayName: doc?.displayName ?? '',
    purpose: doc?.purpose ?? '',
    description: doc?.description ?? '',
    category: doc?.category ?? '',
    tags: doc?.tags.join(', ') ?? ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  async function pick(): Promise<void> {
    try {
      const picked = await window.vault.documents.pickFile()
      if (!picked) return
      setFile(picked)
      setForm((f) => (f.displayName ? f : { ...f, displayName: picked.filename.replace(/\.[^.]+$/, '') }))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!doc && !file) {
      setError('Choose a file first.')
      return
    }
    setSaving(true)
    setError(null)
    const metadata: DocumentMetadata = {
      ...form,
      category: (form.category || null) as DocumentMetadata['category'],
      tags: splitList(form.tags)
    }
    try {
      if (doc) await window.vault.documents.update({ id: doc.id, revision: doc.revision, metadata, fileToken: file?.token })
      else await window.vault.documents.create({ projectId, fileToken: file!.token, metadata })
      onSaved()
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Modal title={doc ? 'Edit Document' : 'Upload Document'} onClose={onCancel}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="file-pick">
          <button type="button" onClick={() => void pick()}>
            {doc ? 'Replace file…' : 'Choose file…'}
          </button>
          <span className="muted">
            {file
              ? `${file.filename} (${formatBytes(file.size)})${doc ? ', will be saved as a new version' : ''}`
              : doc
                ? `${doc.originalFilename} (v${doc.version})`
                : 'No file chosen (max 50 MB)'}
          </span>
        </div>
        <label>
          Document name *
          <input required maxLength={200} value={form.displayName} onChange={set('displayName')} />
        </label>
        <label>
          Purpose *
          <input required maxLength={500} placeholder="Why this document is kept" value={form.purpose} onChange={set('purpose')} />
        </label>
        <label>
          Description
          <textarea rows={3} maxLength={5000} value={form.description} onChange={set('description')} />
        </label>
        <div className="row">
          <label>
            Category
            <select value={form.category} onChange={set('category')}>
              <option value="">—</option>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tags (comma separated)
            <input value={form.tags} onChange={set('tags')} />
          </label>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PreviewModal({ doc, onClose }: { doc: DocumentSummary; onClose: () => void }): React.JSX.Element {
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.vault.documents.preview(doc.id).then(setPreview, (err: unknown) => setError(errorText(err)))
  }, [doc.id])

  async function openExternal(): Promise<void> {
    try {
      await window.vault.documents.openExternal(doc.id)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Modal title={doc.displayName} onClose={onClose} wide>
      <p className="muted">
        {doc.purpose}
        {doc.description ? ` · ${doc.description}` : ''}
      </p>
      {error && <div className="error-banner">{error}</div>}
      {preview?.kind === 'image' && <img className="preview-image" src={preview.dataUrl} alt={doc.displayName} />}
      {preview?.kind === 'text' && (
        <pre className="preview-text">
          {preview.text}
          {preview.truncated ? '\n\n… (truncated)' : ''}
        </pre>
      )}
      {preview?.kind === 'none' && <p className="muted">{preview.reason}</p>}
      <div className="actions">
        <button onClick={() => void openExternal()}>Open with default app</button>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
