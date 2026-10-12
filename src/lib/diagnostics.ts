/**
 * The diagnostics screen's brain.
 *
 * One row per thing that can be wrong, and **every failing row carries its
 * fix** — a diagnostics screen that only says "place search unavailable" sends
 * the user off to find out what to do, which is the moment they stop using it.
 * The fixes are written next to the check that needs them for that reason.
 *
 * The rows are built as pure functions wherever they can be, so the wording and
 * the verdicts can be tested without a browser. The three network checks take
 * their URLs and their `fetch` as parameters, so a test can drive them with a
 * stub instead of the internet.
 *
 * What this screen can and cannot see is worth stating: the web side can observe
 * the network, the bundle and the mock service's own report, but the *delivery*
 * path — whether Android hands our test locations to apps that subscribe — is
 * only knowable by listening, which is what the native live-update probe does.
 * Those rows are therefore "unknown" until the probe has been run rather than
 * guessed, and the screen says so.
 */
import type { MapStyle } from './map-style'
import type { MockState, ProbeResult, RouteModeId } from './types'

/**
 * The part of a style a check needs: which provider, under what name, with what
 * tile template. Taken as a parameter rather than looked up by id so this module
 * imports types only — a unit test can then load it without a bundler.
 */
export type StyleProbe = Pick<MapStyle, 'id' | 'label' | 'tiles'>

/** How severe a row is, worst last. `unknown` is not a failure: it is untested. */
export type ServiceStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export type ServiceGroup = 'device' | 'delivery' | 'accuracy' | 'services' | 'app'

export type ServiceCheck = {
  id: string
  label: string
  group: ServiceGroup
  status: ServiceStatus
  /** What is true right now, in one line a non-engineer can read. */
  detail: string
  /** Overrides the pill's label when a word fits better than the status does. */
  pill?: string
  /** What to do about it. Present whenever the status is not `ok`. */
  fix?: string
  /** Round-trip time of the request behind this row, when it made one. */
  ms?: number
}

// ---------------------------------------------------------------------------
// Accuracy: what the mock claims, and what the phone actually gets
// ---------------------------------------------------------------------------

/**
 * The horizontal accuracy the mock reports with every fix, per motion mode, in
 * metres — the nominal value the Android side jitters around.
 *
 * Duplicated from `MotionMode.accuracyMetres` on purpose is not quite right:
 * the mock's accuracy is a property of the *fix*, the phone owns the fix, and
 * the web app cannot measure it, so it has to be stated here to be shown at
 * all. It is kept in step with the Kotlin enum by a test that reads the enum
 * and fails when the two disagree, which is the same trick the bridge contract
 * test uses for the callback shapes.
 */
export const FIX_ACCURACY_METRES: Record<string, number> = {
  stationary: 6,
  walk: 8,
  run: 7,
  cycle: 6,
  drive: 9,
  custom: 7,
}

/**
 * How far the reported accuracy wanders from that nominal value. A receiver
 * does not report the same number every second — a fix claiming a constant
 * accuracy is one of the things that makes a mocked position look synthetic.
 */
export const FIX_ACCURACY_JITTER = { min: 0.8, max: 1.4 }

export type AccuracyBand = {
  /** A word for the number: Excellent / Good / Fair / Poor / Unknown. */
  label: string
  /** The badge tone the panel should use. */
  tone: 'success' | 'accent' | 'warn' | 'danger' | 'neutral'
  /** What that number means in practice. */
  hint: string
}

/**
 * Bands as a receiver user would describe them. The boundaries are the ones
 * that change what the position is good for: under 5 m puts you on the right
 * side of a street, 30 m does not.
 */
