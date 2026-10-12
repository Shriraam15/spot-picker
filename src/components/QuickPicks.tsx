import { useRef, useState } from 'react'
import type { Favorite, LatLng } from '@/lib/types'
import type { RecentSearch } from '@/lib/recent-searches'
import { Card, CardHeader, Icon } from './ui'
import { formatDistance, distanceMetres } from '@/lib/route'
import { tap } from '@/lib/haptics'

type Props = {
  favorites: Favorite[]
  recentSearches: RecentSearch[]
  /** The spot currently picked, so a chip can say how far away it is. */
  position: LatLng | null
  /** True when the spot is already saved, so the save chip is not offered twice. */
  isSaved: boolean
  /** Whether this device can save (the web preview can too, but the label differs). */
  onSaveCurrent: () => void
  onJump: (position: LatLng) => void
  /** Long-press a chip to add it to the route instead of jumping to it. */
  onAddToRoute: (position: LatLng, name: string) => void
}

/** How long a chip must be held to mean "add to route" rather than "go there". */
const LONG_PRESS_MS = 480

/**
 * One-tap access to the places that matter.
 *
 * The full lists live on their own pages; this strip exists because the most
 * common thing anyone does with a mock location is jump back to the same few
 * places. Tapping goes there, holding adds it to the route — the same gestures
 * the rest of the app uses, and both announce themselves with a haptic tick.
 */
export default function QuickPicks({
  favorites,
  recentSearches,
  position,
  isSaved,
  onSaveCurrent,
  onJump,
  onAddToRoute,
}: Props) {
  const [held, setHeld] = useState<string | null>(null)
  const holdTimer = useRef<number | null>(null)
  /**
   * The chip whose long press already ran. A long press is followed by a click
   * event, so without this the same gesture would both add the place to the
   * route and jump the map to it.
   */
  const actedRef = useRef<string | null>(null)

  const clearHold = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    setHeld(null)
  }

  const beginHold = (id: string, action: () => void) => {
    clearHold()
    actedRef.current = null
    setHeld(id)
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      setHeld(null)
      actedRef.current = id
      tap([8, 20, 8])
      action()
    }, LONG_PRESS_MS)
  }

  /** True once for the click that follows a long press, then forgotten. */
  const consumeLongPress = (id: string): boolean => {
    if (actedRef.current !== id) return false
    actedRef.current = null
    return true
  }

  /** A recent place that has not also been saved — no duplicate chips. */
  const recents = recentSearches
    .map((item) => ({ item, point: { lat: item.place.lat, lon: item.place.lon } }))
    .filter(
      ({ point }) =>
        !favorites.some(
          (favorite) => Math.abs(favorite.lat - point.lat) < 1e-7 && Math.abs(favorite.lon - point.lon) < 1e-7,
        ),
    )
    .slice(0, 6)

  const empty = favorites.length === 0 && recents.length === 0 && !position

  return (
    <Card>
      <CardHeader
        title="Quick picks"
        hint={
          favorites.length > 0 || recents.length > 0
            ? 'Tap to jump · hold to add to the route'
            : 'Saved spots and places you visit often live here'
        }
        action={
          position && !isSaved ? (
            <button
              type="button"
              onClick={() => {
                tap(6)
                onSaveCurrent()
              }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
            >
              <Icon name="star" className="h-3.5 w-3.5" />
              Save this spot
            </button>
          ) : null
        }
      />

      <div className="px-4 pb-4">
        {empty ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-5 text-center">
            <Icon name="star" className="mx-auto mb-1.5 h-6 w-6 text-[var(--text-subtle)]" />
            <p className="text-xs text-[var(--text-muted)]">
              Save a spot and it appears here, one tap away.
            </p>
          </div>
        ) : (
          <div className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
            {position && !isSaved ? (
              <button
                type="button"
                onClick={() => {
                  tap(6)
                  onSaveCurrent()
                }}
                className="snap-start shrink-0 rounded-xl border border-dashed border-[var(--accent)] px-3 py-2 text-left transition-colors hover:bg-[var(--accent-soft)]"
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)]">
                  <Icon name="plus" className="h-3.5 w-3.5" />
                  Save this spot
                </span>
                <span className="block text-[10px] text-[var(--text-subtle)]">
                  {position.lat.toFixed(4)}, {position.lon.toFixed(4)}
                </span>
              </button>
            ) : null}

            {favorites.map((favorite) => {
              const point = { lat: favorite.lat, lon: favorite.lon }
              const away = position ? distanceMetres(position, point) : null
              return (
                <button
                  key={favorite.id}
                  type="button"
                  aria-label={`${favorite.name}, ${held === favorite.id ? 'adding to route' : 'tap to jump, hold to add to route'}`}
                  onPointerDown={() => beginHold(favorite.id, () => onAddToRoute(point, favorite.name))}
                  onPointerUp={clearHold}
                  onPointerLeave={clearHold}
                  onPointerCancel={clearHold}
                  onContextMenu={(event) => event.preventDefault()}
                  onClick={() => {
                    // A long press already acted; the click that follows is ignored.
                    if (consumeLongPress(favorite.id) || held === favorite.id) return
                    tap(8)
                    onJump(point)
                  }}
                  className={`snap-start shrink-0 rounded-xl border px-3 py-2 text-left transition-all active:scale-95 ${
                    held === favorite.id
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text)]">
                    <Icon name="starFilled" className="h-3.5 w-3.5 text-[var(--accent)]" />
                    <span className="max-w-[9rem] truncate">{favorite.name}</span>
                  </span>
                  <span className="block text-[10px] text-[var(--text-subtle)]">
                    {away !== null
                      ? `${formatDistance(away)} away`
                      : `${favorite.lat.toFixed(4)}, ${favorite.lon.toFixed(4)}`}
                  </span>
                </button>
              )
            })}

            {recents.map(({ item, point }) => (
              <button
                key={`recent-${item.timestamp}`}
                type="button"
                aria-label={`${item.place.name}, recently searched`}
                onPointerDown={() => beginHold(`recent-${item.timestamp}`, () => onAddToRoute(point, item.place.name))}
                onPointerUp={clearHold}
                onPointerLeave={clearHold}
                onPointerCancel={clearHold}
                onClick={() => {
                  if (consumeLongPress(`recent-${item.timestamp}`) || held === `recent-${item.timestamp}`) return
                  tap(8)
                  onJump(point)
                }}
                className={`snap-start shrink-0 rounded-xl border px-3 py-2 text-left transition-all active:scale-95 ${
                  held === `recent-${item.timestamp}`
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text)]">
                  <Icon name="history" className="h-3.5 w-3.5 text-[var(--text-subtle)]" />
                  <span className="max-w-[9rem] truncate">{item.place.name}</span>
                </span>
                <span className="block text-[10px] text-[var(--text-subtle)]">
                  {item.place.displayName.slice(0, 34)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
