import type { LatLng, MockState, ProbeResult, RouteModeId, RouteProgress } from './types'

/**
 * Shape of the Java object the Android wrapper injects into the WebView under
 * the name "SpotPicker" (see android/app/src/main/java/.../SpotPickerBridge.kt).
 *
 * Every method returns a JSON string rather than a complex value because
 * @JavascriptInterface only marshals primitives reliably across the boundary.
 */
type NativeApi = {
  isNative(): boolean
  /** JSON of MockState. */
  getStatus(): string
  /** Plain-text diagnostics report, meant to be read on the phone. */
  getDiagnostics(): string
  /** JSON of { ok: boolean, error: string | null }. */
  startMock(lat: number, lon: number): string
  /** JSON of { ok: boolean, error: string | null }. */
  stopMock(): string
  /** JSON of RouteProgress; the service plays the route, this only reports it. */
  getRoute(): string
  /**
   * JSON of { ok: boolean, error: string | null }. waypointsJson is [[lat,lon],…]
   * and mode is a MotionMode id (see lib/types.ts ROUTE_MODES).
   */
  startRoute(waypointsJson: string, speedKmh: number, mode: string): string
  /** JSON of { ok: boolean, error: string | null }; the result arrives by event. */
  startLiveUpdateTest(seconds: number): string
  requestPermissions(): void
  openDeveloperOptions(): void
  openAboutPhone(): void
  openAppSettings(): void
  /** JSON of { ok, error }. Hands an https link to the system's browser or Maps. */
  openExternalUrl(url: string): string
}

declare global {
  interface Window {
    SpotPicker?: NativeApi
    /** Set by the native side so JS can react to service-level events. */
    SpotPickerEvents?: { onEvent?: (payload: string) => void }
  }
}

/** True when the page is running inside the Android wrapper. */
export function isNative(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.SpotPicker?.isNative()
  } catch {
    return false
  }
}

function api(): NativeApi | null {
  if (typeof window === 'undefined') return null
  const bridge = window.SpotPicker
  return bridge && bridge.isNative() ? bridge : null
}

/**
 * Wraps a bridge call so a throwing Java method surfaces as a friendly message
 * instead of an unhandled exception inside the WebView.
 */
