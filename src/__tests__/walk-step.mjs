#!/usr/bin/env node
/**
 * Regression tests for the joystick's walk maths in src/lib/walk.ts.
 *
 * The stick is the only control that moves the mock by hand, and its failures
 * are quiet ones: a deadzone that swallows an honest push, a diagonal that
 * walks root-two times too fast, or — the mistake this file exists for — a
 * "walk" that moves the mock once and then stands still, which reads as the
 * phone freezing rather than as arithmetic.
 *
 * Pure geometry, no network, no dependencies. Run with `npm test`.
 */
import { WALK_DEADZONE, WALK_TICK_MS, walkStep } from '../lib/walk.ts'
import { distanceMetres, nudge } from '../lib/route.ts'
import { ROUTE_MODES } from '../lib/types.ts'

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

/** How far a step travels, whichever way it points. */
const length = (step) => (step ? Math.hypot(step.northMetres, step.eastMetres) : 0)
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance
/** The distance one tick of the walk covers at a pace, in metres. */
const tickMetres = (speedKmh) => (speedKmh / 3.6) * (WALK_TICK_MS / 1000)

// ---------------------------------------------------------------------------
section('1. Which way is which')
// ---------------------------------------------------------------------------
const north = walkStep(0, -1, 5)
const south = walkStep(0, 1, 5)
const east = walkStep(1, 0, 5)
const west = walkStep(-1, 0, 5)
const northEast = walkStep(Math.SQRT1_2, -Math.SQRT1_2, 5)
const southWest = walkStep(-Math.SQRT1_2, Math.SQRT1_2, 5)

check(
  'pushing up walks north',
  north && north.northMetres > 0 && close(north.eastMetres, 0),
  JSON.stringify(north),
)
check(
  'pushing down walks south',
  south && south.northMetres < 0 && close(south.eastMetres, 0),
  JSON.stringify(south),
)
check(
  'pushing right walks east',
  east && east.eastMetres > 0 && close(east.northMetres, 0),
  JSON.stringify(east),
)
check(
  'pushing left walks west',
  west && west.eastMetres < 0 && close(west.northMetres, 0),
  JSON.stringify(west),
)
check(
  'up and right is north-east, both ways at once',
  northEast && northEast.northMetres > 0 && northEast.eastMetres > 0,
  JSON.stringify(northEast),
)
check(
  'down and left is south-west',
  southWest && southWest.northMetres < 0 && southWest.eastMetres < 0,
  JSON.stringify(southWest),
)

// ---------------------------------------------------------------------------
section('2. One step of the walk')
// ---------------------------------------------------------------------------
check(
  '5 km/h walks 0.35 m in one tick',
  close(length(north), tickMetres(5)),
  `${length(north).toFixed(4)} m vs ${tickMetres(5).toFixed(4)} m`,
)
check(
  'the tick rate matches the service: four a second',
  WALK_TICK_MS === 250 && 1000 / WALK_TICK_MS === 4,
  `${WALK_TICK_MS} ms`,
)
check(
  '45 km/h walks nine times as far per tick',
  close(length(walkStep(0, -1, 45)) / length(north), 9, 1e-9),
  `${(length(walkStep(0, -1, 45)) / length(north)).toFixed(3)}×`,
)
check(
  'half a push is half the step',
  close(length(walkStep(0, -0.5, 5)), length(north) / 2),
  length(walkStep(0, -0.5, 5)).toFixed(4),
)
check(
  'a longer tick walks proportionally further',
  close(length(walkStep(0, -1, 5, 500)), 2 * length(north), 1e-9),
  length(walkStep(0, -1, 5, 500)).toFixed(4),
)
check('a zero pace has no step to take', walkStep(0, -1, 0) === null)
check('a negative pace is treated as stopped, not reversed', walkStep(0, -1, -20) === null)
check(
  'nonsense input walks nowhere',
  walkStep(Number.NaN, 0, 5) === null && walkStep(0, Infinity, 5) === null,
)