export function accuracyBand(metres: number | null | undefined): AccuracyBand {
  if (metres == null || !Number.isFinite(metres) || metres < 0) {
    return { label: 'Unknown', tone: 'neutral', hint: 'No fix has been measured yet.' }
  }
  if (metres <= 5) {
    return { label: 'Excellent', tone: 'success', hint: 'Good enough to tell one side of a street apart.' }
  }
  if (metres <= 10) {
    return { label: 'Good', tone: 'accent', hint: 'Normal for open sky on a phone.' }
  }
  if (metres <= 30) {
    return { label: 'Fair', tone: 'warn', hint: 'Buildings or trees are in the way, or the fix is reused.' }
  }
  return { label: 'Poor', tone: 'danger', hint: 'Too coarse to place a pin; a real receiver rarely reports this outdoors.' }
}

/** The nominal accuracy for a mode, and the range the fixes actually report. */
export function fixAccuracyRange(mode: RouteModeId | 'stationary' | string): {
  nominal: number
  min: number
  max: number
} {
  const nominal = FIX_ACCURACY_METRES[mode] ?? FIX_ACCURACY_METRES.custom
  return {
    nominal,
    min: Number((nominal * FIX_ACCURACY_JITTER.min).toFixed(1)),
    max: Number((nominal * FIX_ACCURACY_JITTER.max).toFixed(1)),
  }
}

/** A one-line range, e.g. `6.4–11 m`. */
export function fixAccuracyText(mode: RouteModeId | 'stationary' | string): string {
  const { min, max } = fixAccuracyRange(mode)
  return `${min}–${max} m`
}

// ---------------------------------------------------------------------------
// Probing a service
// ---------------------------------------------------------------------------

/** How long a check waits before it calls a service unreachable. */
export const DEFAULT_TIMEOUT_MS = 7000

export type ProbeOptions = {
  timeoutMs?: number
  /** Injected by tests; defaults to the page's own fetch. */
  fetchImpl?: typeof fetch
}

type ProbeOutcome = {
  ok: boolean
  ms: number
  status: number | null
  contentType: string
  /** Why it failed, in words worth showing; null on success. */
  failure: string | null
}

function describeStatus(status: number): string {
  if (status === 429) return 'rate limited (HTTP 429)'
  if (status === 403) return 'refused the request (HTTP 403)'
  if (status === 404) return 'has nothing at that address (HTTP 404)'
  if (status >= 500) return `is having trouble (HTTP ${status})`
  return `answered HTTP ${status}`
}

/**
 * One request, timed, with every outcome turned into words. It never throws:
 * a check that cannot be made is a row on the screen, not an exception that
 * takes the screen down with it.
 */
