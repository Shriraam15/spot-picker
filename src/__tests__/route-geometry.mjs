#!/usr/bin/env node
/**
 * Regression tests for the route maths in src/lib/route.ts.
 *
 * These are here because the geometry decides what the phone actually plays: a
 * path that collapses, a distance that is wrong, or a progress split that skips
 * a corner would all look like a bug in the simulated movement rather than in
 * the arithmetic that produced it.
 *
 * The first check is a bug that was really shipped: the Douglas–Peucker pass
 * discarded the entire path whenever the worst deviation landed on the second
 * vertex — which is exactly an L-shaped road — turning a corner into a straight
 * chord. It was invisible at the time because routes short enough to fit under
 * the point cap skipped simplification altogether.
 *
 * Pure geometry, no network, no dependencies. Run with `npm test`.
 */
import {
  MAX_ROUTE_POINTS,
  MIN_SPEED_KMH,
  MAX_SPEED_KMH,
  ROUTE_DEVIATION_M,
  distanceMetres,
  durationSeconds,
  formatDistance,
  formatDuration,
  maxDeviationMetres,
  nudge,
  pathDistanceMetres,
  simplifyPath,
  splitRoute,
  thinToLimit,
} from '../lib/route.ts'

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

/** Percent difference between two lengths. */
const errorPercent = (measured, expected) => ((measured - expected) / expected) * 100

/** Metres to degrees, at a latitude where the tests live. */
const NORTH = (metres) => metres / 111_320
const EAST = (metres, lat) => metres / (111_320 * Math.cos((lat * Math.PI) / 180))

// ---------------------------------------------------------------------------
section('1. Distances')
// ---------------------------------------------------------------------------
const oneDegreeLat = distanceMetres({ lat: 52, lon: 13 }, { lat: 53, lon: 13 })
check(
  'a degree of latitude is about 111.2 km',
  Math.abs(oneDegreeLat - 111_195) < 100,
  `${Math.round(oneDegreeLat)} m`,
)
check(
  'a point is zero metres from itself',
  distanceMetres({ lat: 52.5, lon: 13.4 }, { lat: 52.5, lon: 13.4 }) === 0,
)
// Longitude degrees shorten with latitude, so the same delta is a shorter hop.
const lonAtEquator = distanceMetres({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })
const lonAtSixty = distanceMetres({ lat: 60, lon: 0 }, { lat: 60, lon: 1 })
check(
  'a degree of longitude shortens towards the poles',
  Math.abs(lonAtSixty - lonAtEquator / 2) < 500,
  `equator ${Math.round(lonAtEquator)} m, 60°N ${Math.round(lonAtSixty)} m`,
)

const legs = [
  { lat: 52.5, lon: 13.4 },
  { lat: 52.51, lon: 13.4 },
  { lat: 52.51, lon: 13.41 },
]
const byLegs = pathDistanceMetres(legs)
const bySum =
  distanceMetres(legs[0], legs[1]) + distanceMetres(legs[1], legs[2])
check('the path length is the sum of its legs', Math.abs(byLegs - bySum) < 1e-6)

// ---------------------------------------------------------------------------
section('2. Simplification (the L-shaped road regression)')
// ---------------------------------------------------------------------------
/**
 * An L: turn immediately, then run 2 km north, surveyed in one-metre steps.
 *
 * The shape matters. The corner must be the *second* point, because it is then
 * the vertex furthest from the chord between the ends, and the broken pass
 * refused to look any further whenever the worst deviation was one vertex in —
 * collapsing the whole corner into a single straight chord 8% shorter than the
 * road. Survey the same corner in 200 steps instead and the furthest vertex
 * lands in the middle of the turn, where the bug stayed hidden.
 */
const el = [
  { lat: 52.5, lon: 13.4 },
  { lat: 52.5, lon: 13.4 + EAST(200, 52.5) },
]
for (let i = 1; i <= 2000; i += 1) el.push({ lat: 52.5 + NORTH(i), lon: 13.4 + EAST(200, 52.5) })

const elRaw = pathDistanceMetres(el)
const elKept = simplifyPath(el, 3)
const elKeptLength = pathDistanceMetres(elKept)
check(
  'a corner is not simplified away',
  elKept.length >= 3,
  `${el.length} points → ${elKept.length}`,
)
check(
  'simplifying a corner keeps its length',
  Math.abs(errorPercent(elKeptLength, elRaw)) < 1,
  `${Math.round(elRaw)} m → ${Math.round(elKeptLength)} m ` +
    `(${errorPercent(elKeptLength, elRaw).toFixed(1)}%)`,
)

// A straight line really should collapse: this is what simplification is for.
const straight = Array.from({ length: 500 }, (_, i) => ({ lat: 52.5 + NORTH(i * 10), lon: 13.4 }))
const straightKept = simplifyPath(straight, 3)
check(
  'a straight line collapses to its ends',
  straightKept.length === 2,
  `${straight.length} points → ${straightKept.length}`,
)

