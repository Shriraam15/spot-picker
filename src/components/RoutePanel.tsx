import type {
  Favorite,
  LatLng,
  RouteModeId,
  RouteOption,
  RoutePreference,
  RouteProgress,
} from '@/lib/types'
import { ROUTE_MODES } from '@/lib/types'
import { formatLatLng } from '@/lib/format'
import {
  MAX_SPEED_KMH,
  MIN_SPEED_KMH,
  buildGpx,
  durationSeconds,
  formatDistance,
  formatDuration,
} from '@/lib/route'
import { downloadTextFile } from '@/lib/download'
import { Badge, Button, Card, CardHeader, Icon } from './ui'
import { loadSettings, type AppSettings } from '@/lib/settings'

/** What the road-route request is doing, so the panel can say so. */
export type RoutingState = 'idle' | 'loading' | 'ready' | 'error'

type Props = {
  favorites: Favorite[]
  /** The pin on the map, offered as the next endpoint. */
  position: LatLng | null
  /** The points the user picked: start, any stops, destination. */
  endpoints: LatLng[]
  mode: RouteModeId
  speedKmh: number
  /** Every path on offer. One of them is the one that gets played. */
  options: RouteOption[]
  selectedId: string | null
  preference: RoutePreference
  routing: RoutingState
  routingError: string | null
  canOpenInMaps: boolean
  progress: RouteProgress | null
  follow: boolean
  busy: boolean
  onChangeEndpoints: (next: LatLng[]) => void
  onChangeMode: (mode: RouteModeId) => void
  onChangeSpeed: (kmh: number) => void
  onSelectRoute: (id: string) => void
  onChangePreference: (preference: RoutePreference) => void
  onRetryRouting: () => void
  onOpenInMaps: () => void
  onToggleFollow: () => void
  onStart: () => void
  onStop: () => void
  onJumpTo: (position: LatLng) => void
  onSaveDefaults: (next: AppSettings) => void
}

/**
 * Builds and runs a simulated journey: two endpoints the user picks, one route
 * they choose between, and a speed they set.
 *
 * Playback itself happens in the Android foreground service rather than here, so
 * it keeps moving while the phone is showing the app under test — which is the
 * only way a simulated journey is actually useful.
 */
