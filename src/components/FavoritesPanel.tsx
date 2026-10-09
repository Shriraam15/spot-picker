import { useState } from 'react'
import type { Favorite, LatLng } from '@/lib/types'
import { formatLatLng } from '@/lib/format'
import { Button, Card, CardHeader, Icon } from './ui'
import { exportFavorites, importFavorites } from '@/lib/favorites'

function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'absolute'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      document.execCommand('copy')
      document.body.removeChild(textarea)
      return Promise.resolve(true)
    } catch {
      document.body.removeChild(textarea)
      return Promise.resolve(false)
    }
  }
  return navigator.clipboard.writeText(text).then(() => true, () => false)
}

type Props = {
  favorites: Favorite[]
  position: LatLng | null
  /** Best-effort place name for the spot currently on the map. */
  suggestedName: string
  saving: boolean
  onSave: (name: string) => void
  onSelect: (favorite: Favorite) => void
  onRemove: (id: string) => void
  onSetFavorites: (favorites: Favorite[]) => void
}

/** Saved spots, persisted on the device only — nothing is uploaded anywhere. */
export default function FavoritesPanel({
  favorites,
  position,
  suggestedName,
  saving,
  onSave,
  onSelect,
  onRemove,
  onSetFavorites,
}: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [flash, setFlash] = useState<'export' | 'import-ok' | 'import-bad' | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!position) return
    // An empty name is resolved by the parent via reverse geocoding, which keeps
    // Nominatim traffic to one request per explicit save.
    onSave(name.trim())
    setName('')
    setOpen(false)
  }

  const handleExport = async () => {
    const ok = await copyToClipboard(exportFavorites(favorites))
    setFlash(ok ? 'export' : 'import-bad')
    setTimeout(() => setFlash(null), 1400)
  }

  const handleImport = () => {
    const text = prompt('Paste exported spots JSON here.')
    if (text === null) return
    const imported = importFavorites(text)
    onSetFavorites(imported)
    setFlash(imported.length > 0 ? 'import-ok' : 'import-bad')
    window.setTimeout(() => setFlash(null), 1400)
  }

  return (
    <Card>
      <CardHeader
        title="Saved spots"
        hint={position ? 'Keep places you return to often.' : 'Tap the map to choose a spot first.'}
        action={
          <span className="tabular rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
            {favorites.length}
          </span>
        }
      />

      <div className="px-4 pb-4">
        {position ? (
          open ? (
            <form onSubmit={submit} className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={suggestedName}
                maxLength={60}
                className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)]"
              />
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? 'Saving' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                onClick={() => {
                  setName('')
                  setOpen(true)
                }}
              >
                <Icon name="save" className="h-3.5 w-3.5" />
                Save this spot
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={favorites.length === 0}
                onClick={handleExport}
              >
                <Icon name="copy" className="h-3.5 w-3.5" />
                Export
              </Button>
            </div>
          )
        ) : null}

        {favorites.length > 0 ? (
          <ul className="mt-3 divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
            {favorites.map((favorite) => (
              <li key={favorite.id} className="group flex items-center gap-1 pr-1">
                <button
                  type="button"
                  onClick={() => onSelect(favorite)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                >
                  <span className="w-full truncate text-[13px] font-medium text-[var(--text)]">
                    {favorite.name}
                  </span>
                  <span className="tabular text-[11px] text-[var(--text-muted)]">
                    {formatLatLng(favorite)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${favorite.name}`}
                  onClick={() => onRemove(favorite.id)}
                  className="shrink-0 rounded-lg p-2 text-[var(--text-subtle)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-subtle)]">
            No saved spots yet.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={handleImport}
          >
            <Icon name="copy" className="h-3.5 w-3.5" />
            Import
          </Button>
          {flash === 'export' && (
            <span className="text-[11px] text-[var(--success)]">
              Copied.
            </span>
          )}
          {flash === 'import-ok' && (
            <span className="text-[11px] text-[var(--success)]">
              Imported {favorites.length} spot{favorites.length === 1 ? '' : 's'}.
            </span>
          )}
          {flash === 'import-bad' && (
            <span className="text-[11px] text-[var(--danger)]">
              Import failed — check the JSON.
            </span>
          )}
        </div>
      </div>
    </Card>
  )
}