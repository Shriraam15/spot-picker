import type { LatLng } from './types'

/**
 * Route maths for the simulator UI.
 *
 * Playback itself happens in the Android foreground service (see MockRoute.kt),
 * because movement has to continue while the phone is showing the app being
 * tested — a WebView that is not on screen cannot be trusted to tick. These
 * helpers only measure a route and describe progress, so they mirror the native
 * formulas rather than replacing them.
 */

/** Matches MockRoute.EARTH_RADIUS_M so both sides agree on distances. */
const EARTH_RADIUS_M = 6_371_008.8

const toRad = (degrees: number) => (degrees * Math.PI) / 180

/** Great-circle distance in metres. */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Length of the whole polyline. */
export function pathDistanceMetres(points: LatLng[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i += 1) sum += distanceMetres(points[i - 1], points[i])
  return sum
}

/** How long [metres] takes at [speedKmh]. */
export function durationSeconds(metres: number, speedKmh: number): number {
  if (!(speedKmh > 0)) return 0
  return metres / ((speedKmh * 1000) / 3600)
}

/** "820 m", "3.42 km" — short enough for a chip, precise enough to trust. */
/** Initial bearing from a to b, degrees clockwise from true north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Serialise a planned path as GPX 1.1 so it can be exported to other tools
 * (Garmin devices, OsmAnd, QMapShack, …). One track, one segment.
 */
