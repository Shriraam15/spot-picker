import type { LatLng, MockState, ProbeResult, RouteModeId, RouteProgress } from './types'

/**
 * Shape of the Java object the Android wrapper injects into the WebView under
 * the name "SpotPicker" (see spot-picker/android/app/src/main/java/.../SpotPickerBridge.kt).
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
  /** JSON of { ok, error }. Publishes this position while the joystick is held. */
  setManualPosition(lat: number, lon: number): string
  /** JSON of { ok, error }. Hands the position back to the route. */
  clearManualPosition(): string
  /** JSON of FingerprintStatus: what this phone's biometrics can do. */
  biometricStatus(): string
  /** JSON of { ok, error }; the verdict arrives as a biometricResult event. */
  requestBiometricUnlock(): string
  /** Opens Android's fingerprint enrolment screen. */
  openBiometricSettings(): void
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

/**
 * Tells the service to publish [lat, lon] while the joystick is held.
 *
 * The web side never owns the position — the foreground service does, because it
 * has to keep publishing with the screen off — so steering is a stream of
 * targets rather than a command: the service publishes the newest one, four
 * times a second or however fast the finger moves. The route underneath keeps
 * advancing, so letting go re-joins the journey where it has got to.
 */
export function setManualPosition(lat: number, lon: number): MockResult {
  const bridge = api()
  if (!bridge?.setManualPosition) {
    return { ok: false, error: 'Steering needs the Android app.' }
  }
  return parse<MockResult>(
    call(
      () => bridge.setManualPosition(lat, lon),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/** Hands the published position back to the route or the stationary pin. */
export function clearManualPosition(): MockResult {
  const bridge = api()
  if (!bridge?.clearManualPosition) {
    return { ok: false, error: 'Steering needs the Android app.' }
  }
  return parse<MockResult>(
    call(
      () => bridge.clearManualPosition(),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/**
 * How this phone can open the app with a fingerprint.
 *
 * `available` is the field that matters: it is true only when the phone has a
 * sensor *and* at least one fingerprint enrolled. Anything else — no hardware,
 * nothing enrolled, a refused API — comes with a `reason` in the phone's own
 * words, which is what the lock screen shows instead of a button that cannot
 * work.
 */
export type FingerprintStatus = {
  supported: boolean
  enrolled: boolean
  available: boolean
  reason: string
}

/** What a browser (or any device without the Android bridge) reports. */
export const NO_FINGERPRINT: FingerprintStatus = {
  supported: false,
  enrolled: false,
  available: false,
  reason: 'Fingerprint unlock needs the Android app.',
}

/**
 * Reads this device's fingerprint status. On the web this is always
 * unavailable, because a browser page cannot reach the phone's biometric sheet
 * — the Android wrapper answers instead.
 */
export function getFingerprintStatus(): FingerprintStatus {
  const bridge = api()
  if (!bridge?.biometricStatus) return NO_FINGERPRINT
  const parsed = parse<Partial<FingerprintStatus>>(
    call(() => bridge.biometricStatus(), '{}'),
    {},
  )
  return {
    supported: parsed.supported === true,
    enrolled: parsed.enrolled === true,
    available: parsed.available === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : NO_FINGERPRINT.reason,
  }
}

/**
 * Asks the phone to show its fingerprint sheet. This returning ok only means
 * the request was queued: the verdict is a `biometricResult` event, because a
 * fingerprint takes as long as a finger takes.
 */
export function requestFingerprint(): MockResult {
  const bridge = api()
  if (!bridge?.requestBiometricUnlock) {
    return { ok: false, error: 'Fingerprint unlock needs the Android app.' }
  }
  return parse<MockResult>(
    call(
      () => bridge.requestBiometricUnlock(),
      '{"ok":false,"error":"Native bridge unavailable."}',
    ),
    { ok: false, error: 'Native bridge unavailable.' },
  )
}

/** Reads a `biometricResult` event, which carries the OS verdict. */
export function readFingerprintResult(event: Record<string, unknown>): {
  ok: boolean
  error: string | null
} {
  return {
    ok: event.ok === true,
    error: typeof event.error === 'string' ? event.error : null,
  }
}

/** Opens Android's fingerprint enrolment screen. */
export function openFingerprintSettings(): void {
  call(() => api()?.openBiometricSettings?.(), undefined)
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
  // The wrapper creates this object before any page script runs, but an older
  // WebView without DOCUMENT_START_SCRIPT support would leave it undefined —
  // and then every native event, including the fingerprint verdict, would be
  // dropped. Creating it here makes the transport available either way, since
  // the Android side looks the object up when it has an event to send.
  const target = (window.SpotPickerEvents = window.SpotPickerEvents ?? {})
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