async function timedFetch(
  url: string,
  accept: string | null,
  opts: ProbeOptions,
): Promise<ProbeOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof fetchImpl !== 'function') {
    return { ok: false, ms: 0, status: null, contentType: '', failure: 'this app cannot make network requests' }
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      ...(accept ? { headers: { Accept: accept } } : {}),
    })
    const ms = Date.now() - started
    if (!response.ok) {
      return {
        ok: false,
        ms,
        status: response.status,
        contentType: response.headers?.get?.('content-type') ?? '',
        failure: describeStatus(response.status),
      }
    }
    return {
      ok: true,
      ms,
      status: response.status,
      contentType: response.headers?.get?.('content-type') ?? '',
      failure: null,
    }
  } catch (error) {
    const ms = Date.now() - started
    const aborted =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    return {
      ok: false,
      ms,
      status: null,
      contentType: '',
      failure: aborted
        ? `did not answer within ${(timeoutMs / 1000).toFixed(0)} s`
        : 'could not be reached from this device',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** `ms` as something worth reading: `210 ms` or `1.4 s`. */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * A tile URL for a provider template, at a fixed position: the world at zoom 2
 * is one tile that every raster provider has, so the sample is cheap and says
 * nothing about the user's location.
 */
export function tileSampleUrl(template: string): string {
  return template
    .replace('{s}', 'a')
    .replace('{z}', '2')
    .replace('{x}', '2')
    .replace('{y}', '1')
}

const TILE_FIX =
  'Turn on data or Wi-Fi for street-level detail. The bundled world map keeps drawing without it, so nothing else stops working.'

/** Is the online tile provider behind a style reachable right now? */
export async function probeTileProvider(
  style: StyleProbe,
  opts: ProbeOptions = {},
): Promise<ServiceCheck> {
  const outcome = await timedFetch(tileSampleUrl(style.tiles), 'image/png,image/*', opts)
  const base = {
    id: 'tiles-provider',
    label: `Map tiles (${style.label})`,
    group: 'services' as const,
    ms: outcome.ms,
  }
  if (!outcome.ok) {
    return { ...base, status: 'fail', detail: `The tile server ${outcome.failure}.`, fix: TILE_FIX }
  }
  if (outcome.contentType && !outcome.contentType.startsWith('image/')) {
    return {
      ...base,
      status: 'warn',
      detail: `Answered with ${outcome.contentType} instead of an image — a captive portal or a proxy is in the way.`,
      fix: 'Open any website to finish signing in to the network, or use the bundled world map until you can.',
    }
  }
  return {
    ...base,
    status: 'ok',
    detail: `Arrived from ${new URL(tileSampleUrl(style.tiles)).host}.`,
  }
}

/** Is the world map that ships inside the app really there for this style? */
export async function probeTileBundle(
  style: StyleProbe,
  base: string,
  opts: ProbeOptions = {},
): Promise<ServiceCheck> {
  const url = `${base}tiles/${style.id}/2/2/1.png`
  const outcome = await timedFetch(url, 'image/png,image/*', opts)
  const row = {
    id: 'tiles-bundle',
    label: 'Bundled world map',
    group: 'services' as const,
    ms: outcome.ms,
  }
  if (!outcome.ok) {
    return {
      ...row,
      status: 'fail',
      detail: `The ${style.label} world tiles are missing from this build (${outcome.failure}).`,
      fix: 'Reinstall the app, or rebuild it with `npm run tiles` — the offline world is generated, not fetched.',
    }
  }
  return {
    ...row,
    status: 'ok',
    detail: `${style.label}, zooms 0–4, served from the app itself. Drawing without any network.`,
  }
}

/** Can the app name places right now? */
export async function probeSearchProvider(opts: ProbeOptions = {}): Promise<ServiceCheck> {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q: 'London', format: 'jsonv2', limit: '1' }).toString()
  const outcome = await timedFetch(url, 'application/json', opts)
  const row = { id: 'search', label: 'Place search (Nominatim)', group: 'services' as const, ms: outcome.ms }
  if (!outcome.ok) {
    return {
      ...row,
      status: 'fail',
      detail: `The search service ${outcome.failure}.`,
      fix: 'Search needs a connection. The offline place database still answers for the biggest places, and saved spots and the map keep working.',
    }
  }
  return {
    ...row,
    status: 'ok',
    detail: 'A live query for a real place came back with an answer.',
  }
}

/** Can the app follow roads right now? */
export async function probeRoutingProvider(opts: ProbeOptions = {}): Promise<ServiceCheck> {
  // Two points a few hundred metres apart in Bengaluru: enough for the router
  // to answer with a real route, small enough to be an honest round trip.
  const url =
    'https://router.project-osrm.org/route/v1/driving/77.5946,12.9716;77.6000,12.9750' +
    '?overview=false&steps=false'
  const outcome = await timedFetch(url, 'application/json', opts)
  const row = { id: 'routing', label: 'Road routing (OSRM)', group: 'services' as const, ms: outcome.ms }
  if (!outcome.ok) {
    return {
      ...row,
      status: 'warn',
      detail: `The router ${outcome.failure}.`,
      fix: 'Choose the direct line instead: a route at the chosen speed still runs, it just does not follow the roads.',
    }
  }
  return {
    ...row,
    status: 'ok',
    detail: 'Two points a few hundred metres apart came back with a road route.',
  }
}