// ---------------------------------------------------------------------------
section('3. The deadzone')
// ---------------------------------------------------------------------------
check('a centred stick does not walk', walkStep(0, 0, 5) === null)
check(
  'a push inside the deadzone does not walk',
  walkStep(WALK_DEADZONE - 0.01, 0, 5) === null,
  `deadzone ${WALK_DEADZONE}`,
)
check(
  'a push just past the deadzone does walk',
  walkStep(WALK_DEADZONE + 0.01, 0, 5) !== null,
)
check(
  'the deadzone is a small share of the pad',
  WALK_DEADZONE > 0 && WALK_DEADZONE < 0.25,
  `${WALK_DEADZONE}`,
)

// ---------------------------------------------------------------------------
section('4. Diagonals are directions, not speed boosts')
// ---------------------------------------------------------------------------
check(
  'a 45° push walks exactly as far as a cardinal one',
  close(length(northEast), length(north)),
  `${length(northEast).toFixed(6)} vs ${length(north).toFixed(6)}`,
)
check(
  'the corner of the pad is clamped, not multiplied',
  close(length(walkStep(1, 1, 5)), length(north)) &&
    close(walkStep(1, 1, 5).northMetres, -walkStep(1, 1, 5).eastMetres),
  JSON.stringify(walkStep(1, 1, 5)),
)
check(
  'the two halves of a 45° step are equal',
  close(northEast.northMetres, northEast.eastMetres),
  `${northEast.northMetres} vs ${northEast.eastMetres}`,
)

// ---------------------------------------------------------------------------
section('5. A held stick walks, continuously')
// ---------------------------------------------------------------------------
const start = { lat: 52, lon: 13 }
const TICKS = 20
let at = start
let firstStep = null
let shortestStep = Infinity
for (let tick = 0; tick < TICKS; tick += 1) {
  const step = walkStep(0, -1, 5)
  const stepLength = length(step)
  if (firstStep === null) firstStep = stepLength
  if (stepLength < shortestStep) shortestStep = stepLength
  at = nudge(at, step.northMetres, step.eastMetres)
}
const walked = distanceMetres(start, at)
check(
  'a held stick keeps walking for every tick it is held',
  close(walked, TICKS * firstStep, 0.02),
  `${walked.toFixed(2)} m over ${TICKS} ticks, expected ${(TICKS * firstStep).toFixed(2)} m`,
)
check(
  'no tick decays or stalls: every step is the same length',
  close(shortestStep, firstStep),
  `shortest ${shortestStep.toFixed(6)} vs first ${firstStep.toFixed(6)}`,
)
check(
  'one second of ticks covers the pace: 1.39 m at 5 km/h',
  close(4 * firstStep, 5 / 3.6, 0.01),
  `${(4 * firstStep).toFixed(3)} m vs ${(5 / 3.6).toFixed(3)} m`,
)
check('the walk goes forward, not back to where it started', at.lat > start.lat && close(at.lon, start.lon, 1e-9), JSON.stringify(at))
check(
  'walking east moves longitude only',
  (() => {
    const moved = nudge(start, walkStep(1, 0, 5).northMetres, walkStep(1, 0, 5).eastMetres)
    return close(moved.lat, start.lat, 1e-9) && moved.lon > start.lon
  })(),
)
check(
  'a stick held for a minute at 45 km/h walks 750 m',
  close(length(walkStep(0, -1, 45)) * 240, 750, 0.01),
  `${(length(walkStep(0, -1, 45)) * 240).toFixed(1)} m`,
)

// ---------------------------------------------------------------------------
section('6. The paces the stick offers')
// ---------------------------------------------------------------------------
check(
  'the paces are the app’s own travel modes',
  ROUTE_MODES.map((mode) => mode.defaultSpeedKmh).join(',') === '5,12,20,45',
  ROUTE_MODES.map((mode) => mode.defaultSpeedKmh).join(','),
)
check(
  'every offered pace walks on the first tick',
  ROUTE_MODES.every((mode) => length(walkStep(0, -1, mode.defaultSpeedKmh)) > 0),
)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ the joystick walk is wrong — ${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`    • ${failure}`)
  console.error('')
  process.exit(1)
}

process.stdout.write(`\n✓ the joystick walk is sound (${checks} checks)\n`)