// The first and last points are the ones the user picked: they never move.
check(
  'the ends of a path survive simplification exactly',
  straightKept[0].lat === straight[0].lat &&
    straightKept[0].lon === straight[0].lon &&
    straightKept[straightKept.length - 1].lat === straight[straight.length - 1].lat &&
    straightKept[straightKept.length - 1].lon === straight[straight.length - 1].lon,
)

// ---------------------------------------------------------------------------
section('3. The point cap and the road it must stay on')
// ---------------------------------------------------------------------------
/** A winding road: 3000 steps north, swinging east on a long wave. */
const winding = []
for (let i = 0; i < 3000; i += 1) {
  winding.push({ lat: 52.5 + NORTH(i * 20), lon: 13.4 + EAST(60 * Math.sin(i / 40), 52.5) })
}
const windingRaw = pathDistanceMetres(winding)
const capped = thinToLimit(winding)
const cappedLength = pathDistanceMetres(capped)
check(
  `a long path fits inside the ${MAX_ROUTE_POINTS}-point cap`,
  capped.length <= MAX_ROUTE_POINTS,
  `${winding.length} points → ${capped.length}`,
)
check(
  'capping a path keeps its shape, not just its ends',
  capped.length > 20,
  `${capped.length} points kept`,
)
check(
  'capping a path barely changes its length',
  Math.abs(errorPercent(cappedLength, windingRaw)) < 5,
  `${Math.round(windingRaw)} m → ${Math.round(cappedLength)} m ` +
    `(${errorPercent(cappedLength, windingRaw).toFixed(1)}%)`,
)
check(
  'capping keeps the endpoints exact',
  capped[0].lat === winding[0].lat &&
    capped[capped.length - 1].lat === winding[winding.length - 1].lat,
)
check(
  'a path already inside the cap is left alone',
  thinToLimit(legs).length === legs.length,
)

/**
 * How far a thinned path may stray from the road, in metres, asserted as a
 * literal on purpose.
 *
 * Measuring this with the module's own ROUTE_DEVIATION_M would let a laxer
 * constant pass its own test — which is exactly what happened the first time
 * this was written, and why the reckless-thinning mutation went undetected.
 * The road is what Google Maps will draw the dot on: a few metres is lost in the
 * accuracy the mock reports, tens of metres is a dot in the wrong street.
 */
const MAX_DEVIATION_ALLOWED_M = 20

/** The declared tolerance has to stay inside what the tests allow. */
check(
  `the documented deviation (${ROUTE_DEVIATION_M} m) is inside the allowed ${MAX_DEVIATION_ALLOWED_M} m`,
  ROUTE_DEVIATION_M <= MAX_DEVIATION_ALLOWED_M,
)

// `winding` curves at a ~60 m scale, so a path collapsed to its ends misses by
// 83 m — a number this check can actually catch, unlike a road that only bends
// once and is therefore described perfectly by three points.
for (const cap of [200, 1000, MAX_ROUTE_POINTS]) {
  const thinned = thinToLimit(winding, cap)
  const deviation = maxDeviationMetres(winding, thinned)
  check(
    `thinning to ${cap} points stays within ${MAX_DEVIATION_ALLOWED_M} m of the road`,
    thinned.length <= cap && deviation <= MAX_DEVIATION_ALLOWED_M,
    `${winding.length} points → ${thinned.length}, worst deviation ${deviation.toFixed(1)} m`,
  )
}

/**
 * A cap can be small enough that no path that size could follow this road: 60
 * points over 60 km of sine. When the deviation bound is unreachable, the job
 * changes — the path is allowed to be coarse, but it must still be *this road*:
 * the same length, the same ends, and never more points than asked for. Measured
 * here: 37 points, length off by 0.03%, deviation 28.7 m.
 *
 * Decimation is what handles this, and it follows the path rather than cutting
 * across it, which is why the length survives even when the shape cannot.
 */
const impossible = thinToLimit(winding, 60)
check(
  'an impossible cap still returns at most that many points',
  impossible.length <= 60,
  `${winding.length} points → ${impossible.length}`,
)
check(
  'an impossible cap still returns the same road, not a shortcut across it',
  Math.abs(errorPercent(pathDistanceMetres(impossible), windingRaw)) < 1,
  `${Math.round(windingRaw)} m → ${Math.round(pathDistanceMetres(impossible))} m ` +
    `(${errorPercent(pathDistanceMetres(impossible), windingRaw).toFixed(2)}%)`,
)
check(
  'an impossible cap still starts and ends exactly where the road does',
  impossible[0].lat === winding[0].lat &&
    impossible[0].lon === winding[0].lon &&
    impossible[impossible.length - 1].lat === winding[winding.length - 1].lat &&
    impossible[impossible.length - 1].lon === winding[winding.length - 1].lon,
)

/**
 * An L: turn immediately, then run 6 km north. It is described perfectly by
 * three points, so it is the length and the corner that matter here, not the
 * deviation.
 */