function call<T>(fn: () => T, fallback: T): T {
  const bridge = api()
  if (!bridge) return fallback
  try {
    return fn()
  } catch {
    return fallback
  }
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const UNAVAILABLE_STATE: MockState = {
  available: false,
  appSelected: false,
  developerOptions: false,
  running: false,
  starting: false,
  hasPermission: false,
  error: null,
}

/**
 * Reads the current mock-location status from the native layer. Every field is
 * read defensively: a payload that cannot be parsed reports "not running" rather
 * than throwing, because a broken status read must not be able to leave the UI
 * stuck on a button that no longer matches the service.
 */
export function getMockState(): MockState {
  const bridge = api()
  if (!bridge) return UNAVAILABLE_STATE
  const parsed = parse<Partial<MockState>>(call(() => bridge.getStatus(), '{}'), {})
  return {
    available: true,
    appSelected: parsed.appSelected === true,
    developerOptions: parsed.developerOptions === true,
    running: parsed.running === true,
    starting: parsed.starting === true,
    hasPermission: parsed.hasPermission === true,
    error: typeof parsed.error === 'string' ? parsed.error : null,
  }
}

/** Diagnostics report from the native layer, or null on the web. */
export function getDiagnostics(): string | null {
  const bridge = api()
  if (!bridge) return null
  return call(() => bridge.getDiagnostics(), 'Diagnostics unavailable.')
}

export type MockResult = { ok: boolean; error: string | null }

export function startMock(lat: number, lon: number): MockResult {
  const bridge = api()
  if (!bridge) return { ok: false, error: 'Mock location is only available in the Android app.' }
  return parse<MockResult>(
    call(() => bridge.startMock(lat, lon), '{"ok":false,"error":"Native bridge unavailable."}'),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

export function stopMock(): MockResult {
  const bridge = api()
  if (!bridge) return { ok: false, error: 'Mock location is only available in the Android app.' }
  return parse<MockResult>(
    call(() => bridge.stopMock(), '{"ok":false,"error":"Native bridge unavailable."}'),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/**
 * Starts (or replaces) a simulated route. The Android service plays it, so the
 * movement survives the screen going off — which is the whole point of faking a
 * position while you use another app.
 */
export function startRoute(
  waypoints: LatLng[],
  speedKmh: number,
  mode: RouteModeId,
): MockResult {
  const bridge = api()
  if (!bridge) return { ok: false, error: 'Route simulation only runs in the Android app.' }
  const payload = JSON.stringify(waypoints.map((point) => [point.lat, point.lon]))
  return parse<MockResult>(
    call(
      () => bridge.startRoute(payload, speedKmh, mode),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/**
 * Starts the native live-update self-test, which subscribes to the mocked
 * providers and counts what arrives. The caller never sees the raw answer here:
 * the verdict is delivered as a `probeResult` event, because the test needs
 * several seconds of real updates to mean anything.
 */
export function startLiveUpdateTest(seconds: number): MockResult {
  const bridge = api()
  if (!bridge) return { ok: false, error: 'The live-update test only runs in the Android app.' }
  return parse<MockResult>(
    call(
      () => bridge.startLiveUpdateTest(seconds),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/**
 * Route progress, or null when not running inside the Android wrapper. Every
 * field is read defensively: a route panel that cannot parse its status must
 * show nothing rather than throw.
 */
export function getRoute(): RouteProgress | null {
  const bridge = api()
  if (!bridge) return null
  const parsed = parse<Record<string, unknown>>(call(() => bridge.getRoute(), '{}'), {})
  const num = (key: keyof RouteProgress): number => {
    const value = parsed[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    active: parsed.active === true,
    finished: parsed.finished === true,
    running: parsed.running === true,
    lat: typeof parsed.lat === 'number' ? parsed.lat : null,
    lon: typeof parsed.lon === 'number' ? parsed.lon : null,
    travelledMetres: num('travelledMetres'),
    totalMetres: num('totalMetres'),
    speedKmh: num('speedKmh'),
  }
}

export function requestPermissions(): void {
  call(() => api()?.requestPermissions(), undefined)
}

export function openDeveloperOptions(): void {
  call(() => api()?.openDeveloperOptions(), undefined)
}

/** About phone, where Developer options are unlocked before they can be used. */
export function openAboutPhone(): void {
  call(() => api()?.openAboutPhone(), undefined)
}

export function openAppSettings(): void {
  call(() => api()?.openAppSettings(), undefined)
}

/**
 * Opens a link outside the app: the system browser on Android, a new tab on the
 * web. Inside the Android wrapper the WebView has no chrome of its own, so a
 * plain `target="_blank"` link would do nothing at all — it has to go through
 * the bridge.
 */
export function openExternal(url: string): MockResult {
  const bridge = api()
  if (!bridge) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    return { ok: true, error: null }
  }
  return parse<MockResult>(
    call(
      () => bridge.openExternalUrl(url),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/**
 * Reads a `probeResult` event, defensively. The verdict is delivered as an event
 * rather than as the return value of the call that started it: the test needs
 * several seconds of real location updates before it can say anything.
 */
export function readProbeResult(event: Record<string, unknown>): ProbeResult {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    ok: event.ok === true,
    updates: number(event.updates),
    providers: typeof event.providers === 'string' ? event.providers : 'none',
    movedMetres: number(event.movedMetres),
    worstGapMs: number(event.worstGapMs),
    mockFlagged: event.mockFlagged === true,
    message: typeof event.message === 'string' ? event.message : 'The test reported nothing.',
  }
}

/** Quick snapshot of the current native state, for review panels and logs. */
export function nativeSummary(): string {
  const state = getMockState()
  const route = getRoute()
  const parts = [
    `native available: ${state.available}`,
    `selected: ${state.appSelected}`,
    `developer options: ${state.developerOptions}`,
    `permission: ${state.hasPermission}`,
    `running: ${state.running}`,
    `error: ${state.error ?? 'none'}`,
  ]
  if (route) {
    parts.push(
      `route active: ${route.active}`,
      `route finished: ${route.finished}`,
      `published: ${(route.lat != null && route.lon != null) ? `${route.lat.toFixed(6)}, ${route.lon.toFixed(6)}` : 'none'}`,
      `travelled: ${route.travelledMetres.toFixed(1)} / ${route.totalMetres.toFixed(1)} m`,
      `speed: ${route.speedKmh.toFixed(1)} km/h`,
    )
  } else {
    parts.push('route: not available')
  }
  return parts.join(' | ')
}

/**
 * Registers a listener for native events such as
 * { type: "mockState", running: true } or { type: "error", message: "..." }.
 * Returns an unsubscribe function.
 */
export function onNativeEvent(handler: (event: { type: string; [key: string]: unknown }) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const target = window.SpotPickerEvents
  if (!target) return () => {}
  const previous = target.onEvent
  target.onEvent = (payload: unknown) => {
    if (typeof payload !== 'string') return
    const event = parse<{ type: string } & Record<string, unknown>>(payload, { type: 'unknown' })
    handler(event)
    previous?.(payload)
  }
  return () => {
    if (target.onEvent) target.onEvent = previous
  }
}