export function buildGpx(points: LatLng[], name: string): string {
  const safe = escapeXml(name)
  const trkpts = points
    .map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"></trkpt>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Spot Picker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${safe}</name>
  </metadata>
  <trk>
    <name>${safe}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '—'
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(metres < 10_000 ? 2 : 1)} km`
}

/** "42 s", "7 min", "1 h 12 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** Bounds the native side enforces, so the UI can reject the same values. */
export const MIN_SPEED_KMH = 0.5
export const MAX_SPEED_KMH = 200

/**
 * The most points the Android side will accept for one route (see
 * MAX_ROUTE_POINTS in SpotPickerBridge.kt).
 *
 * It is deliberately generous. A road route has to survive as road geometry: the
 * dot other apps draw has to stay on the carriageway, and every point that is
 * dropped moves the path. Thinning for a hard cap is a last resort, not the
 * first move — see [thinToLimit].
 */
export const MAX_ROUTE_POINTS = 4000

/**
 * How far a thinned path may stray from the road it came from, in metres.
 *
 * This is the number that decides whether a simulated journey still *looks* like
 * a journey in Google Maps. The mock reports an accuracy of 5–9 m, so a path
 * that stays within a few metres of the road always sits inside the accuracy
 * circle of the blue dot — the dot is on the road, and a reader that snaps to
 * the nearest road snaps to the right one.
 */
export const ROUTE_DEVIATION_M = 4

/** Moves a coordinate by metres north/east, which is how people think of nudging. */
export function nudge(position: LatLng, northMetres: number, eastMetres: number): LatLng {
  const lat = Math.min(90, Math.max(-90, position.lat + northMetres / 111_320))
  const lonScale = Math.max(Math.cos(toRad(position.lat)), 0.0001)
  let lon = position.lon + eastMetres / (111_320 * lonScale)
  // Wrap instead of clamping: stepping across the antimeridian must keep working.
  if (lon > 180) lon -= 360
  if (lon < -180) lon += 360
  return { lat, lon }
}

/** A point in a local flat projection, in metres from the route's first point. */
type XY = { x: number; y: number }

/**
 * Projects to metres around [origin]. Over a single route the earth's curvature
 * is irrelevant, and metres are what a simplification tolerance has to be
 * expressed in.
 */
function toLocal(points: LatLng[], origin: LatLng): XY[] {
  return points.map((p) => toLocalPoint(p, origin))
}

function toLocalPoint(point: LatLng, origin: LatLng): XY {
  const lonScale = Math.max(Math.cos(toRad(origin.lat)), 0.0001)
  return {
    x: (point.lon - origin.lon) * 111_320 * lonScale,
    y: (point.lat - origin.lat) * 111_320,
  }
}

function fromLocal(points: XY[], origin: LatLng): LatLng[] {
  const lonScale = Math.max(Math.cos(toRad(origin.lat)), 0.0001)
  return points.map((p) => ({
    lon: origin.lon + p.x / (111_320 * lonScale),
    lat: origin.lat + p.y / 111_320,
  }))
}

/** Squared distance from p to the segment ab, used by Douglas–Peucker. */
function squaredSegmentDistance(p: XY, a: XY, b: XY): number {
  let x = a.x
  let y = a.y
  let dx = b.x - x
  let dy = b.y - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b.x
      y = b.y
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p.x - x
  dy = p.y - y
  return dx * dx + dy * dy
}

function douglasPeucker(points: XY[], tolerance: number, first: number, last: number, out: XY[]) {
  let worst = 0
  let index = 0
  const toleranceSq = tolerance * tolerance
  for (let i = first + 1; i < last; i += 1) {
    const d = squaredSegmentDistance(points[i], points[first], points[last])
    if (d > worst) {
      worst = d
      index = i
    }
  }
  // `index` is always strictly between `first` and `last`, so recursing on it
  // cannot loop. Guarding on `index - first > 1` instead — as this did at first —
  // throws away the whole span whenever the worst deviation happens to sit one
  // vertex in, which flattens a winding road into a straight chord.
  if (worst > toleranceSq) {
    douglasPeucker(points, tolerance, first, index, out)
    out.push(points[index])
    douglasPeucker(points, tolerance, index, last, out)
  }
}

/**
 * Thins a path while staying within [toleranceMetres] of it. The first and last
 * points always survive, so the endpoints the user picked never move.
 */
export function simplifyPath(points: LatLng[], toleranceMetres: number): LatLng[] {
  if (points.length <= 2) return [...points]
  const local = toLocal(points, points[0])
  const kept: XY[] = [local[0]]
  douglasPeucker(local, toleranceMetres, 0, local.length - 1, kept)
  kept.push(local[local.length - 1])
  return fromLocal(kept, points[0])
}

/** Last resort: drop every nth point, keeping both ends and the overall shape. */
function decimate(points: LatLng[], max: number): LatLng[] {
  const step = Math.ceil(points.length / max)
  const out = points.filter((_, i) => i % step === 0)
  if ((points.length - 1) % step !== 0) out.push(points[points.length - 1])
  return out
}

/**
 * Thins a road path to what the bridge accepts without letting it leave the
 * road.
 *
 * The tolerance starts at [ROUTE_DEVIATION_M] and may be loosened only as far as
 * [MAX_DEVIATION_M], because the deviation is the thing that matters and the
 * point count is not: a journey whose dot wanders 40 m off the carriageway looks
 * broken in every map app, while a route with 900 points instead of 700 costs
 * nothing. A path that still does not fit at the loosest tolerance is decimated,
 * which follows the road rather than cutting across it.
 */
export function thinToLimit(points: LatLng[], maxPoints: number = MAX_ROUTE_POINTS): LatLng[] {
  if (points.length <= maxPoints) return [...points]
  let tolerance = ROUTE_DEVIATION_M
  let out = simplifyPath(points, tolerance)
  while (out.length > maxPoints && tolerance < MAX_DEVIATION_M) {
    tolerance = Math.min(MAX_DEVIATION_M, tolerance * 1.6)
    out = simplifyPath(points, tolerance)
  }
  return out.length > maxPoints ? decimate(out, maxPoints) : out
}

/**
 * A closed loop of [points] waypoints around [center] at [radiusMetres].
 *
 * This is the "patrol" journey: instead of walking from A to B once, the dot
 * circles a place and keeps coming back to it, which is what a location that
 * is supposed to look alive needs. It is built with [nudge] so the loop is a
 * real circle on the globe rather than a circle in degrees — the two are very
 * different away from the equator — and the first point is repeated at the end
 * so the native side plays it as a closed circuit.
 */
export function circleRoute(center: LatLng, radiusMetres: number, points = 24): LatLng[] {
  const count = Math.max(8, Math.min(120, Math.round(points)))
  const radius = Math.max(5, radiusMetres)
  const loop: LatLng[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2
    loop.push(nudge(center, Math.cos(angle) * radius, Math.sin(angle) * radius))
  }
  loop.push(loop[0])
  return loop
}

/** The loosest a path may deviate before the point count stops mattering. */
const MAX_DEVIATION_M = 12

/**
 * The furthest any of [points] lies from the polyline [thinned], in metres.
 *
 * The invariant this exposes is the whole point of thinning a road route: the
 * geometry may lose detail, but it must not lose the road. The tests assert it
 * directly rather than trusting that Douglas–Peucker did what it says.
 */
export function maxDeviationMetres(points: LatLng[], thinned: LatLng[]): number {
  if (points.length === 0 || thinned.length < 2) return 0
  const localPath = toLocal(thinned, thinned[0])
  let worst = 0
  for (const point of points) {
    const p = toLocalPoint(point, thinned[0])
    let best = Number.POSITIVE_INFINITY
    for (let i = 1; i < localPath.length; i += 1) {
      best = Math.min(best, squaredSegmentDistance(p, localPath[i - 1], localPath[i]))
    }
    if (Number.isFinite(best)) worst = Math.max(worst, Math.sqrt(best))
  }
  return worst
}

/**
 * Splits a route at [travelledMetres] so the map can draw the part already
 * covered differently from the part still to come. Both halves meet at the
 * interpolated position, so the drawn route has no gap.
 */
export function splitRoute(
  points: LatLng[],
  travelledMetres: number,
): { travelled: LatLng[]; remaining: LatLng[] } {
  if (points.length < 2) return { travelled: [...points], remaining: [] }

  let left = Math.max(0, travelledMetres)
  const travelled: LatLng[] = [points[0]]

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]
    const to = points[i]
    const segment = distanceMetres(from, to)
    if (segment <= 0) continue
    if (left >= segment) {
      travelled.push(to)
      left -= segment
      continue
    }
    const t = left / segment
    const cut: LatLng = {
      lat: from.lat + (to.lat - from.lat) * t,
      lon: from.lon + (to.lon - from.lon) * t,
    }
    travelled.push(cut)
    return { travelled, remaining: [cut, ...points.slice(i)] }
  }

  return { travelled, remaining: [] }
}
