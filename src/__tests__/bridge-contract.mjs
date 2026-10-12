#!/usr/bin/env node
/**
 * Regression test for the mock-location bridge contract.
 *
 * The Android wrapper talks to the web app through a WebView JavaScript
 * interface (`window.SpotPicker`). Nothing type-checks across that boundary:
 * Kotlin is not aware of `native.ts`, and `native.ts` cannot see the Kotlin
 * source. A method rename, a changed JSON key or a new service event therefore
 * fails silently at runtime — on a phone, with no useful error.
 *
 * This test closes that gap by reading both sides as text and asserting that
 * they still describe the same contract. It is pure static analysis: no
 * emulator, no build, no dependencies. Run it with `npm test`.
 *
 * Checks performed
 *   1. Every @JavascriptInterface method exists in the TS `NativeApi` type and
 *      vice versa, with matching parameter and return types.
 *   2. The JSON keys `getStatus()` emits are exactly the fields of MockState.
 *   3. `getMockState()` reads every field of that payload (or documents why not).
 *   4. The { ok, error } envelope of start/stop matches the TS MockResult type.
 *   5. The native event `type` values are exactly the ones the web app handles
 *      (App.tsx, plus the lock screen's verdict handler in security.ts), and
 *      every event field App.tsx reads is one the native side emits.
 *   6. Every travel mode the web app can send is a MotionMode the native side
 *      understands — the ids are a contract like any other, and an unknown one
 *      would silently downgrade a run to a walk.
 *   7. Every global the Android side publishes (the injected "SpotPicker"
 *      object and the document-start "SpotPickerEvents" hook) is referenced by
 *      the client, so neither can be renamed on one side only.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..') // spot-picker/
const REPO = join(WEB, '..') // project root

const SOURCES = {
  bridge: 'spot-picker/android/app/src/main/java/com/spotpicker/app/SpotPickerBridge.kt',
  service: 'spot-picker/android/app/src/main/java/com/spotpicker/app/MockLocationService.kt',
  activity: 'spot-picker/android/app/src/main/java/com/spotpicker/app/MainActivity.kt',
  // The update probe reports through the same event channel as the service, so
  // its event names and payload keys are part of the same contract.
  probe: 'spot-picker/android/app/src/main/java/com/spotpicker/app/LocationUpdateProbe.kt',
  mode: 'spot-picker/android/app/src/main/java/com/spotpicker/app/MotionMode.kt',
  route: 'spot-picker/src/lib/route.ts',
  // The diagnostics screen states the accuracy the mock claims with every fix;
  // it is web-side text, but it describes a Kotlin number.
  diagnostics: 'spot-picker/src/lib/diagnostics.ts',
  native: 'spot-picker/src/lib/native.ts',
  types: 'spot-picker/src/lib/types.ts',
  app: 'spot-picker/src/App.tsx',
  // The fingerprint verdict is the one event App.tsx does not handle itself:
  // it is consumed by the lock screen, which is driven from here.
  security: 'spot-picker/src/lib/security.ts',
}

// ---------------------------------------------------------------------------
// Tiny assertion helpers — enough structure to print a readable diff, not a
// test framework.
// ---------------------------------------------------------------------------

const failures = []
let checks = 0

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

function pass(label) {
  checks++
  process.stdout.write(`  ok    ${label}\n`)
}

function fail(label, detail) {
  checks++
  failures.push(label)
  process.stdout.write(`  FAIL  ${label}\n`)
  for (const line of detail.split('\n')) process.stdout.write(`        ${line}\n`)
}

/** Asserts two string sets are identical, reporting which side owns each item. */
function sameSet(label, actual, expected, names = ['kotlin', 'typescript']) {
  const a = [...new Set(actual)].sort()
  const b = [...new Set(expected)].sort()
  const missing = b.filter((x) => !a.includes(x)) // expected but absent from actual
  const extra = a.filter((x) => !b.includes(x)) // in actual but not expected
  if (!missing.length && !extra.length) {
    pass(`${label} — ${a.length} in sync`)
    return
  }
  const lines = []
  if (missing.length) lines.push(`missing from ${names[0]}: ${missing.join(', ')}`)
  if (extra.length) lines.push(`only in ${names[0]}, not ${names[1]}: ${extra.join(', ')}`)
  fail(label, lines.join('\n'))
}