const cornerRoad = [{ lat: 52.5, lon: 13.4 }]
for (let i = 1; i <= 900; i += 1) {
  cornerRoad.push({ lat: 52.5, lon: 13.4 + EAST(i, 52.5) })
}
for (let i = 1; i <= 6000; i += 1) {
  cornerRoad.push({ lat: 52.5 + NORTH(i), lon: 13.4 + EAST(900, 52.5) })
}
const cornerThinned = thinToLimit(cornerRoad, 200)
check(
  'thinning a corner keeps the corner and its length',
  cornerThinned.length >= 3 &&
    Math.abs(errorPercent(pathDistanceMetres(cornerThinned), pathDistanceMetres(cornerRoad))) < 1,
  `${cornerRoad.length} points → ${cornerThinned.length}, ` +
    `${Math.round(pathDistanceMetres(cornerRoad))} m → ` +
    `${Math.round(pathDistanceMetres(cornerThinned))} m`,
)
check(
  'thinning a corner does not move it',
  maxDeviationMetres(cornerRoad, cornerThinned) <= MAX_DEVIATION_ALLOWED_M,
  `worst deviation ${maxDeviationMetres(cornerRoad, cornerThinned).toFixed(1)} m`,
)

// ---------------------------------------------------------------------------
section('4. Splitting for progress')
// ---------------------------------------------------------------------------
const splitAt = (metres) => splitRoute(legs, metres)
const atStart = splitAt(0)
check(
  'nothing travelled leaves the whole path to come',
  atStart.remaining.length === legs.length && atStart.travelled.length <= 2,
  `travelled ${atStart.travelled.length}, remaining ${atStart.remaining.length}`,
)
const atEnd = splitAt(byLegs + 500)
check(
  'a finished path has nothing remaining',
  atEnd.remaining.length === 0,
  `remaining ${atEnd.remaining.length}`,
)
const midway = splitAt(byLegs / 2)
check(
  'both halves meet at the same point, so the line has no gap',
  midway.travelled[midway.travelled.length - 1].lat === midway.remaining[0].lat &&
    midway.travelled[midway.travelled.length - 1].lon === midway.remaining[0].lon,
)
check(
  'the two halves add up to the whole path',
  Math.abs(
    pathDistanceMetres(midway.travelled) +
      pathDistanceMetres(midway.remaining) -
      byLegs,
  ) < 1e-6,
  `${pathDistanceMetres(midway.travelled).toFixed(1)} + ` +
    `${pathDistanceMetres(midway.remaining).toFixed(1)} vs ${byLegs.toFixed(1)}`,
)

// ---------------------------------------------------------------------------
section('5. Nudging')
// ---------------------------------------------------------------------------
const here = { lat: 52.5, lon: 13.4 }
const north100 = nudge(here, 100, 0)
const east100 = nudge(here, 0, 100)
check(
  'a 100 m nudge north lands 100 m north',
  Math.abs(distanceMetres(here, north100) - 100) < 1,
  `${distanceMetres(here, north100).toFixed(1)} m`,
)
check(
  'a 100 m nudge east lands 100 m east',
  Math.abs(distanceMetres(here, east100) - 100) < 1,
  `${distanceMetres(here, east100).toFixed(1)} m`,
)
const acrossDateline = nudge({ lat: 0, lon: 179.999 }, 0, 2000)
check(
  'nudging past the antimeridian wraps instead of clamping',
  acrossDateline.lon > -180 && acrossDateline.lon < 0,
  `lon ${acrossDateline.lon}`,
)
check(
  'a nudge cannot leave the globe',
  Math.abs(nudge({ lat: 90, lon: 0 }, 5000, 0).lat) <= 90,
)

// ---------------------------------------------------------------------------
section('6. Describing a journey')
// ---------------------------------------------------------------------------
check('duration at 5 km/h over 5 km is an hour', durationSeconds(5000, 5) === 3600)
check('a stopped journey takes no time', durationSeconds(5000, 0) === 0)
check('short distances read in metres', formatDistance(820) === '820 m', formatDistance(820))
check('longer distances read in kilometres', formatDistance(6071) === '6.07 km', formatDistance(6071))
check('very long distances lose a decimal', formatDistance(82_650) === '82.7 km', formatDistance(82_650))
check('seconds, minutes and hours all read naturally',
  formatDuration(42) === '42 s' && formatDuration(420) === '7 min' && formatDuration(4320) === '1 h 12 min',
  `${formatDuration(42)} / ${formatDuration(420)} / ${formatDuration(4320)}`)
check(
  'the speed bounds the native side enforces are the ones described',
  MIN_SPEED_KMH === 0.5 && MAX_SPEED_KMH === 200,
  `${MIN_SPEED_KMH}–${MAX_SPEED_KMH}`,
)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ route geometry is wrong — ${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`    • ${failure}`)
  console.error('')
  process.exit(1)
}

process.stdout.write(`\n✓ route geometry is sound (${checks} checks)\n`)
