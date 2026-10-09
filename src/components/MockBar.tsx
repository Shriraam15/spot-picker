import { useState } from 'react'
import type { LatLng, MockState, RouteProgress } from '@/lib/types'
import { formatDms, formatLatLng } from '@/lib/format'
import { formatDistance, formatDuration, durationSeconds } from '@/lib/route'
import { Badge, Button, Dot, Icon } from './ui'

type Props = {
  mockState: MockState
  /** The pin the user chose on the map. */
  position: LatLng | null
  /** What the mock location is publishing right now, when it is running. */
  livePosition: LatLng | null
  route: RouteProgress | null
  busy: boolean
  follow: boolean
  onStart: () => void
  onStop: () => void
  /** Moves the selected spot by metres north/east. */
  onNudge: (northMetres: number, eastMetres: number) => void
  onToggleFollow: () => void
  onOpenSetup: () => void
  /** Opens the screen that fixes a refused start (About phone or Developer options). */
  onFix: () => void
}

/** Two magnitudes, because "a few metres" and "across town" are both common. */
const STEPS = [10, 100] as const

/**
 * Sticky action bar: the live coordinate readout, a nudge pad for fine-tuning a
 * spot, and the Start/Stop control. On the web it degrades to a coordinate
 * display and a copy action, since a browser genuinely cannot move the device GPS.
 */
export default function MockBar({
  mockState,
  position,
  livePosition,
  route,
  busy,
  follow,
  onStart,
  onStop,
  onNudge,
  onToggleFollow,
  onOpenSetup,
  onFix,
}: Props) {
  const [step, setStep] = useState<number>(STEPS[0])
  const running = mockState.running
  const starting = mockState.starting && !running
  // While publishing, the coordinate that matters is the one the phone reports.
  // For a route that is the moving fix; for a stationary mock the pin *is* the
  // published position, so the label says so rather than leaving the user to
  // guess whether the number on screen is live.
  const shown = (running && livePosition) || position
  const heading = running ? 'Publishing' : 'Selected spot'

  const routeActive = route?.active === true
  const routeTotal = route?.totalMetres ?? 0
  const routeDone = route?.travelledMetres ?? 0
  const routePercent = routeTotal > 0 ? Math.min(100, (routeDone / routeTotal) * 100) : 0
  const routeLeft = formatDuration(durationSeconds(Math.max(0, routeTotal - routeDone), route?.speedKmh ?? 0))

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface)]/85 px-4 py-3 backdrop-blur-xl">
      {shown ? (
        <div className="mb-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              {heading}
            </p>
            <p className="tabular mt-0.5 font-mono text-[15px] leading-tight font-medium text-[var(--text)]">
              {formatLatLng(shown)}
            </p>
            <p className="tabular mt-0.5 text-[11px] text-[var(--text-subtle)]">{formatDms(shown)}</p>
          </div>
          <CopyButton value={formatLatLng(shown)} />
        </div>
      ) : (
        <p className="mb-3 text-center text-xs text-[var(--text-subtle)]">
          Tap anywhere on the map to drop a pin.
        </p>
      )}

      {/* ---- nudge pad: a pin is never quite on the right spot ------------ */}
      {mockState.available && position ? (
        <div className="mb-3 flex items-center gap-2">
          <div className="flex items-center gap-1">
            {(
              [
                ['left', 0, -1],
                ['up', 1, 0],
                ['down', -1, 0],
                ['right', 0, 1],
              ] as const
            ).map(([icon, north, east]) => (
              <button
                key={icon}
                type="button"
                aria-label={`Move ${icon} by ${step} metres`}
                onClick={() => onNudge(north * step, east * step)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text)] active:scale-95"
              >
                <Icon name={icon} className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-[var(--border)]">
            {STEPS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setStep(value)}
                className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  step === value
                    ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                ±{value} m
              </button>
            ))}
          </div>
          <span className="ml-auto hidden text-[10px] text-[var(--text-subtle)] sm:block">
            Fine-tune the spot
          </span>
        </div>
      ) : null}

      {/* ---- route progress --------------------------------------------- */}
      {routeActive ? (
        <div className="mb-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all duration-700 ease-linear"
              style={{ width: `${routePercent.toFixed(1)}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="tabular inline-flex items-center gap-1.5">
              <Icon name="route" className="h-3.5 w-3.5" />
              {formatDistance(routeDone)} of {formatDistance(routeTotal)}
            </span>
            <span className="tabular">
              {route?.finished ? 'Route complete' : `${routeLeft} left`}
            </span>
          </div>
        </div>
      ) : null}

      {/* ---- a refusal the user can actually fix ------------------------ */}
      {mockState.error && !running ? (
        <div className="mb-3 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-3 py-2.5">
          <p className="flex gap-2 text-[11px] leading-relaxed text-[var(--danger)]">
            <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{mockState.error}</span>
          </p>
          {!mockState.developerOptions ? (
            <p className="mt-2 pl-5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Developer options are still hidden. Open About phone and tap{' '}
              <strong className="font-medium text-[var(--text)]">Build number</strong> seven times
              to unlock them.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2 pl-5">
            <Button variant="secondary" size="sm" onClick={onFix}>
              <Icon name="settings" className="h-3.5 w-3.5" />
              {mockState.developerOptions ? 'Open developer options' : 'Open About phone'}
            </Button>
            {position ? (
              <Button variant="ghost" size="sm" onClick={onStart} disabled={busy}>
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {mockState.available ? (
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="danger" className="flex-1" onClick={onStop} disabled={busy}>
              <Icon name="stop" className="h-3.5 w-3.5" />
              Stop mock location
            </Button>
          ) : starting ? (
            <Button variant="primary" className="flex-1" disabled>
              <Icon name="play" className="h-3.5 w-3.5" />
              Starting mock location…
            </Button>
          ) : (
            <Button
              variant="primary"
              className="flex-1"
              onClick={onStart}
              disabled={!position || busy}
            >
              <Icon name="play" className="h-3.5 w-3.5" />
              Start mock location
            </Button>
          )}
          <Button
            variant={follow ? 'primary' : 'secondary'}
            onClick={onToggleFollow}
            aria-label="Follow the published position"
            title="Keep the map centred on the published position"
          >
            <Icon name="locate" className="h-4 w-4" />
          </Button>
          <Button
            variant="secondary"
            onClick={onOpenSetup}
            aria-label="Open review and setup"
            title="Open review and setup"
          >
            <Icon name="settings" className="h-4 w-4" />
            Review
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="flex-1" onClick={onOpenSetup}>
            <Icon name="globe" className="h-4 w-4" />
            How to use mock location
          </Button>
        </div>
      )}

      {mockState.available ? (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <Badge tone={running ? 'success' : 'neutral'}>
            <Dot active={running} />
            {running ? (routeActive ? 'Simulating route' : 'Publishing location') : starting ? 'Starting' : 'Idle'}
          </Badge>
          {mockState.error && running ? (
            <span className="truncate text-[11px] text-[var(--danger)]">{mockState.error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Copies text to the clipboard and briefly confirms with a checkmark. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      }}
      aria-label="Copy coordinates"
      className="shrink-0 rounded-lg border border-[var(--border)] p-2 text-[var(--text-subtle)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
    >
      <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
    </button>
  )
}
