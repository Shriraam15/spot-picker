import { useEffect, useMemo, useState } from 'react'
import type { LatLng, MockState, RouteModeId, RouteProgress } from '@/lib/types'
import { ROUTE_MODES } from '@/lib/types'
import { formatClock, formatDms, formatElapsed, formatEta, formatLatLng } from '@/lib/format'
import { formatDistance, durationSeconds } from '@/lib/route'
import { Badge, Button, Card, Dot, Icon } from './ui'

type Props = {
  mockState: MockState
  /** The pin the user picked on the map. */
  position: LatLng | null
  /** What the phone is publishing right now, when something is running. */
  livePosition: LatLng | null
  route: RouteProgress | null
  mode: RouteModeId
  /** The speed the user would play the next route at. */
  plannedSpeedKmh: number
  /** Planned length of the route waiting to be played, in metres. */
  plannedMetres: number
  /** When the current run started, for the elapsed clock. Null when idle. */
  startedAt: number | null
  follow: boolean
  busy: boolean
  /** True when at least two endpoints are picked, so a route can be played. */
  hasRoute: boolean
  onStart: () => void
  onStop: () => void
  onToggleFollow: () => void
  /** Walk a closed loop of this radius around the current spot. */
  onCircle: (radiusMetres: number) => void
  onOpenMaps: () => void
  onCopy: () => void
  /** Fix a refused start: Developer options, or About phone first. */
  onFix: () => void
  /** Open the stick that walks the mock, docked over the map. */
  onOpenControls: () => void
}

/** Patrol radii offered, in metres. Short enough to stay believable. */
const RADII = [100, 250, 500] as const

/**
 * The live cockpit.
 *
 * This is the screen a mocked position actually needs: what is being published
 * right now, how fast, how far it has come, how long it has been running and
 * when it will arrive — all counting up in real time rather than waiting for a
 * refresh. Everything on it is derived from the service's own progress report,
 * so the numbers are the phone's, not the page's imagination.
 */
