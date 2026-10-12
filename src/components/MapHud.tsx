import type { LatLng, RouteModeId, RouteProgress } from '@/lib/types'
import { ROUTE_MODES } from '@/lib/types'
import { formatDistance } from '@/lib/route'
import { Badge, Dot, Icon } from './ui'
import Joystick from './Joystick'

/**
 * Heads-up display over the map, and the stick that walks the mock.
 *
 * On a phone the map is most of the screen, so the answer to "where am I / how
 * fast / how far to go" belongs on the map rather than in a panel the user has
 * to scroll back to. The dock folds into that HUD: one tap opens the joystick,
 * so the mock can be walked by hand while the dot it moves stays in view —
 * which is the whole point of steering a simulated position.
 */
export default function MapHud({
  running,
  route,
  position,
  mode,
  speedKmh,
  plannedMetres,
  controlsOpen,
  onOpenControls,
  onCloseControls,
  onRecenter,
  onStop,
  busy,
  onSteer,
  onSteerRelease,
}: {
  /** True while the phone is actually publishing a position. */
  running: boolean
  route: RouteProgress | null
  position: LatLng | null
  mode: RouteModeId
  /** The speed the next route would play at, which seeds the stick's pace. */
  speedKmh: number
  /** Planned length of the route waiting to be played, in metres. */
  plannedMetres: number
  /** Whether the steering dock is open. */
  controlsOpen: boolean
  onOpenControls: () => void
  onCloseControls: () => void
  onRecenter: () => void
  onStop: () => void
  busy: boolean
  /** Walks the mock position: metres north/east for this step of the walk. */
  onSteer: (northMetres: number, eastMetres: number) => void
  /** The finger left the stick. */
  onSteerRelease: () => void
}) {
  const active = route?.active === true
  const total = route?.totalMetres && route.totalMetres > 0 ? route.totalMetres : plannedMetres
  const travelled = route?.travelledMetres ?? 0
  const percent = total > 0 ? Math.min(100, (travelled / total) * 100) : 0
  const remaining = Math.max(0, total - travelled)
  const modeMeta = ROUTE_MODES.find((item) => item.id === mode) ?? ROUTE_MODES[0]

  // Ring geometry: r=18 in a 44px box.
  const circumference = 2 * Math.PI * 18

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-[900] flex flex-col items-start gap-2">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-2.5 shadow-[var(--shadow-lg)] backdrop-blur">
        <span className="relative grid h-11 w-11 shrink-0 place-items-center">
          <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90">
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--border)" strokeWidth="3" />
            <circle
              cx="22"
              cy="22"
              r="18"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - percent / 100)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
          <Icon name={modeMeta.icon} className="relative h-4.5 w-4.5 text-[var(--accent)]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {/* "Publishing" is a claim about the phone, so it is only made when
                the service is actually running. */}
            <Badge tone={running ? 'success' : 'neutral'}>
              <Dot active={running} />
              {route?.finished ? 'Arrived' : !running ? 'Idle' : active ? 'Simulating' : 'Publishing'}
            </Badge>
            {running ? (
              <span className="text-[11px] font-semibold tabular-nums text-[var(--text)]">
                {(route?.speedKmh ?? 0).toFixed(0)} km/h
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
            {!running
              ? 'Nothing is publishing yet'
              : active
                ? `${percent.toFixed(0)}% · ${formatDistance(remaining)} to go`
                : 'Holding this exact spot'}
          </p>
        </div>

        <div className="pointer-events-auto ml-1 flex items-center gap-1">
          <button
            type="button"
            onClick={controlsOpen ? onCloseControls : onOpenControls}
            aria-pressed={controlsOpen}
            aria-label="Walk the mock position with the stick"
            className={`rounded-lg p-2 transition-colors ${
              controlsOpen
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--accent)]'
            }`}
          >
            <Icon name="pulse" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRecenter}
            aria-label="Centre the map on the live position"
            className="rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)]"
          >
            <Icon name="locate" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop the mock location"
            className="rounded-lg bg-[var(--danger-soft)] p-2 text-[var(--danger)] transition-colors hover:brightness-95"
          >
            <Icon name="stop" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* The dock is deliberately short: the map under it is only a few hundred
          pixels tall on a phone, and a stick whose bottom half is hidden behind
          the panels is a stick the user cannot use. */}
      {controlsOpen ? (
        <div className="pointer-events-auto ml-1 w-[calc(100vw-1.5rem)] max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)]/95 p-2.5 shadow-[var(--shadow-lg)] backdrop-blur">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              Walk the mock
            </p>
            <button
              type="button"
              onClick={onCloseControls}
              aria-label="Close the stick"
              className="rounded-lg p-1 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>

          {!position ? (
            <p className="px-1 py-3 text-center text-[11px] leading-relaxed text-[var(--text-muted)]">
              Drop a pin on the map first — the stick walks that spot.
            </p>
          ) : (
            <>
              <Joystick
                disabled={busy || !running}
                defaultSpeedKmh={speedKmh}
                onWalk={onSteer}
                onRelease={onSteerRelease}
              />
              {!running ? (
                <p className="text-center text-[10px] text-[var(--text-subtle)]">
                  Start the mock location — then the stick walks it.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