/** Asserts every item of `subset` appears in `superset`. */
function subsetOf(label, subset, superset, names = ['reader', 'producer']) {
  const missing = [...new Set(subset)].filter((x) => !superset.includes(x)).sort()
  if (!missing.length) {
    pass(label)
    return
  }
  fail(label, `${names[0]} uses ${missing.join(', ')} but ${names[1]} never provides it`)
}

// ---------------------------------------------------------------------------
// Source readers
// ---------------------------------------------------------------------------

function read(rel) {
  return readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Returns the brace-delimited body of the first function-like construct that
 * follows `needle`. Used for both Kotlin and TypeScript, so it deliberately
 * knows nothing about either language beyond brace counting.
 */
function braceBody(src, needle) {
  const start = src.indexOf(needle)
  if (start === -1) throw new Error(`could not find "${needle}"`)
  const open = src.indexOf('{', start)
  if (open === -1) throw new Error(`no opening brace after "${needle}"`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced braces after "${needle}"`)
}

/** `put("key", …)` string keys inside a JSONObject builder. */
function jsonKeys(body) {
  return [...body.matchAll(/put\("([\w.]+)"/g)].map((m) => m[1])
}

function unique(list) {
  return [...new Set(list)].sort()
}

// ---------------------------------------------------------------------------
// Kotlin side
// ---------------------------------------------------------------------------

const KOTLIN_TYPE = {
  Boolean: 'boolean',
  String: 'string',
  Double: 'number',
  Float: 'number',
  Int: 'number',
  Long: 'number',
}

function kotlinReturn(raw) {
  if (!raw) return 'void' // no return type == Unit
  return KOTLIN_TYPE[raw] ?? raw
}

function kotlinParamTypes(raw) {
  if (!raw.trim()) return []
  return raw.split(',').map((p) => {
    const type = p.split(':')[1]?.trim()
    if (!type) throw new Error(`cannot parse Kotlin parameter "${p.trim()}"`)
    return KOTLIN_TYPE[type] ?? type
  })
}

/** Method name -> { params: string[], returns: string } for @JavascriptInterface. */
function kotlinBridgeMethods(src) {
  const out = new Map()
  const re = /@JavascriptInterface\s+fun\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w.?]+))?/g
  for (const m of src.matchAll(re)) {
    out.set(m[1], { params: kotlinParamTypes(m[2]), returns: kotlinReturn(m[3]) })
  }
  return out
}

// ---------------------------------------------------------------------------
// TypeScript side
// ---------------------------------------------------------------------------

const TS_TYPE = {
  boolean: 'boolean',
  string: 'string',
  void: 'void',
  undefined: 'void',
}

function tsReturn(raw) {
  return TS_TYPE[raw] ?? raw
}

function tsParamTypes(raw) {
  if (!raw.trim()) return []
  return raw.split(',').map((p) => {
    const type = p.split(':')[1]?.trim()
    if (!type) throw new Error(`cannot parse TypeScript parameter "${p.trim()}"`)
    return TS_TYPE[type] ?? type
  })
}

/** Members of the `NativeApi` type: name -> { params, returns }. */
function tsNativeApi(src) {
  const match = src.match(/\ntype NativeApi = \{([\s\S]*?)\n\}/)
  if (!match) throw new Error('type NativeApi not found in native.ts')
  const out = new Map()
  for (const m of match[1].matchAll(/^ {2}(\w+)\(([^)]*)\)\s*:\s*([^\n]+)$/gm)) {
    out.set(m[1], { params: tsParamTypes(m[2]), returns: tsReturn(m[3].trim()) })
  }
  return out
}

/**
 * Keys of an exported object type, single-line (`{ ok: boolean }`) or multi-line.
 * Comments are stripped first so a documented field cannot shadow a real one.
 */
function tsObjectKeys(src, typeName) {
  const body = braceBody(src, `export type ${typeName} = {`)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  return [...body.matchAll(/(?:^|[,;{\s])(\w+)\s*\??:/g)].map((m) => m[1])
}

// ---------------------------------------------------------------------------
// Load every source once.
// ---------------------------------------------------------------------------

let src
try {
  src = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, read(v)]))
} catch (err) {
  console.error(`\n✗ could not read a required source file:\n  ${err.message}`)
  process.exit(1)
}

try {
  // -------------------------------------------------------------------------
  section('1. Bridge methods (@JavascriptInterface ↔ NativeApi)')
  // -------------------------------------------------------------------------
  const kotlinMethods = kotlinBridgeMethods(src.bridge)
  const tsApi = tsNativeApi(src.native)

  sameSet(
    'method names',
    [...kotlinMethods.keys()],
    [...tsApi.keys()],
    ['Kotlin SpotPickerBridge.kt', 'TypeScript NativeApi'],
  )

  // Signature comparison only makes sense for methods present on both sides.
  const shared = [...kotlinMethods.keys()].filter((n) => tsApi.has(n)).sort()
  for (const name of shared) {
    const k = kotlinMethods.get(name)
    const t = tsApi.get(name)
    const sameParams =
      k.params.length === t.params.length && k.params.every((p, i) => p === t.params[i])
    if (k.returns === t.returns && sameParams) {
      pass(`signature ${name}(${t.params.join(', ')}) -> ${k.returns}`)
    } else {
      fail(
        `signature ${name}`,
        `Kotlin:     (${k.params.join(', ')}) -> ${k.returns}\n` +
          `TypeScript: (${t.params.join(', ')}) -> ${t.returns}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  section('2. getStatus() payload ↔ MockState')
  // -------------------------------------------------------------------------
  const statusKeys = unique(jsonKeys(braceBody(src.bridge, 'fun getStatus()')))
  const mockStateKeys = unique(tsObjectKeys(src.types, 'MockState'))
  sameSet('status fields', statusKeys, mockStateKeys, [
    'Kotlin getStatus()',
    'TypeScript MockState',
  ])

  // -------------------------------------------------------------------------
  section('3. getMockState() reads what the bridge sends')
  // -------------------------------------------------------------------------
  const readKeys = unique(
    [...braceBody(src.native, 'export function getMockState').matchAll(/\bparsed\.(\w+)/g)].map(
      (m) => m[1],
    ),
  )
  subsetOf('parsed fields exist in the payload', readKeys, statusKeys)

  // Fields the bridge sends but the client never reads must be intentional.
  const HARDCODED = {
    available: 'the client hardcodes `available: true` — a working bridge proves it',
  }
  const unread = statusKeys.filter((k) => !readKeys.includes(k))
  const undocumented = unread.filter((k) => !(k in HARDCODED))
  if (undocumented.length) {
    fail(
      'every status field is read or documented',
      `never read by getMockState() and not in HARDCODED: ${undocumented.join(', ')}`,
    )
  } else {
    pass(`every status field is read or documented (${unread.join(', ') || 'none'})`)
  }

  // -------------------------------------------------------------------------
  section('4. start/stop result envelope ↔ MockResult')
  // -------------------------------------------------------------------------
  const okKeys = unique(jsonKeys(braceBody(src.bridge, 'private fun okJson()')))
  const errKeys = unique(jsonKeys(braceBody(src.bridge, 'private fun errorJson(')))
  sameSet('okJson()/errorJson() share one shape', okKeys, errKeys, [
    'okJson()',
    'errorJson()',
  ])
  sameSet('result envelope fields', okKeys, tsObjectKeys(src.native, 'MockResult'), [
    'Kotlin json helpers',
    'TypeScript MockResult',
  ])

  // -------------------------------------------------------------------------
  section('5. Native events ↔ App.tsx')
  // -------------------------------------------------------------------------
  // Every place a payload is built natively: the hand-written JSON templates in
  // the service and probe, plus the JSONObject events the bridge (fingerprint
  // verdict) and the activity (re-lock on background) send.
  const eventSources = [src.service, src.probe, src.bridge, src.activity]
  const emittedTypes = unique(
    eventSources.flatMap((text) => [
      ...[...text.matchAll(/"type"\s*:\s*"(\w+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/put\("type",\s*"(\w+)"\)/g)].map((m) => m[1]),
    ]),
  )
  const handledTypes = unique(
    [...(src.app + src.security).matchAll(/event\.type\s*[!=]==\s*'(\w+)'/g)].map((m) => m[1]),
  )
  sameSet('event types', handledTypes, emittedTypes, ['App.tsx handles', 'native side emits'])

  const emittedFields = unique(
    eventSources.flatMap((text) => [
      ...[...text.matchAll(/"(\w+)"\s*:/g)].map((m) => m[1]),
      ...[...text.matchAll(/put\("(\w+)"/g)].map((m) => m[1]),
    ]),
  )
  const readFields = unique([...src.app.matchAll(/event\.(\w+)\b/g)].map((m) => m[1]))
  subsetOf('event fields used by App.tsx are emitted', readFields, emittedFields, [
    'App.tsx',
    'the native event emitters',
  ])

  // Fields the web app reads out of a probe result come from readProbeResult(),
  // which is one hop away from the handler that receives the event.
  const readProbe = unique(
    [...braceBody(src.native, 'export function readProbeResult').matchAll(/event\.(\w+)/g)].map(
      (m) => m[1],
    ),
  )
  subsetOf('probe fields read by the client exist in the payload', readProbe, emittedFields, [
    'readProbeResult()',
    'LocationUpdateProbe.kt',
  ])

  // -------------------------------------------------------------------------
  section('6. Travel modes ↔ MotionMode')
  // -------------------------------------------------------------------------
  // The web app sends a mode id with every route; the native side turns it into
  // its own enum. An id that exists on one side only would not fail loudly — it
  // would quietly play the route as something else.
  const nativeModes = unique(
    [...src.mode.matchAll(/\b[A-Z]+\("([a-z]+)",/g)].map((m) => m[1]),
  )
  const modesArray = src.types.match(/export const ROUTE_MODES[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!modesArray) throw new Error('ROUTE_MODES not found in types.ts')
  const webModes = unique([...modesArray[1].matchAll(/id:\s*'(\w+)'/g)].map((m) => m[1]))
  subsetOf('every mode the web can send is a MotionMode', webModes, nativeModes, [
    'ROUTE_MODES in types.ts',
    'MotionMode.kt',
  ])
  // Modes the native side keeps to itself: a dropped pin and an unrecognised id.
  const NATIVE_ONLY_MODES = { stationary: 'a single pin', custom: 'the fallback' }
  const unreachable = nativeModes.filter(
    (m) => !webModes.includes(m) && !(m in NATIVE_ONLY_MODES),
  )
  if (unreachable.length) {
    fail(
      'every MotionMode is either offered by the web app or documented',
      `not in ROUTE_MODES and not native-only: ${unreachable.join(', ')}`,
    )
  } else {
    pass(`every MotionMode is offered or native-only (${nativeModes.join(', ')})`)
  }

  // -------------------------------------------------------------------------
  section('7. Route size limits')
  // -------------------------------------------------------------------------
  // The web app thins a road route down to the cap, and the bridge refuses
  // anything larger. Drift between the two means the web app would keep building
  // routes the bridge throws away, and a road route is much larger than the
  // handful of pins the cap was originally sized for.
  const kotlinCap = src.bridge.match(/MAX_ROUTE_POINTS\s*=\s*(\d+)/)
  const webCap = src.route.match(/MAX_ROUTE_POINTS\s*=\s*(\d+)/)
  if (!kotlinCap || !webCap) {
    fail(
      'both sides declare a route point cap',
      `SpotPickerBridge.kt: ${kotlinCap?.[1] ?? 'missing'}, route.ts: ${webCap?.[1] ?? 'missing'}`,
    )
  } else if (kotlinCap[1] === webCap[1]) {
    pass(`route point cap agrees (${kotlinCap[1]})`)
  } else {
    fail(
      'route point cap',
      `SpotPickerBridge.kt allows ${kotlinCap[1]} but route.ts thins to ${webCap[1]}`,
    )
  }

  // -------------------------------------------------------------------------
  section('8. Injected globals ↔ window declarations')
  // -------------------------------------------------------------------------
  // Two ways the Android side publishes a global: the injected interface object,
  // and the document-start script assigning to window (the event hook).
  const published = unique([
    ...[...src.activity.matchAll(/addJavascriptInterface\([^,]+,\s*"(\w+)"/g)].map((m) => m[1]),
    ...[...src.activity.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]),
  ])
  // Any `window.<name>` mention counts; the loop below only asks about names the
  // Android side actually publishes, so unrelated globals cannot create noise.
  const declared = unique([...src.native.matchAll(/window\.(\w+)/g)].map((m) => m[1]))
  for (const name of published) {
    if (declared.includes(name)) pass(`global "${name}" is published and used by the client`)
    else
      fail(
        `global "${name}"`,
        `MainActivity publishes "${name}" but native.ts never references window.${name}`,
      )
  }
  if (!published.length) fail('published globals', 'no injected/assigned window global found')

  // -------------------------------------------------------------------------
  section('9. Stated fix accuracy ↔ MotionMode.accuracyMetres')
  // -------------------------------------------------------------------------
  // The diagnostics screen has to *say* what accuracy the mock reports, because
  // the web side cannot measure a fix it does not send. That number is copied
  // from the Kotlin enum, so a receiver described on screen as "8 m" while the
  // phone publishes 6 m would go unnoticed until someone compared them.
  const accuracyBlock = src.diagnostics.match(
    /export const FIX_ACCURACY_METRES[^=]*=\s*\{([\s\S]*?)\n\}/,
  )
  if (!accuracyBlock) {
    fail('diagnostics states a fix accuracy per mode', 'FIX_ACCURACY_METRES not found in diagnostics.ts')
  } else {
    const stated = new Map(
      unique([...accuracyBlock[1].matchAll(/(\w+):\s*(\d+(?:\.\d+)?)/g)].map((m) => [m[1], m[2]])),
    )
    const fromKotlin = unique(
      [...src.mode.matchAll(/\b[A-Z]+\("([a-z]+)",\s*([\d.]+)f,/g)].map((m) => [m[1], m[2]]),
    )
    const drift = []
    for (const [id, metres] of fromKotlin) {
      if (!stated.has(id)) drift.push(`${id}: missing from the screen`)
      else if (stated.get(id) !== metres)
        drift.push(`${id}: screen says ${stated.get(id)} m, Kotlin says ${metres} m`)
    }
    for (const id of stated.keys()) {
      if (!fromKotlin.some(([m]) => m === id)) drift.push(`${id}: on screen but not a MotionMode`)
    }
    if (drift.length) {
      fail('stated fix accuracy matches MotionMode.accuracyMetres', drift.join('\n'))
    } else {
      pass(`every stated accuracy matches its MotionMode (${[...stated.keys()].join(', ')})`)
    }
  }
} catch (err) {
  console.error(`\n✗ the contract check could not run:\n  ${err.message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ bridge contract is out of sync — ${failures.length} check(s) failed:`)
  for (const f of failures) console.error(`    • ${f}`)
  console.error('\n  Update the Kotlin bridge and the TypeScript client together.\n')
  process.exit(1)
}

process.stdout.write(`\n✓ Kotlin and TypeScript mock-location contract in sync (${checks} checks)\n`)
