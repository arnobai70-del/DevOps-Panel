/** Opens http(s) links in the system browser; the main process re-validates the scheme. */
export function ExternalLink({ url, label }: { url: string; label?: string }): React.JSX.Element {
  return (
    <a
      className="link"
      href={url}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void window.vault.app.openExternal(url)
      }}
    >
      {label ?? url}
    </a>
  )
}