export default function RoutePanel({
  favorites,
  position,
  endpoints,
  mode,
  speedKmh,
  options,
  selectedId,
  preference,
  routing,
  routingError,
  canOpenInMaps,
  progress,
  follow,
  busy,
  onChangeEndpoints,
  onChangeMode,
  onChangeSpeed,
  onSelectRoute,
  onChangePreference,
  onRetryRouting,
  onOpenInMaps,
  onToggleFollow,
  onStart,
  onStop,
  onJumpTo,
  onSaveDefaults,
}: Props) {
  const finished = progress?.active === true && progress.finished === true
  const selected = options.find((option) => option.id === selectedId) ?? null
  const pathLength = selected?.distanceMetres ?? (options[0]?.distanceMetres ?? 0)
  const estimate = durationSeconds(pathLength, speedKmh)
  const done = progress?.active ? progress.travelledMetres : 0
  const measuredTotal = progress?.active && progress.totalMetres > 0 ? progress.totalMetres : pathLength
  const percent = measuredTotal > 0 ? Math.min(100, (done / measuredTotal) * 100) : 0
  const remainingSeconds = durationSeconds(Math.max(0, measuredTotal - done), speedKmh)

  const labelFor = (point: LatLng) => {
    const match = favorites.find(
      (f) => Math.abs(f.lat - point.lat) < 1e-7 && Math.abs(f.lon - point.lon) < 1e-7,
    )
    return match ? match.name : formatLatLng(point)
  }

  const roleFor = (index: number) => {
    if (index === 0) return 'Start'
    if (index === endpoints.length - 1) return 'Destination'
    return `Stop ${index}`
  }

  const nextRole =
    endpoints.length === 0
      ? 'Set the start'
      : endpoints.length === 1
        ? 'Set the destination'
        : 'Add a stop'

  const canAdd = (point: LatLng) =>
    !endpoints.some((p) => Math.abs(p.lat - point.lat) < 1e-9 && Math.abs(p.lon - point.lon) < 1e-9)

  const add = (point: LatLng) => {
    if (canAdd(point)) onChangeEndpoints([...endpoints, point])
  }

  const ready = endpoints.length >= 2
  const activeMode = ROUTE_MODES.find((m) => m.id === mode) ?? ROUTE_MODES[0]

  const routeHelpText = selected ? (
    selected.snapped
      ? 'Following the road route you chose.'
      : 'Following the straight line you chose.'
  ) : selectedId === null && options.some((o) => o.snapped) ? (
    'Pick a route below, or use the preference to choose automatically.'
  ) : (
    'Straight line between your points — pick a road route to follow streets.'
  )

  return (
    <Card>
      <CardHeader
        title="Route simulation"
        hint="Pick a start and a destination, choose the road route, then set the speed."
        action={
          progress?.active ? (
            <Badge tone={finished ? 'accent' : 'success'}>
              {finished ? 'Complete' : 'Moving'}
            </Badge>
          ) : (
            <Badge tone="neutral">
              <Icon name="route" className="h-3 w-3" />
              {endpoints.length ? `${endpoints.length} pts` : 'Empty'}
            </Badge>
          )
        }
      />

      {/* ---- the endpoints ---- */}
      {endpoints.length > 0 ? (
        <ol className="space-y-1.5 px-4">
          {endpoints.map((point, index) => (
            <li
              key={`${point.lat},${point.lon},${index.toString()}`}
              className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  background:
                    index === 0
                      ? 'var(--success)'
                      : index === endpoints.length - 1
                        ? 'var(--danger)'
                        : 'var(--accent)',
                }}
              />
              <span className="w-20 shrink-0 text-[11px] font-medium text-[var(--text)]">
                {roleFor(index)}
              </span>
              <button
                type="button"
                onClick={() => onJumpTo(point)}
                className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
              >
                {labelFor(point)}
              </button>
              <span className="flex shrink-0 flex-col gap-0.5">
                <button
                  type="button"
                  aria-label={`Move ${roleFor(index).toLowerCase()} up`}
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...endpoints]
                    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                    onChangeEndpoints(next)
                  }}
                  className="rounded p-0.5 text-[var(--text-subtle)] transition-colors hover:text-[var(--text)] disabled:opacity-30 disabled:hover:text-[var(--text-subtle)]"
                >
                  <Icon name="up" className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${roleFor(index).toLowerCase()} down`}
                  disabled={index === endpoints.length - 1}
                  onClick={() => {
                    const next = [...endpoints]
                    ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                    onChangeEndpoints(next)
                  }}
                  className="rounded p-0.5 text-[var(--text-subtle)] transition-colors hover:text-[var(--text)] disabled:opacity-30 disabled:hover:text-[var(--text-subtle)]"
                >
                  <Icon name="down" className="h-3 w-3" />
                </button>
              </span>
              <button
                type="button"
                aria-label={`Remove ${roleFor(index).toLowerCase()}`}
                onClick={() => onChangeEndpoints(endpoints.filter((_, i) => i !== index))}
                className="shrink-0 rounded-lg p-1 text-[var(--text-subtle)] transition-colors hover:text-[var(--danger)]"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 text-[13px] leading-relaxed text-[var(--text-muted)]">
          Tap the map to drop the start pin, then add it here. Endpoints added in order:
          the first is the start, the last is the destination.
        </p>
      )}

      <div className="flex flex-wrap gap-2 px-4 pt-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!position || (position !== null && !canAdd(position))}
          onClick={() => {
            if (position) add(position)
          }}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          {nextRole}
        </Button>
        {favorites.slice(0, 3).map((favorite) => (
          <Button
            key={favorite.id}
            variant="ghost"
            size="sm"
            disabled={!canAdd({ lat: favorite.lat, lon: favorite.lon })}
            onClick={() => add({ lat: favorite.lat, lon: favorite.lon })}
          >
            <Icon name="star" className="h-3 w-3" />
            {favorite.name}
          </Button>
        ))}
        {endpoints.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChangeEndpoints([])}>
            <Icon name="trash" className="h-3.5 w-3.5" />
            Clear
          </Button>
        ) : null}
        {ready ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const points = selected?.points ?? options[0]?.points ?? endpoints
              const name = `${labelFor(endpoints[0])} → ${labelFor(endpoints[endpoints.length - 1])}`
              downloadTextFile('spot-picker-route.gpx', buildGpx(points, name), 'application/gpx+xml')
            }}
          >
            <Icon name="save" className="h-3.5 w-3.5" />
            Export GPX
          </Button>
        ) : null}
      </div>

      {/* ---- travel mode ---- */}
      <div className="px-4 pt-4">
        <p className="mb-2 text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
          Mode
        </p>
        <div className="flex flex-wrap gap-2">
          {ROUTE_MODES.map((item) => {
            const active = item.id === mode
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                title={item.hint}
                onClick={() => onChangeMode(item.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-all active:scale-[0.97] ${
                  active
                    ? 'border-transparent bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                }`}
              >
                <Icon name={item.icon} className="h-3.5 w-3.5" />
                {item.label}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
          {activeMode.hint} · the mode also decides how realistic the fixes look.
        </p>
      </div>

      {/* ---- speed ---- */}
      <div className="px-4 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
            Speed
          </p>
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <input
              type="number"
              inputMode="decimal"
              min={MIN_SPEED_KMH}
              max={MAX_SPEED_KMH}
              step={0.5}
              value={speedKmh}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next)) {
                  onChangeSpeed(Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, next)))
                }
              }}
              className="tabular w-14 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-right text-[var(--text)] outline-none focus-visible:border-[var(--accent)] [appearance:textfield]"
              aria-label="Custom speed in km/h"
            />
            km/h
          </label>
        </div>
        <input
          type="range"
          min={1}
          max={130}
          step={1}
          value={Math.min(130, Math.max(1, speedKmh))}
          onChange={(e) => onChangeSpeed(Number(e.target.value))}
          aria-label="Speed in km per hour"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--surface-2)] accent-[var(--accent)]"
        />
        <div className="mt-1 flex justify-between text-[10px] text-[var(--text-subtle)]">
          <span>1</span>
          <span>65</span>
          <span>130+</span>
        </div>
      </div>

      {/* ---- which route ---- */}
      {ready ? (
        <div className="px-4 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              Route
            </p>
            {routing === 'loading' ? (
              <span className="text-[11px] text-[var(--text-subtle)]">
                {selected ? 'Refreshing your chosen route…' : 'Finding roads…'}
              </span>
            ) : routing === 'error' ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--text-muted)]">Could not fetch road routes.</span>
                <button
                  type="button"
                  onClick={onRetryRouting}
                  className="text-[11px] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>
          {/* Which route to favour when the user has not picked one. */}
          <div className="mb-2 inline-flex rounded-full border border-[var(--border)] p-0.5">
            {(
              [
                { id: 'fastest', label: 'Fastest', hint: 'The quickest route the router offers' },
                {
                  id: 'highways',
                  label: 'Highways first',
                  hint: 'The route that spends the most distance on numbered roads',
                },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.hint}
                aria-pressed={preference === item.id}
                onClick={() => onChangePreference(item.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                  preference === item.id
                    ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            {options.map((option) => {
              const active = option.id === selectedId
              const manualPicked = active && selectedId !== null
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelectRoute(option.id)}
                  className={`rounded-xl border px-3 py-2 text-left transition-all active:scale-[0.99] ${
                    active && manualPicked
                      ? 'border-transparent bg-[var(--accent)] text-[var(--accent-text)]'
                      : active
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-semibold">{option.label}</span>
                    <span className="tabular text-[11px] opacity-80">
                      {formatDistance(option.distanceMetres)}
                      {typeof option.highwayShare === 'number' && option.highwayShare > 0
                        ? ` · ${Math.round(option.highwayShare * 100).toString()}% numbered`
                        : ''}
                    </span>
                  </span>
                  {option.via && option.via.length > 0 ? (
                    <span className="mt-0.5 block truncate text-[10px] opacity-75">
                      via {option.via.join(' · ')}
                    </span>
                  ) : null}
                  {manualPicked ? (
                    <span className="mt-1 block text-[9px] uppercase tracking-wider text-[var(--accent)]">
                      your choice
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {routingError ? (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {routingError}
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-subtle)]">
              {routeHelpText}
            </p>
          )}
        </div>
      ) : null}

      {/* ---- defaults ---- */}
      <div className="px-4 pt-4">
        <p className="mb-2 text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
          Defaults
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onSaveDefaults({
                ...loadSettings(),
                defaultSpeedKmh: Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, speedKmh)),
                routePreference: preference,
              })
            }}
          >
            <Icon name="save" className="h-3 w-3" />
            Save as my defaults
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={speedKmh === loadSettings().defaultSpeedKmh && preference === loadSettings().routePreference}
            onClick={() => {
              onSaveDefaults({ ...loadSettings(), defaultSpeedKmh: 45, routePreference: 'fastest' })
            }}
          >
            Reset to 45 / fastest
          </Button>
        </div>
      </div>

      {/* ---- summary ---- */}
      {ready ? (
        <div className="mt-3 flex items-center gap-4 px-4 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="route" className="h-3.5 w-3.5" />
            {formatDistance(measuredTotal)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="clock" className="h-3.5 w-3.5" />
            {formatDuration(remainingSeconds || estimate)}
            {progress?.active && !finished ? ' left' : ''}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="gauge" className="h-3.5 w-3.5" />
            {speedKmh} km/h
          </span>
        </div>
      ) : null}

      {/* ---- progress ---- */}
      {progress?.active ? (
        <div className="px-4 pt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all duration-700 ease-linear"
              style={{ width: `${percent.toFixed(1)}%` }}
            />
          </div>
          <p className="tabular mt-1.5 text-[11px] text-[var(--text-subtle)]">
            {formatDistance(done)} of {formatDistance(measuredTotal)} · {percent.toFixed(0)}%
            {finished ? ' · holding the last position' : ''}
          </p>
        </div>
      ) : null}

      {/* ---- actions ---- */}
      <div className="flex items-center gap-2 p-4 pt-3">
        {playbackActive(progress) ? (
          <Button variant="danger" className="flex-1" onClick={onStop} disabled={busy}>
            <Icon name="stop" className="h-3.5 w-3.5" />
            Stop simulation
          </Button>
        ) : (
          <Button
            variant="primary"
            className="flex-1"
            onClick={onStart}
            disabled={!ready || busy}
          >
            <Icon name="play" className="h-3.5 w-3.5" />
            {progress?.active ? 'Restart route' : 'Simulate route'}
          </Button>
        )}
        {/*
          The same journey in Google Maps. A mock location is invisible to Google,
          so this is how the route gets checked against the app people actually
          compare it with — the roads should be the roads.
        */}
        <Button
          variant="secondary"
          onClick={onOpenInMaps}
          disabled={!canOpenInMaps}
          aria-label="Open this route in Google Maps"
          title="Open this route in Google Maps to compare roads"
        >
          <Icon name="globe" className="h-4 w-4" />
        </Button>
        <Button
          variant={follow ? 'primary' : 'secondary'}
          onClick={onToggleFollow}
          aria-label="Follow the moving position"
          title="Keep the map centred on the moving position"
        >
          <Icon name="locate" className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

function playbackActive(progress: RouteProgress | null): boolean {
  return progress?.active === true && progress.running
}
