#!/usr/bin/env node
/**
 * Regression tests for the diagnostics screen's checks in src/lib/diagnostics.ts.
 *
 * The screen exists to answer one question — "what is broken, and what do I do
 * about it" — so the verdict and the fix are the product. Both are pure strings
 * computed from facts, which means they can be tested exactly: a row that says
 * `fail` without a fix, a fix that stops matching the button that performs it,
 * or a status word that quietly changes are all regressions the user would only
 * notice by trusting the screen at the moment it is wrong.
 *
 * The five network probes take their `fetch` as a parameter precisely so this
 * file can drive them from a table instead of the internet. Nothing here opens
 * a socket: every response, every HTTP status, every timeout and every refusal
 * is manufactured. Run with `npm test`.
 */
import {
  DEFAULT_TIMEOUT_MS,
  IDLE_ACCURACY,
  accuracyBand,
  accuracyFromError,
  accuracyFromFix,
  accuracyChecks,
  deviceAccuracyCheck,
  deviceChecks,
  deliveryChecks,
  fixAccuracyText,
  formatLatency,
  lockCheck,
  probePlaceData,
  probeRoutingProvider,
  probeSearchProvider,
  probeServices,
  probeTileBundle,
  probeTileProvider,
  publishedAccuracyCheck,
  reportText,
  storageCheck,
  summarise,
  tileSampleUrl,
  watchDeviceAccuracy,
  worstStatus,
} from '../lib/diagnostics.ts'
import { mapStyle } from '../lib/map-style.ts'