/** Is the offline place database in this build? */
export async function probePlaceData(base: string, opts: ProbeOptions = {}): Promise<ServiceCheck> {
  const url = `${base}data/p/a.json`
  const outcome = await timedFetch(url, 'application/json', opts)
  const row = { id: 'gazetteer', label: 'Offline place database', group: 'services' as const, ms: outcome.ms }
  if (!outcome.ok) {
    return {
      ...row,
      status: 'fail',
      detail: `A shard is missing from this build (${outcome.failure}).`,
      fix: 'Reinstall the app, or rebuild it with `npm run data` — the database is generated from GeoNames, not fetched at runtime.',
    }
  }
  return { ...row, status: 'ok', detail: 'Shards served from the app itself, so search works with no network.' }
}

/** Is local storage usable? Nothing the user saved survives without it. */
export type KVStore = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function defaultStore(): KVStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Access itself can throw when storage is blocked by policy.
    return null
  }
}

export function storageCheck(
  counts: { favorites: number; trips: number; recent: number },
  store: KVStore | null = defaultStore(),
): ServiceCheck {
  const row = { id: 'storage', label: 'Saved data', group: 'app' as const }
  const holding = `${counts.favorites} spot${counts.favorites === 1 ? '' : 's'}, ${counts.trips} trip${
    counts.trips === 1 ? '' : 's'
  }, ${counts.recent} recent search${counts.recent === 1 ? '' : 'es'}`
  if (!store) {
    return {
      ...row,
      status: 'fail',
      detail: 'This app cannot reach local storage, so nothing you save will survive.',
      fix: 'Private browsing or a storage-blocking setting is on. Allow site data for this app, then save a spot to confirm.',
    }
  }
  const probeKey = 'spotpicker.diagnostics.probe'
  try {
    store.setItem(probeKey, '1')
    const readBack = store.getItem(probeKey)
    store.removeItem(probeKey)
    if (readBack !== '1') throw new Error('write did not read back')
  } catch {
    return {
      ...row,
      status: 'fail',
      detail: 'Local storage is full or read-only, so saving is unreliable.',
      fix: 'Free some space on the device, or clear this app\u2019s storage to start again. Saved spots and trips are the first casualties.',
    }
  }
  return { ...row, status: 'ok', detail: `Readable and writable — ${holding}.` }
}

// ---------------------------------------------------------------------------
// The mock-location provider, and the fixes it delivers
// ---------------------------------------------------------------------------

/**
 * The three things that must be true before Android will let this app publish
 * a position, plus the service's own state — each with the screen that fixes it.
 */
export function deviceChecks(state: MockState): ServiceCheck[] {
  const rows: ServiceCheck[] = []
  if (!state.available) {
    return [
      {
        id: 'provider',
        label: 'Mock location provider',
        group: 'device',
        status: 'unknown',
        pill: 'Not here',
        detail: 'Not available here: a browser cannot publish a position to the rest of the device.',
        fix: 'Install the APK build of Spot Picker to mock the phone\u2019s location.',
      },
    ]
  }

  rows.push(
    state.hasPermission
      ? {
          id: 'permission',
          label: 'Location permission',
          group: 'device',
          status: 'ok',
          detail: 'Granted, so the service is allowed to publish a test location.',
        }
      : {
          id: 'permission',
          label: 'Location permission',
          group: 'device',
          status: 'fail',
          detail: 'Not granted. Android refuses every test location without it.',
          fix: 'Tap Grant and allow Location while using the app.',
        },
  )

  rows.push(
    state.developerOptions
      ? {
          id: 'developer-options',
          label: 'Developer options',
          group: 'device',
          status: 'ok',
          detail: 'Unlocked, so the mock location app picker exists on this phone.',
        }
      : {
          id: 'developer-options',
          label: 'Developer options',
          group: 'device',
          status: 'fail',
          detail: 'Still hidden, and the mock location app picker does not exist until they are unlocked.',
          fix: 'Open Settings, then About phone, then tap Build number seven times.',
        },
  )

  rows.push(
    state.appSelected
      ? {
          id: 'mock-app',
          label: 'Selected as mock app',
          group: 'device',
          status: 'ok',
          detail: 'This app is the phone\u2019s mock location app.',
        }
      : {
          id: 'mock-app',
          label: 'Selected as mock app',
          group: 'device',
          status: 'fail',
          detail: 'Another app (or none) is selected, so Android may ignore this one.',
          fix: 'In Developer options, tap Select mock location app and choose Spot Picker.',
        },
  )

  rows.push({
    id: 'service',
    label: 'Location service',
    group: 'device',
    status: state.running ? 'ok' : state.starting ? 'warn' : 'unknown',
    ...(state.running ? {} : { pill: state.starting ? 'Starting' : 'Idle' }),
    detail: state.running
      ? 'Running and publishing a position in the foreground service.'
      : state.starting
        ? 'Starting: Android has not confirmed the test providers yet.'
        : 'Stopped. Nothing is being published right now.',
    ...(state.running
      ? {}
      : { fix: 'Press Start on the Live page to publish the selected spot.' }),
  })

  if (state.error) {
    rows.push({
      id: 'service-error',
      label: 'Last error from Android',
      group: 'device',
      status: 'fail',
      detail: state.error,
      fix: 'Fix the row above that is failing, then start again — the app retries by itself once the selection is made.',
    })
  }

  return rows
}