export default function LiveDashboard({
  mockState,
  position,
  livePosition,
  route,
  mode,
  plannedSpeedKmh,
  plannedMetres,
  startedAt,
  follow,
  busy,
  hasRoute,
  onStart,
  onStop,
  onToggleFollow,
  onCircle,
  onOpenMaps,
  onCopy,
  onFix,
  onOpenControls,
}: Props) {
  // One tick a second: the clock and the elapsed timer are the whole point of
  // this card, and a simulated position is only convincing while its time moves.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const active = route?.active === true
  const running = mockState.running
  const total = route?.totalMetres && route.totalMetres > 0 ? route.totalMetres : plannedMetres
  const travelled = active ? (route?.travelledMetres ?? 0) : 0
  const remaining = Math.max(0, total - travelled)
  const percent = total > 0 ? Math.min(100, (travelled / total) * 100) : 0

  /** The speed shown: what the phone is doing, or what the next run will use. */
  const speed = active && (route?.speedKmh ?? 0) > 0.05 ? (route?.speedKmh ?? 0) : running ? (route?.speedKmh || plannedSpeedKmh) : plannedSpeedKmh

  const elapsedSeconds = startedAt ? Math.max(0, (now - startedAt) / 1000) : null
  const etaSeconds = speed > 0.05 && remaining > 0 ? durationSeconds(remaining, speed) : null

  /** The coordinate that matters: what the phone reports, else the pin. */
  const shown = (running && livePosition) || position
  const modeMeta = ROUTE_MODES.find((item) => item.id === mode) ?? ROUTE_MODES[0]

  const status = useMemo(() => {
    if (!mockState.available) return { label: 'Browser preview', tone: 'neutral' as const }
    if (running && active) return { label: route?.finished ? 'Arrived' : 'Simulating', tone: 'success' as const }
    if (running) return { label: 'Publishing', tone: 'success' as const }
    if (mockState.starting) return { label: 'Starting…', tone: 'accent' as const }
    if (mockState.appSelected && mockState.hasPermission) return { label: 'Ready', tone: 'neutral' as const }
    return { label: 'Setup needed', tone: 'danger' as const }
  }, [mockState, running, active, route?.finished])

  const copiedLabel = running ? 'Published position' : 'Selected spot'

  return (
    <Card className="overflow-hidden">
      {/* pass the controls through to the map heads-up display */}
      {/* ---- live header ---- */}
      <div className="relative flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-2)]/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge tone={status.tone === 'success' ? 'success' : status.tone === 'danger' ? 'danger' : 'neutral'}>
            <Dot active={running} />
            {status.label}
          </Badge>
          {active ? (
            <span className="text-[11px] font-medium text-[var(--text-muted)]">
              {percent.toFixed(0)}% of the route
            </span>
          ) : null}
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-semibold tabular-nums text-[var(--text)]">
            {formatClock(new Date(now))}
          </p>
          <p className="text-[10px] tracking-wide text-[var(--text-subtle)] uppercase">
            {running ? 'Publishing live' : 'Idle'}
          </p>
        </div>
      </div>

      {/* ---- the big readout ---- */}
      <div className="px-4 pt-4">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              Speed
            </p>
            <p className="flex items-baseline gap-1.5">
              <span className="text-4xl leading-none font-semibold tabular-nums text-[var(--text)]">
                {speed.toFixed(speed < 10 ? 1 : 0)}
              </span>
              <span className="text-xs font-medium text-[var(--text-muted)]">km/h</span>
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
            <Icon name={modeMeta.icon} className="h-5 w-5 text-[var(--accent)]" />
            <div className="leading-tight">
              <p className="text-xs font-semibold text-[var(--text)]">{modeMeta.label}</p>
              <p className="text-[10px] text-[var(--text-subtle)]">
                {active ? 'playing now' : 'next route'}
              </p>
            </div>
          </div>
        </div>

        {/* progress of the journey, in real time */}
        {total > 0 ? (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-1000 ease-linear"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span className="tabular-nums">
                {formatDistance(travelled)} of {formatDistance(total)}
              </span>
              <span className="tabular-nums">
                {formatDistance(remaining)} to go
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- live tiles ---- */}
      <div className="grid grid-cols-3 gap-2 px-4 pt-4">
        <Tile label="Elapsed" value={formatElapsed(elapsedSeconds)} />
        <Tile label="Remaining" value={remaining > 0 ? formatDistance(remaining) : '—'} />
        <Tile label="Arrival" value={etaSeconds ? formatEta(etaSeconds) : '—'} />
      </div>

      {/* ---- coordinate readout ---- */}
      <div className="mt-3 px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <Icon name={running ? 'pulse' : 'locate'} className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              {copiedLabel}
            </p>
            <p className="truncate font-mono text-[13px] font-medium tabular-nums text-[var(--text)]">
              {shown ? formatLatLng(shown) : 'No spot picked yet'}
            </p>
            {shown ? (
              <p className="truncate text-[10px] text-[var(--text-subtle)]">{formatDms(shown)}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCopy}
            disabled={!shown}
            aria-label="Copy coordinates"
            className="rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-40"
          >
            <Icon name="copy" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ---- actions ---- */}
      <div className="px-4 pt-3 pb-4">
        {/* A browser genuinely cannot move the device's position, so it is told
            that rather than handed a button whose only outcome is an error. */}
        {!mockState.available ? (
          <p className="mb-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            This is the browser preview: it can plan a journey but not publish one.
            The APK version moves the phone&rsquo;s position itself.
          </p>
        ) : null}

        <div className="flex gap-2">
          {running ? (
            <Button variant="danger" size="md" className="flex-1" onClick={onStop} disabled={busy}>
              <Icon name="stop" className="h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              onClick={onStart}
              disabled={busy || !mockState.available || (!position && !hasRoute)}
            >
              <Icon name={hasRoute ? 'route' : 'play'} className="h-4 w-4" />
              {hasRoute ? 'Start route' : 'Publish this spot'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="md"
            onClick={onToggleFollow}
            aria-pressed={follow}
            className={follow ? 'ring-1 ring-[var(--accent)]' : ''}
          >
            <Icon name="locate" className="h-4 w-4" />
            {follow ? 'Following' : 'Follow'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={onOpenMaps}
            disabled={!hasRoute}
            aria-label="Open this route in Google Maps"
          >
            <Icon name="share" className="h-4 w-4" />
          </Button>
        </div>

        {/* Two ways to move what the phone publishes by hand: walk a loop
            around the pin, or take the stick over the map — which is where the
            dot it moves can actually be watched. */}
        {running ? (
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
                Steer by hand
              </p>
              <Button variant="ghost" size="sm" onClick={onOpenControls}>
                <Icon name="pulse" className="h-3.5 w-3.5" />
                Open the stick
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-[var(--text-muted)]">Walk a loop</span>
              <div className="flex gap-1.5">
                {RADII.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onCircle(value)}
                    disabled={!position || busy}
                    className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text)] active:scale-95 disabled:opacity-40"
                  >
                    {value} m
                  </button>
                ))}
              </div>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-subtle)]">
              Open the stick over the map and the mock walks whichever way you
              push it, until you let go and the route takes over again.
            </p>
          </div>
        ) : null}

        {mockState.error ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <p>{mockState.error}</p>
              <button
                type="button"
                onClick={onFix}
                className="mt-1 font-semibold underline underline-offset-2"
              >
                Open the screen that fixes this
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
      <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
        {label}
      </p>
      <p className="truncate text-[13px] font-semibold tabular-nums text-[var(--text)]">{value}</p>
    </div>
  )
}
