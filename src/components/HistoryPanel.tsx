import { Card, CardHeader, Button, Icon } from './ui'
import { formatLatLng } from '@/lib/format'
import type { RecentSearch } from '@/lib/recent-searches'
import type { Favorite } from '@/lib/types'

type Props = {
  favorites: Favorite[]
  recentSearches: RecentSearch[]
  onRemoveRecent: (timestamp: number) => void
  onJumpTo: (position: { lat: number; lon: number }, zoom?: number) => void
  onAddToRoute: (position: { lat: number; lon: number }) => void
}

export default function HistoryPanel({
  favorites,
  recentSearches,
  onRemoveRecent,
  onJumpTo,
  onAddToRoute,
}: Props) {
  // Combine recent searches and favorites into one timeline
  const timelineItems = [
    ...recentSearches.slice(0, 8).map((item) => ({
      type: 'search' as const,
      timestamp: item.timestamp,
      name: item.place.name,
      displayName: item.place.displayName,
      position: { lat: item.place.lat, lon: item.place.lon },
    })),
    ...favorites.slice(0, 5).map((fav) => ({
      type: 'favorite' as const,
      timestamp: fav.createdAt,
      name: fav.name,
      displayName: formatLatLng({ lat: fav.lat, lon: fav.lon }),
      position: { lat: fav.lat, lon: fav.lon },
    })),
  ]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10)

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days < 7) return `${days}d ago`
    return date.toLocaleDateString()
  }

  if (timelineItems.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Recent Activity"
          hint="Places you've searched or saved recently"
        />
        <div className="px-4 pb-4">
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-6 text-center">
            <Icon name="search" className="h-8 w-8 mx-auto text-[var(--text-subtle)] mb-2" />
            <p className="text-sm text-[var(--text-muted)]">
              No recent activity yet
            </p>
            <p className="text-xs text-[var(--text-subtle)] mt-1">
              Search for places or save favorites to see them here
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Recent Activity"
        hint={`${timelineItems.length} recent item${timelineItems.length !== 1 ? 's' : ''}`}
      />
      <div className="px-4 pb-4">
        <div className="space-y-2">
          {timelineItems.map((item) => {
            const isFavorite = item.type === 'favorite'
            return (
              <div
                key={item.timestamp}
                className={`rounded-xl border transition-all ${
                  isFavorite
                    ? 'border-[var(--accent-soft)] bg-[var(--accent-soft)]/30'
                    : 'border-[var(--border)] bg-[var(--surface-2)]'
                }`}
              >
                <div className="flex items-start gap-3 px-3 py-2.5">
                  {/* Icon */}
                  <div
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                      isFavorite
                        ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                        : 'bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    <Icon
                      name={isFavorite ? 'starFilled' : 'search'}
                      className="h-4.5 w-4.5"
                    />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-[var(--text)]">
                        {item.name}
                      </p>
                      <span className="shrink-0 text-[10px] text-[var(--text-subtle)]">
                        {formatTime(item.timestamp)}
                      </span>
                    </div>
                    <p className="truncate text-xs text-[var(--text-muted)]">
                      {item.displayName}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1">
                    <button
                      onClick={() => onJumpTo(item.position, 14)}
                      className="rounded-lg p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                      title="Jump to location"
                    >
                      <Icon name="locate" className="h-3.5 w-3.5" />
                    </button>
                    {isFavorite && (
                      <button
                        onClick={() => onAddToRoute(item.position)}
                        className="rounded-lg p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                        title="Add to route"
                      >
                        <Icon name="plus" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {!isFavorite && (
                      <button
                        onClick={() => onRemoveRecent(item.timestamp)}
                        className="rounded-lg p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                        title="Remove from history"
                      >
                        <Icon name="close" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Quick action bar for favorites */}
                {isFavorite && (
                  <div className="ml-11 flex gap-2 px-3 pb-2.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onAddToRoute(item.position)}
                    >
                      <Icon name="plus" className="h-3 w-3" />
                      Add to route
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onJumpTo(item.position, 15)}
                    >
                      <Icon name="globe" className="h-3 w-3" />
                      View on map
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Show more button */}
        {recentSearches.length > 8 && (
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => {}}>
              <Icon name="settings" className="h-3.5 w-3.5" />
              View all history
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