/**
 * Whether Android is actually *delivering* the mock to apps that subscribe.
 *
 * Two different questions hide here, and only one of them is visible from
 * outside: publishing a position is enough for a one-shot "where am I?" read,
 * while live location subscribes and needs the delivery path. Until the native
 * probe has been run this is `unknown` rather than assumed.
 */
export function deliveryChecks(probe: ProbeResult | null, testing: boolean): ServiceCheck[] {
  if (testing) {
    return [
      {
        id: 'delivery',
        label: 'Fixes delivered to other apps',
        group: 'delivery',
        status: 'unknown',
        pill: 'Listening',
        detail: 'Listening for the fixes Android sends to apps that watch the position.',
      },
    ]
  }
  if (!probe) {
    return [
      {
        id: 'delivery',
        label: 'Fixes delivered to other apps',
        group: 'delivery',
        status: 'unknown',
        detail: 'Not tested yet. A one-shot location read can work even when live updates do not.',
        fix: 'Start the mock location, then run the live-update check below.',
      },
    ]
  }

  const rows: ServiceCheck[] = []
  rows.push(
    probe.ok
      ? {
          id: 'delivery',
          label: 'Fixes delivered to other apps',
          group: 'delivery',
          status: 'ok',
          detail: `${probe.updates} fix${probe.updates === 1 ? '' : 'es'} arrived from ${
            probe.providers || 'no provider'
          }${probe.worstGapMs > 0 ? `, longest gap ${probe.worstGapMs} ms` : ''}.`,
        }
      : {
          id: 'delivery',
          label: 'Fixes delivered to other apps',
          group: 'delivery',
          status: 'fail',
          detail: `Nothing arrived in the test window, so apps that subscribe to location are seeing the phone\u2019s real position.`,
          fix: 'Turn Location on and set it to High accuracy, and check that Google location accuracy (Wi-Fi and Bluetooth scanning) has not replaced Spot Picker as the mock location app.',
        },
  )

  if (probe.ok && !probe.mockFlagged) {
    rows.push({
      id: 'mock-flag',
      label: 'Marked as a test fix',
      group: 'delivery',
      status: 'warn',
      detail: 'The fixes arrive but are not flagged as coming from a mock provider, so an app that checks will ignore them.',
      fix: 'Stop and start the mock location: the flag is set when the test provider is installed.',
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// GPS accuracy rows
// ---------------------------------------------------------------------------

export type DeviceAccuracy = {
  state: 'idle' | 'measuring' | 'ready' | 'denied' | 'unsupported' | 'error'
  /** Horizontal accuracy of the phone's own fix, in metres. */
  metres: number | null
  /** When that fix was measured, ms since epoch. */
  at: number | null
  /** Why there is no number, when there is none. */
  message: string | null
}

export const IDLE_ACCURACY: DeviceAccuracy = {
  state: 'idle',
  metres: null,
  at: null,
  message: null,
}

/**
 * The accuracy this app tells Android to publish, which is a property of the
 * mode rather than of the phone: a receiver claims a few metres and the mock
 * has to be believable to survive an app that validates its fixes.
 */
export function publishedAccuracyCheck(mode: RouteModeId, running: boolean): ServiceCheck {
  const { nominal } = fixAccuracyRange(mode)
  return {
    id: 'accuracy-published',
    label: 'Accuracy this app publishes',
    group: 'accuracy',
    status: 'ok',
    // Never a failure, running or not: the accuracy a fix carries is decided by
    // the mode, and it is worth knowing before anything is started.
    detail: `${fixAccuracyText(mode)} for ${mode} (nominal ${nominal} m) — reported with every fix${
      running ? ' going out now' : ', once something is publishing'
    }.`,
  }
}

/** The phone's own GPS accuracy, as measured on this screen. */
export function deviceAccuracyCheck(live: DeviceAccuracy): ServiceCheck {
  const row = { id: 'accuracy-device', label: 'Phone GPS accuracy', group: 'accuracy' as const }
  if (live.state === 'measuring') {
    return { ...row, status: 'unknown', pill: 'Measuring', detail: 'Measuring: asking the phone for one fix.' }
  }
  if (live.state === 'unsupported') {
    return {
      ...row,
      status: 'unknown',
      detail: 'This page has no location API, so the phone\u2019s own accuracy cannot be read here.',
      fix: 'The Android app can: the accuracy it publishes is on the row above.',
    }
  }
  if (live.state === 'denied') {
    return {
      ...row,
      status: 'warn',
      detail: 'Location is blocked for this app, so the real accuracy is unknown.',
      fix: 'Allow Location for Spot Picker in the app settings.',
    }
  }
  if (live.state === 'error') {
    return {
      ...row,
      status: 'warn',
      detail: live.message ?? 'The phone did not return a fix.',
      fix: 'Try again near a window; indoors a phone may refuse to produce a fix at all.',
    }
  }
  if (live.state === 'ready' && live.metres != null) {
    const band = accuracyBand(live.metres)
    const age = live.at ? Math.max(0, Math.round((Date.now() - live.at) / 1000)) : null
    return {
      ...row,
      status: band.tone === 'danger' ? 'warn' : 'ok',
      detail: `${live.metres.toFixed(1)} m — ${band.label}${age != null ? `, ${age} s ago` : ''}. ${band.hint}`,
      ...(band.tone === 'danger'
        ? { fix: 'Move away from buildings or roofs and measure again: a coarse fix is what a mock has to look better than.' }
        : {}),
    }
  }
  return {
    ...row,
    status: 'unknown',
    pill: 'Not measured',
    detail: 'Not measured on this screen yet.',
    fix: 'Tap Measure to compare the phone\u2019s own accuracy with the accuracy this app publishes.',
  }
}

/** Both accuracy rows, ready to sit in the list. */
export function accuracyChecks(mode: RouteModeId, live: DeviceAccuracy, running: boolean): ServiceCheck[] {
  return [publishedAccuracyCheck(mode, running), deviceAccuracyCheck(live)]
}

/** The accuracy reading a successful fix carries. */
export function accuracyFromFix(metres: number, at: number): DeviceAccuracy {
  if (!Number.isFinite(metres) || metres < 0) {
    return { state: 'error', metres: null, at: null, message: 'The phone reported a fix with no usable accuracy.' }
  }
  return { state: 'ready', metres, at, message: null }
}

/**
 * A refused fix, in the phone's own terms.
 *
 * The three codes are the browser's, and they mean genuinely different things:
 * 1 is a decision (the user or the platform said no), 2 is the phone being
 * unable to work out where it is, and 3 is time running out — a fix that never
 * arrives looks exactly like a fix that is not allowed, and the fix for one does
 * not help with the other.
 */
export function accuracyFromError(code: number, message?: string): DeviceAccuracy {
  if (code === 1) {
    return {
      state: 'denied',
      metres: null,
      at: null,
      message: message ?? 'Location permission was refused.',
    }
  }
  if (code === 3) {
    return { state: 'error', metres: null, at: null, message: 'The phone took too long to produce a fix.' }
  }
  return {
    state: 'error',
    metres: null,
    at: null,
    message: message ?? 'The phone could not work out where it is.',
  }
}

/** The subset of the Geolocation API this screen uses, so it can be faked. */
export type GeolocationLike = {
  watchPosition: (
    onFix: (position: { coords: { accuracy: number } }) => void,
    onError: (error: { code: number; message?: string }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ) => number
  clearWatch: (id: number) => void
}

/**
 * Measures the phone's own accuracy, once, then stops listening.
 *
 * It is deliberately a measurement rather than a subscription: the number this
 * screen wants is "what does a real fix look like here", and a receiver that is
 * being watched keeps its radio warm for as long as the screen is open.
 *
 * Returns a stop function, which is also what cancels the give-up timer.
 */
export function watchDeviceAccuracy(
  onChange: (next: DeviceAccuracy) => void,
  options: { geo?: GeolocationLike | null; windowMs?: number } = {},
): () => void {
  const geo = options.geo === undefined ? (typeof navigator === 'undefined' ? null : navigator.geolocation ?? null) : options.geo
  if (!geo) {
    onChange({ state: 'unsupported', metres: null, at: null, message: 'This page has no location API.' })
    return () => {}
  }

  let done = false
  let watchId: number | null = null
  const finish = (next: DeviceAccuracy) => {
    if (done) return
    done = true
    if (watchId != null) {
      try {
        geo.clearWatch(watchId)
      } catch {
        /* the watch is already gone */
      }
      watchId = null
    }
    if (timer) clearTimeout(timer)
    onChange(next)
  }

  const windowMs = options.windowMs ?? 15_000
  const timer = setTimeout(() => {
    finish({ state: 'error', metres: null, at: null, message: `No fix arrived within ${Math.round(windowMs / 1000)} s.` })
  }, windowMs)

  onChange({ state: 'measuring', metres: null, at: null, message: null })
  watchId = geo.watchPosition(
    (position) => finish(accuracyFromFix(position.coords.accuracy, Date.now())),
    (error) => finish(accuracyFromError(error.code, error.message)),
    { enableHighAccuracy: true, timeout: windowMs, maximumAge: 0 },
  )
  // A fix handed over synchronously lands before `watchId` exists, so the
  // cleanup above could not cancel anything and the watch would stay open with
  // nothing left to receive. The radio is put back down here instead.
  if (done && watchId != null) {
    try {
      geo.clearWatch(watchId)
    } catch {
      /* the watch is already gone */
    }
    watchId = null
  }

  return () => {
    if (watchId != null) {
      try {
        geo.clearWatch(watchId)
      } catch {
        /* already gone */
      }
      watchId = null
    }
    done = true
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// The app's own state
// ---------------------------------------------------------------------------

export function lockCheck(facts: {
  passphraseSet: boolean
  unlocked: boolean
  fingerprintAvailable: boolean
  fingerprintReason?: string
}): ServiceCheck {
  if (!facts.passphraseSet) {
    return {
      id: 'lock',
      label: 'App lock',
      group: 'app',
      status: 'warn',
      detail: 'No passphrase has been set, so the app opens for anyone holding the phone.',
      fix: 'Set a passphrase on the lock screen. The Android build opens with the phone\u2019s own fingerprint instead.',
    }
  }
  return {
    id: 'lock',
    label: 'App lock',
    group: 'app',
    status: 'ok',
    detail: facts.unlocked
      ? 'Passphrase set, and this session is unlocked.'
      : 'Passphrase set, and this session is locked.',
  }
}

export function fingerprintDetail(facts: {
  fingerprintAvailable: boolean
  fingerprintReason?: string
}): string | null {
  if (facts.fingerprintAvailable) return 'Fingerprint unlock is available on this device.'
  return facts.fingerprintReason ?? null
}

// ---------------------------------------------------------------------------
// Verdicts and the copyable report
// ---------------------------------------------------------------------------

const SEVERITY: Record<ServiceStatus, number> = { unknown: 0, ok: 1, warn: 2, fail: 3 }

/** The worst status in a list: one broken service must not hide behind good ones. */
export function worstStatus(checks: ServiceCheck[]): ServiceStatus {
  return checks.reduce<ServiceStatus>(
    (worst, check) => (SEVERITY[check.status] > SEVERITY[worst] ? check.status : worst),
    'unknown',
  )
}

export type Summary = {
  status: ServiceStatus
  ok: number
  warn: number
  fail: number
  unknown: number
  headline: string
}

export function summarise(checks: ServiceCheck[]): Summary {
  const count = (status: ServiceStatus) => checks.filter((check) => check.status === status).length
  const fail = count('fail')
  const warn = count('warn')
  const unknown = count('unknown')
  const status = worstStatus(checks)
  const problems = fail + warn
  const headline = !checks.length
    ? 'Nothing checked yet.'
    : fail
      ? `${fail} thing${fail === 1 ? '' : 's'} stopping the app from working${warn ? `, ${warn} to watch` : ''}.`
      : problems
        ? `Working, with ${warn} thing${warn === 1 ? '' : 's'} to watch.`
        : unknown === checks.length
          ? 'Nothing has been measured yet.'
          : 'Everything checked out.'
  return { status, ok: count('ok'), warn, fail, unknown, headline }
}

/** Everything the screen shows in one list, in the order it shows it. */
export type DiagnosticFacts = {
  mockState: MockState
  probe: ProbeResult | null
  testing: boolean
  style: StyleProbe
  /** Base URL the bundle is served from (`import.meta.env.BASE_URL`). */
  base: string
  counts: { favorites: number; trips: number; recent: number }
  lock: {
    passphraseSet: boolean
    unlocked: boolean
    fingerprintAvailable: boolean
    fingerprintReason?: string
  }
  /** Injected by tests so a check can be run without the network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Runs the checks that need the outside world, in parallel, and returns the
 * whole list with the synchronous ones included. The accuracy rows are not in
 * here: they are measured on the screen itself, where the permission prompt and
 * the meter belong.
 */
export async function probeServices(
  facts: Pick<DiagnosticFacts, 'style' | 'base' | 'fetchImpl' | 'timeoutMs'>,
): Promise<ServiceCheck[]> {
  const opts: ProbeOptions = { fetchImpl: facts.fetchImpl, timeoutMs: facts.timeoutMs }
  return Promise.all([
    probeSearchProvider(opts),
    probeRoutingProvider(opts),
    probeTileProvider(facts.style, opts),
    probeTileBundle(facts.style, facts.base, opts),
    probePlaceData(facts.base, opts),
  ])
}

export async function runAllChecks(facts: DiagnosticFacts): Promise<ServiceCheck[]> {
  const probes = await probeServices(facts)

  return [
    ...deviceChecks(facts.mockState),
    ...deliveryChecks(facts.probe, facts.testing),
    ...probes,
    storageCheck(facts.counts),
    lockCheck(facts.lock),
  ]
}

/** A plain-text report to copy into a message, with the fixes included. */
export function reportText(
  checks: ServiceCheck[],
  extra: { generatedAt: number; native?: string | null; facts?: DiagnosticFacts },
): string {
  const summary = summarise(checks)
  const lines = [
    'Spot Picker diagnostics',
    `Generated ${new Date(extra.generatedAt).toISOString()}`,
    `${summary.status.toUpperCase()}: ${summary.headline}`,
    '',
  ]
  for (const check of checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}${check.ms != null ? ` (${formatLatency(check.ms)})` : ''}`)
    if (check.fix) lines.push(`    fix: ${check.fix}`)
  }
  if (extra.facts) {
    // The style is an object; interpolating it would print [object Object] and
    // tell whoever reads the report nothing about which basemap was checked.
    lines.push('', `bundle base: ${extra.facts.base}`, `map style: ${extra.facts.style.label}`)
  }
  if (extra.native) lines.push('', extra.native)
  return lines.join('\n')
}