const failures = []
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`  ok    ${label}\n`)
    return
  }
  failures.push(label)
  process.stdout.write(`  FAIL  ${label}\n`)
  if (detail) {
    for (const line of String(detail).split('\n')) process.stdout.write(`        ${line}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

/**
 * Asserts a whole row at once: verdict, wording, fix. Comparing the fix string
 * character for character is the point — the fix is what the user follows, and
 * a fix that has drifted into saying the wrong thing is a broken screen that
 * still renders.
 */
function expectRow(label, actual, wanted) {
  const problems = []
  if (!actual) problems.push('row is missing')
  for (const [key, value] of Object.entries(wanted)) {
    if (actual?.[key] !== value) {
      problems.push(`${key}:\n  expected ${JSON.stringify(value)}\n  actual   ${JSON.stringify(actual?.[key])}`)
    }
  }
  check(label, problems.length === 0, problems.join('\n'))
}

/** A response as `timedFetch` sees it: ok, status, and a headers.get. */
function reply(status, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  }
}

/**
 * A fetch that answers from a table, keyed by the substring that identifies
 * the URL. Every call is recorded so a test can also prove *what* was asked
 * for, and that nothing outside the table was touched.
 */
function stubFetch(table, calls = []) {
  const stub = async (url, init) => {
    calls.push({ url, init })
    const hit = table.find(([part]) => url.includes(part))
    if (!hit) throw new TypeError(`the stub was asked for an unexpected URL: ${url}`)
    const [, spec] = hit
    if (spec instanceof Error) throw spec
    return reply(spec.status ?? 200, spec.contentType)
  }
  stub.calls = calls
  return stub
}

const STYLE = mapStyle('light')
const BASE = '/'

// The suite must run with the network closed. Every probe is handed a stub, and
// this makes sure it stays that way: a check that forgets one fails here instead
// of quietly reaching the internet, which is exactly what "offline" has to mean
// for a test someone runs on a plane.
const pageFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('this test must not reach the network')
}

// ---------------------------------------------------------------------------
section('1. The tile provider probe')
// ---------------------------------------------------------------------------

{
  const ok = stubFetch([['tile.openstreetmap.org', { status: 200, contentType: 'image/png' }]])
  const row = await probeTileProvider(STYLE, { fetchImpl: ok })
  expectRow('a PNG from the tile server is a working row', row, {
    id: 'tiles-provider',
    group: 'services',
    status: 'ok',
    detail: 'Arrived from a.tile.openstreetmap.org.',
    fix: undefined,
  })
  check(
    'the sample tile is the world at zoom 2, not anywhere near the user',
    ok.calls[0].url === 'https://a.tile.openstreetmap.org/2/2/1.png',
    ok.calls[0].url,
  )
  check(
    'the request refuses the HTTP cache and asks for an image',
    ok.calls[0].init.cache === 'no-store' &&
      ok.calls[0].init.headers.Accept === 'image/png,image/*',
    JSON.stringify(ok.calls[0].init),
  )
  check(
    'a provider template is turned into one fixed tile',
    tileSampleUrl('https://{s}.example.com/{z}/{x}/{y}.png') === 'https://a.example.com/2/2/1.png',
    tileSampleUrl('https://{s}.example.com/{z}/{x}/{y}.png'),
  )
  check(
    'latency reads as milliseconds until it is worth a second',
    formatLatency(210) === '210 ms' && formatLatency(1400) === '1.4 s',
    `${formatLatency(210)} / ${formatLatency(1400)}`,
  )

  const portal = await probeTileProvider(STYLE, {
    fetchImpl: stubFetch([['tile.openstreetmap.org', { status: 200, contentType: 'text/html' }]]),
  })
  expectRow('a login portal answering with HTML is a warning with a way out', portal, {
    status: 'warn',
    detail: 'Answered with text/html instead of an image — a captive portal or a proxy is in the way.',
    fix: 'Open any website to finish signing in to the network, or use the bundled world map until you can.',
  })

  // Every status the server can answer with, in the words the screen shows.
  const statusCases = [
    [429, 'rate limited (HTTP 429)'],
    [403, 'refused the request (HTTP 403)'],
    [404, 'has nothing at that address (HTTP 404)'],
    [503, 'is having trouble (HTTP 503)'],
    [418, 'answered HTTP 418'],
  ]
  for (const [status, words] of statusCases) {
    const row = await probeTileProvider(STYLE, {
      fetchImpl: stubFetch([['tile.openstreetmap.org', { status }]]),
    })
    expectRow(`HTTP ${status} reads "${words}" and carries the tile fix`, row, {
      status: 'fail',
      detail: `The tile server ${words}.`,
      fix: 'Turn on data or Wi-Fi for street-level detail. The bundled world map keeps drawing without it, so nothing else stops working.',
    })
  }

  const unreachable = await probeTileProvider(STYLE, {
    fetchImpl: stubFetch([['tile.openstreetmap.org', new TypeError('Failed to fetch')]]),
  })
  expectRow('a connection that never opens says so and offers the same fix', unreachable, {
    status: 'fail',
    detail: 'The tile server could not be reached from this device.',
    fix: 'Turn on data or Wi-Fi for street-level detail. The bundled world map keeps drawing without it, so nothing else stops working.',
  })

  // The abort is produced two ways: a fetch that rejects like an aborted one,
  // and a fetch that hangs until the probe's own timer pulls the plug. The
  // second one proves the timer exists, which a synthetic reject cannot.
  const aborted = new Error('The operation was aborted.')
  aborted.name = 'AbortError'
  const rejected = await probeTileProvider(STYLE, { fetchImpl: async () => { throw aborted } })
  expectRow('an aborted request reports the window it waited', rejected, {
    status: 'fail',
    detail: `The tile server did not answer within ${DEFAULT_TIMEOUT_MS / 1000} s.`,
  })

  const started = Date.now()
  const hung = await probeTileProvider(STYLE, {
    timeoutMs: 60,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  const waited = Date.now() - started
  check(
    'a fetch that hangs is actually cut off by the timeout',
    hung.status === 'fail' && waited >= 60 && waited < 3000,
    `status ${hung.status}, waited ${waited} ms, detail: ${hung.detail}`,
  )

  // No fetch at all: the page is older than the API, or it has been removed.
  try {
    globalThis.fetch = undefined
    const noApi = await probeTileProvider(STYLE, {})
    expectRow('with no fetch at all the row still has words', noApi, {
      status: 'fail',
      detail: 'The tile server this app cannot make network requests.',
    })
  } finally {
    globalThis.fetch = pageFetch
  }
}

// ---------------------------------------------------------------------------
section('2. The bundled world map probe')
// ---------------------------------------------------------------------------

{
  const present = await probeTileBundle(STYLE, BASE, {
    fetchImpl: stubFetch([['/tiles/light/2/2/1.png', { status: 200, contentType: 'image/png' }]]),
  })
  expectRow('the shipped tile answers for itself', present, {
    id: 'tiles-bundle',
    status: 'ok',
    detail: 'Light, zooms 0–4, served from the app itself. Drawing without any network.',
    fix: undefined,
  })

  const missing = await probeTileBundle(STYLE, BASE, {
    fetchImpl: stubFetch([['/tiles/light/2/2/1.png', { status: 404 }]]),
  })
  expectRow('a build without its tiles says how to rebuild them', missing, {
    status: 'fail',
    detail: 'The Light world tiles are missing from this build (has nothing at that address (HTTP 404)).',
    fix: 'Reinstall the app, or rebuild it with `npm run tiles` — the offline world is generated, not fetched.',
  })
}

// ---------------------------------------------------------------------------
section('3. Place search')
// ---------------------------------------------------------------------------

{
  const up = await probeSearchProvider({
    fetchImpl: stubFetch([['nominatim.openstreetmap.org', { status: 200, contentType: 'application/json' }]]),
  })
  expectRow('a live answer is a working row', up, {
    id: 'search',
    label: 'Place search (Nominatim)',
    status: 'ok',
    detail: 'A live query for a real place came back with an answer.',
    fix: undefined,
  })

  const down = await probeSearchProvider({
    fetchImpl: stubFetch([['nominatim.openstreetmap.org', { status: 500 }]]),
  })
  expectRow('an outage names the service and points at the offline database', down, {
    status: 'fail',
    detail: 'The search service is having trouble (HTTP 500).',
    fix: 'Search needs a connection. The offline place database still answers for the biggest places, and saved spots and the map keep working.',
  })
}

// ---------------------------------------------------------------------------
section('4. Road routing')
// ---------------------------------------------------------------------------

{
  const up = await probeRoutingProvider({
    fetchImpl: stubFetch([['router.project-osrm.org', { status: 200, contentType: 'application/json' }]]),
  })
  expectRow('a real route is a working row', up, {
    id: 'routing',
    label: 'Road routing (OSRM)',
    status: 'ok',
    detail: 'Two points a few hundred metres apart came back with a road route.',
    fix: undefined,
  })

  const rateLimited = await probeRoutingProvider({
    fetchImpl: stubFetch([['router.project-osrm.org', { status: 429 }]]),
  })
  expectRow('a rate-limited router is a warning, not a failure', rateLimited, {
    status: 'warn',
    detail: 'The router rate limited (HTTP 429).',
    fix: 'Choose the direct line instead: a route at the chosen speed still runs, it just does not follow the roads.',
  })
}

// ---------------------------------------------------------------------------
section('5. The offline place database')
// ---------------------------------------------------------------------------

{
  const present = await probePlaceData(BASE, {
    fetchImpl: stubFetch([['/data/p/a.json', { status: 200, contentType: 'application/json' }]]),
  })
  expectRow('a shipped shard answers for itself', present, {
    id: 'gazetteer',
    status: 'ok',
    detail: 'Shards served from the app itself, so search works with no network.',
    fix: undefined,
  })

  const missing = await probePlaceData(BASE, {
    fetchImpl: stubFetch([['/data/p/a.json', { status: 404 }]]),
  })
  expectRow('a build without its database says how to rebuild it', missing, {
    status: 'fail',
    detail: 'A shard is missing from this build (has nothing at that address (HTTP 404)).',
    fix: 'Reinstall the app, or rebuild it with `npm run data` — the database is generated from GeoNames, not fetched at runtime.',
  })
}

// ---------------------------------------------------------------------------
section('6. All five service rows, from one stub')
// ---------------------------------------------------------------------------

{
  const fetch = stubFetch([
    ['nominatim.openstreetmap.org', { status: 200, contentType: 'application/json' }],
    ['router.project-osrm.org', { status: 200, contentType: 'application/json' }],
    ['tile.openstreetmap.org', { status: 200, contentType: 'image/png' }],
    ['/tiles/', { status: 200, contentType: 'image/png' }],
    ['/data/p/a.json', { status: 200, contentType: 'application/json' }],
  ])
  const rows = await probeServices({ style: STYLE, base: BASE, fetchImpl: fetch })
  check(
    'the screen checks exactly five services',
    rows.length === 5,
    rows.map((r) => r.id).join(', '),
  )
  check(
    'each service is represented once, in screen order',
    rows.map((r) => r.id).join(',') === 'search,routing,tiles-provider,tiles-bundle,gazetteer',
    rows.map((r) => r.id).join(','),
  )
  check(
    'every row came back working, and none of them carries a fix',
    rows.every((r) => r.status === 'ok' && r.fix == null),
    JSON.stringify(rows.filter((r) => r.status !== 'ok')),
  )
  check(
    'every request went to the stub — nothing touched the network',
    fetch.calls.length === 5,
    fetch.calls.map((c) => c.url).join('\n'),
  )
}

// ---------------------------------------------------------------------------
section('7. The mock-location provider rows')
// ---------------------------------------------------------------------------

{
  const browser = deviceChecks({
    available: false,
    appSelected: false,
    developerOptions: false,
    running: false,
    starting: false,
    hasPermission: false,
    error: null,
  })
  check('a browser shows one row, not a list of impossible prerequisites', browser.length === 1)
  expectRow('that row says why, and where to get the real thing', browser[0], {
    status: 'unknown',
    pill: 'Not here',
    detail: 'Not available here: a browser cannot publish a position to the rest of the device.',
    fix: 'Install the APK build of Spot Picker to mock the phone’s location.',
  })

  const ready = {
    available: true,
    appSelected: true,
    developerOptions: true,
    running: true,
    starting: false,
    hasPermission: true,
    error: null,
  }
  const allGood = deviceChecks(ready)
  check(
    'a ready phone produces four rows and no fixes to read',
    allGood.length === 4 && allGood.every((r) => r.status === 'ok' && r.fix == null),
    JSON.stringify(allGood.filter((r) => r.fix != null)),
  )

  // Each prerequisite, missing on its own, with the screen that fixes it.
  const prerequisites = [
    ['hasPermission', 'permission', 'Not granted. Android refuses every test location without it.', 'Tap Grant and allow Location while using the app.'],
    ['developerOptions', 'developer-options', 'Still hidden, and the mock location app picker does not exist until they are unlocked.', 'Open Settings, then About phone, then tap Build number seven times.'],
    ['appSelected', 'mock-app', 'Another app (or none) is selected, so Android may ignore this one.', 'In Developer options, tap Select mock location app and choose Spot Picker.'],
  ]
  for (const [field, id, detail, fix] of prerequisites) {
    const rows = deviceChecks({ ...ready, [field]: false })
    expectRow(`without ${field} the row fails and carries its fix`, rows.find((r) => r.id === id), {
      status: 'fail',
      detail,
      fix,
    })
  }

  const stopped = deviceChecks({ ...ready, running: false })
  expectRow('a stopped service is untested, not broken, and says how to start it', stopped.find((r) => r.id === 'service'), {
    status: 'unknown',
    pill: 'Idle',
    detail: 'Stopped. Nothing is being published right now.',
    fix: 'Press Start on the Live page to publish the selected spot.',
  })

  const starting = deviceChecks({ ...ready, running: false, starting: true })
  expectRow('a starting service warns and keeps the same fix', starting.find((r) => r.id === 'service'), {
    status: 'warn',
    pill: 'Starting',
    detail: 'Starting: Android has not confirmed the test providers yet.',
    fix: 'Press Start on the Live page to publish the selected spot.',
  })

  const errored = deviceChecks({ ...ready, running: false, error: 'Mock provider refused' })
  expectRow('the last Android error gets a row of its own', errored.find((r) => r.id === 'service-error'), {
    status: 'fail',
    detail: 'Mock provider refused',
    fix: 'Fix the row above that is failing, then start again — the app retries by itself once the selection is made.',
  })
  check('a healthy phone has no error row', deviceChecks(ready).every((r) => r.id !== 'service-error'))
}

// ---------------------------------------------------------------------------
section('8. Whether the fixes are delivered')
// ---------------------------------------------------------------------------

{
  const listening = deliveryChecks(null, true)
  expectRow('while the test listens, the row listens too', listening[0], {
    status: 'unknown',
    pill: 'Listening',
    detail: 'Listening for the fixes Android sends to apps that watch the position.',
    fix: undefined,
  })

  const neverTested = deliveryChecks(null, false)
  expectRow('an untested delivery path is untested, with the test offered', neverTested[0], {
    status: 'unknown',
    detail: 'Not tested yet. A one-shot location read can work even when live updates do not.',
    fix: 'Start the mock location, then run the live-update check below.',
  })

  const delivered = deliveryChecks(
    { ok: true, updates: 4, providers: 'gps,network', movedMetres: 12, worstGapMs: 900, mockFlagged: true, message: 'ok' },
    false,
  )
  expectRow('delivered fixes report what arrived', delivered[0], {
    status: 'ok',
    detail: '4 fixes arrived from gps,network, longest gap 900 ms.',
    fix: undefined,
  })
  check('a flagged, delivered test fix raises no second row', delivered.length === 1)

  const single = deliveryChecks(
    { ok: true, updates: 1, providers: 'gps', movedMetres: 1, worstGapMs: 0, mockFlagged: true, message: 'ok' },
    false,
  )
  expectRow('one fix is not "1 fixes"', single[0], {
    detail: '1 fix arrived from gps.',
  })

  const unflagged = deliveryChecks(
    { ok: true, updates: 4, providers: 'gps', movedMetres: 12, worstGapMs: 0, mockFlagged: false, message: 'ok' },
    false,
  )
  expectRow('fixes that arrive unflagged get their own warning', unflagged.find((r) => r.id === 'mock-flag'), {
    status: 'warn',
    detail: 'The fixes arrive but are not flagged as coming from a mock provider, so an app that checks will ignore them.',
    fix: 'Stop and start the mock location: the flag is set when the test provider is installed.',
  })

  const nothing = deliveryChecks(
    { ok: false, updates: 0, providers: '', movedMetres: 0, worstGapMs: 0, mockFlagged: false, message: 'nothing' },
    false,
  )
  expectRow('a silent test window is a failure with the settings that fix it', nothing[0], {
    status: 'fail',
    detail: 'Nothing arrived in the test window, so apps that subscribe to location are seeing the phone’s real position.',
    fix: 'Turn Location on and set it to High accuracy, and check that Google location accuracy (Wi-Fi and Bluetooth scanning) has not replaced Spot Picker as the mock location app.',
  })
}

// ---------------------------------------------------------------------------
section('9. The GPS accuracy rows')
// ---------------------------------------------------------------------------

{
  expectRow('the accuracy this app publishes, before anything is running', publishedAccuracyCheck('walk', false), {
    id: 'accuracy-published',
    status: 'ok',
    detail: '6.4–11.2 m for walk (nominal 8 m) — reported with every fix, once something is publishing.',
  })
  expectRow('the same row while fixes are going out', publishedAccuracyCheck('walk', true), {
    status: 'ok',
    detail: '6.4–11.2 m for walk (nominal 8 m) — reported with every fix going out now.',
  })
  check(
    'an unknown mode falls back to the walking-shaped default',
    fixAccuracyText('teleport') === '5.6–9.8 m',
    fixAccuracyText('teleport'),
  )

  const both = accuracyChecks('drive', IDLE_ACCURACY, false)
  check(
    'the accuracy section is the published row and the measured row, in that order',
    both.map((r) => r.id).join(',') === 'accuracy-published,accuracy-device',
    both.map((r) => r.id).join(','),
  )

  const idle = deviceAccuracyCheck(IDLE_ACCURACY)
  expectRow('an untouched measurement is untested, with the button offered', idle, {
    status: 'unknown',
    pill: 'Not measured',
    detail: 'Not measured on this screen yet.',
    fix: 'Tap Measure to compare the phone’s own accuracy with the accuracy this app publishes.',
  })

  expectRow('a measurement in progress says so', deviceAccuracyCheck({ state: 'measuring', metres: null, at: null, message: null }), {
    status: 'unknown',
    pill: 'Measuring',
    detail: 'Measuring: asking the phone for one fix.',
  })

  expectRow('a page with no location API points at the row above', deviceAccuracyCheck({ state: 'unsupported', metres: null, at: null, message: null }), {
    status: 'unknown',
    fix: 'The Android app can: the accuracy it publishes is on the row above.',
  })

  expectRow('permission refused gets the permission fix', deviceAccuracyCheck({ state: 'denied', metres: null, at: null, message: null }), {
    status: 'warn',
    detail: 'Location is blocked for this app, so the real accuracy is unknown.',
    fix: 'Allow Location for Spot Picker in the app settings.',
  })

  expectRow('a fix that never arrives says so, with the weather to try in', deviceAccuracyCheck({ state: 'error', metres: null, at: null, message: 'The phone took too long to produce a fix.' }), {
    status: 'warn',
    detail: 'The phone took too long to produce a fix.',
    fix: 'Try again near a window; indoors a phone may refuse to produce a fix at all.',
  })

  const good = deviceAccuracyCheck({ state: 'ready', metres: 4.2, at: Date.now(), message: null })
  check('a precise fix is a working row', good.status === 'ok', JSON.stringify(good))
  check(
    'and it is described with its band and its age',
    good.detail.startsWith('4.2 m — Excellent, 0 s ago. Good enough to tell one side of a street apart.'),
    good.detail,
  )
  check('a good fix needs no fix', good.fix == null)

  const coarse = deviceAccuracyCheck({ state: 'ready', metres: 45, at: Date.now(), message: null })
  expectRow('a coarse fix is a warning with what to do about it', coarse, {
    status: 'warn',
    detail: '45.0 m — Poor, 0 s ago. Too coarse to place a pin; a real receiver rarely reports this outdoors.',
    fix: 'Move away from buildings or roofs and measure again: a coarse fix is what a mock has to look better than.',
  })

  // The bands a receiver user would recognise by name.
  const bands = [
    [null, 'Unknown'],
    [0, 'Excellent'],
    [5, 'Excellent'],
    [6, 'Good'],
    [10, 'Good'],
    [11, 'Fair'],
    [30, 'Fair'],
    [31, 'Poor'],
  ]
  for (const [metres, label] of bands) {
    const band = accuracyBand(metres)
    check(`${metres} m is ${label}`, band.label === label, JSON.stringify(band))
  }

  // The two verdicts the measurement itself produces, without a radio.
  const fix = accuracyFromFix(4.2, 1_700_000_000_000)
  check('a fix is remembered with its number and its moment', fix.state === 'ready' && fix.metres === 4.2 && fix.at === 1_700_000_000_000, JSON.stringify(fix))
  check(
    'a fix with no accuracy is refused in words',
    accuracyFromFix(Number.NaN, 1).state === 'error' &&
      accuracyFromFix(Number.NaN, 1).message === 'The phone reported a fix with no usable accuracy.',
  )
  check(
    'code 1 is a decision, not a malfunction',
    accuracyFromError(1).state === 'denied' && accuracyFromError(1).message === 'Location permission was refused.',
  )
  check(
    'code 3 is time running out, which reads differently',
    accuracyFromError(3).state === 'error' && accuracyFromError(3).message === 'The phone took too long to produce a fix.',
  )
  check(
    'code 2 keeps the phone’s own explanation',
    accuracyFromError(2, 'POSITION_UNAVAILABLE').message === 'POSITION_UNAVAILABLE',
  )
}

// ---------------------------------------------------------------------------
section('10. Saving, and the lock')
// ---------------------------------------------------------------------------

{
  const broken = storageCheck({ favorites: 0, trips: 0, recent: 0 }, null)
  expectRow('no storage at all is a failure the user can undo', broken, {
    status: 'fail',
    detail: 'This app cannot reach local storage, so nothing you save will survive.',
    fix: 'Private browsing or a storage-blocking setting is on. Allow site data for this app, then save a spot to confirm.',
  })

  const readOnly = storageCheck({ favorites: 0, trips: 0, recent: 0 }, {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {},
  })
  expectRow('a read-only store fails on the write, not on the read', readOnly, {
    status: 'fail',
    detail: 'Local storage is full or read-only, so saving is unreliable.',
    fix: 'Free some space on the device, or clear this app’s storage to start again. Saved spots and trips are the first casualties.',
  })

  const memory = new Map()
  const working = storageCheck({ favorites: 1, trips: 1, recent: 0 }, {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  })
  expectRow('a working store reports what is at stake, counted properly', working, {
    status: 'ok',
    detail: 'Readable and writable — 1 spot, 1 trip, 0 recent searches.',
    fix: undefined,
  })
  check('the probe key is cleaned up after itself', !memory.has('spotpicker.diagnostics.probe'))

  expectRow('no passphrase is a warning, not a failure', lockCheck({ passphraseSet: false, unlocked: false, fingerprintAvailable: false }), {
    id: 'lock',
    status: 'warn',
    detail: 'No passphrase has been set, so the app opens for anyone holding the phone.',
    fix: 'Set a passphrase on the lock screen. The Android build opens with the phone’s own fingerprint instead.',
  })
  expectRow('a set passphrase with an open session is working', lockCheck({ passphraseSet: true, unlocked: true, fingerprintAvailable: false }), {
    status: 'ok',
    detail: 'Passphrase set, and this session is unlocked.',
    fix: undefined,
  })
  expectRow('a locked session still counts as working', lockCheck({ passphraseSet: true, unlocked: false, fingerprintAvailable: false }), {
    status: 'ok',
    detail: 'Passphrase set, and this session is locked.',
  })
}

// ---------------------------------------------------------------------------
section('11. The verdict on top of the screen')
// ---------------------------------------------------------------------------

{
  const row = (status) => ({ id: status, label: status, group: 'services', status, detail: status })

  check('nothing checked is not a pass', summarise([]).headline === 'Nothing checked yet.', summarise([]).headline)
  check(
    'one failure is described as one thing',
    summarise([row('fail')]).headline === '1 thing stopping the app from working.',
    summarise([row('fail')]).headline,
  )
  check(
    'failures are counted, and the warnings queued behind them',
    summarise([row('fail'), row('fail'), row('warn')]).headline ===
      '2 things stopping the app from working, 1 to watch.',
    summarise([row('fail'), row('fail'), row('warn')]).headline,
  )
  check(
    'warnings alone are still a pass to watch',
    summarise([row('ok'), row('warn')]).headline === 'Working, with 1 thing to watch.',
    summarise([row('ok'), row('warn')]).headline,
  )
  check(
    'untested is not the same as working',
    summarise([row('unknown'), row('unknown')]).headline === 'Nothing has been measured yet.',
    summarise([row('unknown'), row('unknown')]).headline,
  )
  check(
    'everything green says so plainly',
    summarise([row('ok'), row('ok')]).headline === 'Everything checked out.',
    summarise([row('ok'), row('ok')]).headline,
  )

  const summary = summarise([row('ok'), row('warn'), row('fail'), row('unknown')])
  check(
    'the counts add up',
    summary.ok === 1 && summary.warn === 1 && summary.fail === 1 && summary.unknown === 1 && summary.status === 'fail',
    JSON.stringify(summary),
  )
  check(
    'a failure outranks a warning outranks a pass outranks nothing',
    worstStatus([row('ok'), row('unknown'), row('warn'), row('fail')]) === 'fail' &&
      worstStatus([row('ok'), row('unknown'), row('warn')]) === 'warn' &&
      worstStatus([row('ok'), row('unknown')]) === 'ok' &&
      worstStatus([row('unknown')]) === 'unknown',
  )
}

// ---------------------------------------------------------------------------
section('12. The copyable report')
// ---------------------------------------------------------------------------

{
  const text = reportText(
    [
      { id: 'search', label: 'Place search (Nominatim)', group: 'services', status: 'ok', detail: 'A live query for a real place came back with an answer.', ms: 845 },
      { id: 'mock-app', label: 'Selected as mock app', group: 'device', status: 'fail', detail: 'Another app (or none) is selected, so Android may ignore this one.', fix: 'In Developer options, tap Select mock location app and choose Spot Picker.' },
    ],
    { generatedAt: Date.UTC(2026, 0, 2, 3, 4, 5), native: 'mock: ready' },
  )

  const withFacts = reportText([], {
    generatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    facts: { mockState: {}, probe: null, testing: false, style: STYLE, base: '/', counts: { favorites: 0, trips: 0, recent: 0 }, lock: { passphraseSet: false, unlocked: false, fingerprintAvailable: false } },
  })
  check(
    'the report names the basemap it checked, not [object Object]',
    withFacts.includes('bundle base: /') && withFacts.includes('map style: Light'),
    withFacts,
  )

  const wanted = [
    'Spot Picker diagnostics',
    'Generated 2026-01-02T03:04:05.000Z',
    'FAIL: 1 thing stopping the app from working.',
    '[OK] Place search (Nominatim): A live query for a real place came back with an answer. (845 ms)',
    '[FAIL] Selected as mock app: Another app (or none) is selected, so Android may ignore this one.',
    '    fix: In Developer options, tap Select mock location app and choose Spot Picker.',
    'mock: ready',
  ]
  for (const line of wanted) {
    check(`the report contains: ${line.slice(0, 60)}`, text.includes(line), text)
  }
  check(
    'the fix travels with the row it belongs to',
    text.indexOf('    fix: In Developer options') > text.indexOf('[FAIL] Selected as mock app'),
    text,
  )
}

// ---------------------------------------------------------------------------
section('13. Measuring the phone’s own accuracy, offline')
// ---------------------------------------------------------------------------

{
  // A receiver that answers immediately — the fix lands before watchPosition
  // has even returned its id, which is the one ordering a watch has to survive.
  const states = []
  const instant = {
    watchPosition: (onFix) => {
      onFix({ coords: { accuracy: 4.4 } })
      return 1
    },
    clearWatch: () => {},
  }
  const stopInstant = watchDeviceAccuracy((next) => states.push(next), { geo: instant })
  check(
    'the screen is told it is measuring, then the number',
    states.map((s) => s.state).join(',') === 'measuring,ready' && states[1].metres === 4.4,
    JSON.stringify(states),
  )
  check('an instant fix still returns a working stop function', typeof stopInstant === 'function')
  stopInstant()
  stopInstant()

  const denied = []
  watchDeviceAccuracy((next) => denied.push(next), {
    geo: {
      watchPosition: (onFix, onError) => {
        onError({ code: 1, message: 'User denied Geolocation' })
        return 2
      },
      clearWatch: () => {},
    },
  })
  check(
    'a refusal is reported as a refusal',
    denied.at(-1).state === 'denied' && denied.at(-1).message === 'User denied Geolocation',
    JSON.stringify(denied),
  )

  const noApi = []
  watchDeviceAccuracy((next) => noApi.push(next), { geo: null })
  check(
    'a page with no location API says so instead of hanging',
    noApi.length === 1 && noApi[0].state === 'unsupported',
    JSON.stringify(noApi),
  )

  // A receiver that never answers: the give-up timer has to fire by itself.
  const silent = []
  const startedAt = Date.now()
  watchDeviceAccuracy((next) => silent.push(next), {
    windowMs: 1000,
    geo: {
      watchPosition: () => 3,
      clearWatch: () => {},
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  check(
    'a fix that never arrives gives up on its own',
    silent.at(-1)?.state === 'error' && silent.at(-1)?.message === 'No fix arrived within 1 s.',
    `${JSON.stringify(silent)} after ${Date.now() - startedAt} ms`,
  )
}

// ---------------------------------------------------------------------------

globalThis.fetch = pageFetch

if (failures.length) {
  process.stderr.write(`\n✗ diagnostics checks are out of sync — ${failures.length} failed:\n`)
  for (const f of failures) process.stderr.write(`    • ${f}\n`)
  process.exit(1)
}
process.stdout.write(`\n✓ every diagnostics verdict and fix is covered, offline (${checks} checks)\n`)
