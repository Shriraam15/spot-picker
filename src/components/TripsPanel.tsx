import { Button, Card, CardHeader, Icon } from './ui'
import { ROUTE_MODES } from '@/lib/types'
import { tripAverageKmh, tripSeconds, type Trip } from '@/lib/trips'
import { formatDistance, formatDuration } from '@/lib/route'
import { formatLatLng } from '@/lib/format'

type Props = {
  trips: Trip[]
  /** Loads the trip's path into the route editor without starting it. */
  onLoad: (trip: Trip) => void
  /** Loads and plays the trip again, exactly as it was. */
  onPlay: (trip: Trip) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}

/** "Today 14:03" reads better on a phone than a full date. */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `Today ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) return `Yesterday ${time}`
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/**
 * The journeys that have been played.
 *
 * A simulated route used to disappear the moment it ended. Keeping it means the
 * same walk can be repeated tomorrow in one tap, which is the difference
 * between a toy and something used every day — and the numbers (distance
 * actually covered, real duration, average speed) are the phone's own, not
 * estimates.
 */
export default function TripsPanel({ trips, onLoad, onPlay, onRemove, onClearAll }: Props) {
  if (trips.length === 0) {
    return (
      <Card>
        <CardHeader title="Trip log" hint="Every simulated journey is kept here" />
        <div className="px-4 pb-4">
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-6 text-center">
            <Icon name="history" className="mx-auto mb-2 h-7 w-7 text-[var(--text-subtle)]" />
            <p className="text-sm text-[var(--text-muted)]">No trips yet</p>
            <p className="mt-1 text-xs text-[var(--text-subtle)]">
              Start a route and it lands here — ready to replay in one tap.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Trip log"
        hint={`${trips.length} journey${trips.length !== 1 ? 's' : ''} recorded on this device`}
        action={
          <button
            type="button"
            onClick={onClearAll}
            className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]"
          >
            Clear all
          </button>
        }
      />

      <div className="space-y-2 px-4 pb-4">
        {trips.map((trip) => {
          const mode = ROUTE_MODES.find((item) => item.id === trip.mode) ?? ROUTE_MODES[0]
          const finished = trip.finishedAt !== null
          const percent =
            trip.plannedMetres > 0
              ? Math.min(100, (trip.travelledMetres / trip.plannedMetres) * 100)
              : 0
          return (
            <div
              key={trip.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 transition-colors hover:border-[var(--border-strong)]"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Icon name={mode.icon} className="h-4.5 w-4.5" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-medium text-[var(--text)]">
                      {trip.label}
                    </p>
                    <span className="shrink-0 text-[10px] text-[var(--text-subtle)]">
                      {formatWhen(trip.startedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                    {mode.label} · {formatDistance(trip.travelledMetres || trip.plannedMetres)}
                    {finished
                      ? ` · ${formatDuration(tripSeconds(trip))} · ${tripAverageKmh(trip).toFixed(1)} km/h avg`
                      : ' · stopped early'}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] tabular-nums text-[var(--text-subtle)]">
                    {formatLatLng(trip.waypoints[0])}
                  </p>

                  {finished ? (
                    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--surface)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]/70"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-2.5 flex items-center gap-1.5">
                <Button variant="primary" size="sm" onClick={() => onPlay(trip)}>
                  <Icon name="play" className="h-3 w-3" />
                  Replay
                </Button>
                <Button variant="secondary" size="sm" onClick={() => onLoad(trip)}>
                  <Icon name="route" className="h-3 w-3" />
                  Load route
                </Button>
                <button
                  type="button"
                  onClick={() => onRemove(trip.id)}
                  aria-label={`Delete ${trip.label}`}
                  className="ml-auto rounded-lg p-2 text-[var(--text-subtle)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
