import type { LatLng, RouteModeId, RouteOption } from './types'
import { pathDistanceMetres, thinToLimit } from './route'

/**
 * Road routing, so a simulated journey follows streets instead of drawing a
 * straight line between two pins.
 *
 * It uses the OSRM demo router, which is the one router that needs no API key
 * and sends permissive CORS headers — a hard requirement here, because the page
 * is served from a WebView asset origin and every other request it makes is
 * same-origin. Two consequences worth knowing:
 *
 *  - The public demo only ships the `driving` road graph, and ignores the profile
 *    in the URL. The mode's profile is still sent, so the request is correct
 *    against a real OSRM deployment, but road snapping here always follows the
 *    road network rather than footpaths. That is why the snapped option is
 *    labelled by what it is — roads — rather than by the travel mode.
 *  - It is rate-limited and occasionally unavailable. Failing is never fatal:
 *    the direct line is always offered, and the caller is told the roads could
 *    not be fetched so it can say so instead of pretending nothing happened.
 */

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'

/** The profile a real OSRM would route this mode on. */
const PROFILES: Record<RouteModeId, string> = {
  walk: 'foot',
  run: 'foot',
  cycle: 'bike',
  drive: 'driving',
}

const TIMEOUT_MS = 12_000

/** OSRM returns at most three, and usually one or two. */
const MAX_ROUTES = 3

type OsrmStep = {
  name?: string
  /** The signed road number, e.g. "A 100", "B 2; B 5", "I 95". */
  ref?: string
  distance?: number
}

type OsrmResponse = {
  code?: string
  message?: string
  routes?: {
    distance: number
    duration: number
    geometry?: { coordinates?: [number, number][] }
    legs?: { steps?: OsrmStep[] }[]
  }[]
}

export type RoutingResult = {
  /** Road routes first, then the direct line, which is always present. */
  options: RouteOption[]
  /** Non-null when the roads could not be fetched; [options] still works. */
  error: string | null
}

/**
 * What a road route is made of: the signed roads it uses and how much of it is
 * on them.
 *
 * This is what makes a route identifiable. OSRM returns a `ref` per step — the
 * number on the sign, `A 100`, `B 2`, `I 95` — and those are the same roads
 * Google Maps names, so the app can say *which* fixed route it is following and
 * how much of the journey is on numbered highways rather than side streets.
 */
function routeSurface(steps: OsrmStep[]): { roads: string[]; via: string[]; highwayShare: number } {
  const metresByRoad = new Map<string, number>()
  const metresByRoadLabel = new Map<string, number>()
  let total = 0
  let signed = 0
  for (const step of steps) {
    const distance = typeof step.distance === 'number' ? step.distance : 0
    if (distance <= 0) continue
    total += distance
    // A step can carry several numbers where roads run together: "B 2; B 5".
    const refs = (step.ref ?? '')
      .split(';')
      .map((ref) => ref.trim())
      .filter(Boolean)
    if (refs.length > 0) signed += distance
    for (const ref of refs.length > 0 ? refs : []) {
      metresByRoad.set(ref, (metresByRoad.get(ref) ?? 0) + distance)
    }
    const label = refs[0] ?? step.name?.trim()
    if (label) metresByRoadLabel.set(label, (metresByRoadLabel.get(label) ?? 0) + distance)
  }
  const ranked = (source: Map<string, number>) =>
    [...source.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  return {
    roads: ranked(metresByRoad).slice(0, 6),
    // Named roads first, so a city route reads as streets and a motorway run reads
    // as numbers — whichever is actually carrying the journey.
    via: ranked(metresByRoadLabel).slice(0, 3),
    highwayShare: total > 0 ? signed / total : 0,
  }
}

/** The straight hop, used when the router is unreachable and as an explicit choice. */
export function directLineOption(endpoints: LatLng[]): RouteOption {
  return {
    id: 'direct',
    label: 'Direct line',
    points: [...endpoints],
    distanceMetres: pathDistanceMetres(endpoints),
    snapped: false,
    via: [],
    highwayShare: 0,
  }
}

/**
 * Asks for every road route between the endpoints (through any stops, in order)
 * and returns them alongside the direct line.
 *
 * Never throws: a phone with no signal still gets a usable option list, and the
 * caller can tell the user why the road options are missing.
 */
export async function fetchRouteOptions(
  endpoints: LatLng[],
  mode: RouteModeId,
  signal?: AbortSignal,
): Promise<RoutingResult> {
  const fallback: RoutingResult = { options: [directLineOption(endpoints)], error: null }
  if (endpoints.length < 2) return fallback

  // OSRM expects lon,lat pairs in travel order. An odd leg count can be rejected
  // as unroutable, so it is worth checking before spending a request.
  const coords = endpoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';')
  // `steps=true` is what makes a route describable: it is where the road names
  // and the signed numbers live. The geometry is requested at full resolution on
  // purpose — a road route has to stay on the road, and detail is only removed
  // later by thinToLimit, which is answerable for how far it moved the path.
  const url =
    `${OSRM_BASE}/${PROFILES[mode]}/${coords}` +
    '?overview=full&geometries=geojson&steps=true&alternatives=3'

  try {
    const body = (await request(url, signal)) as OsrmResponse
    if (body.code !== 'Ok') {
      return { options: [directLineOption(endpoints)], error: describe(body) }
    }
    const routes = Array.isArray(body.routes) ? body.routes : []
    const options: RouteOption[] = []
    for (const [index, route] of routes.slice(0, MAX_ROUTES).entries()) {
      const geometry = route.geometry?.coordinates ?? []
      if (geometry.length < 2) continue
      // Geography arrives as [lon, lat] and is far denser than a phone needs to
      // play, so it is thinned — under a bound it is not allowed to exceed, so the
      // path keeps following the road it was built from.
      const points = thinToLimit(geometry.map(([lon, lat]) => ({ lat, lon })))
      if (points.length < 2) continue
      const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? [])
      const surface = routeSurface(steps)
      options.push({
        id: `roads-${index.toString()}`,
        label: index === 0 ? 'Shortest' : `Alternative ${index.toString()}`,
        detail: 'follows roads',
        points,
        distanceMetres: pathDistanceMetres(points),
        snapped: true,
        via: surface.via,
        roads: surface.roads,
        highwayShare: surface.highwayShare,
      })
    }
    options.push(directLineOption(endpoints))
    return {
      options,
      error: options.length > 1 ? null : 'No road route was found between those points.',
    }
  } catch (err) {
    if (isAbort(err)) throw err
    return {
      options: [directLineOption(endpoints)],
      error: err instanceof Error ? err.message : 'The routing service could not be reached.',
    }
  }
}

/** fetch with a timeout that also honours the caller's own cancellation. */
async function request(url: string, external?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const forward = () => controller.abort()
  external?.addEventListener('abort', forward)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`The routing service answered ${response.status}.`)
    return await response.json()
  } catch (err) {
    // A caller-driven abort is a superseded request, not a failure, and the
    // caller is the only one who can tell the difference.
    if (external?.aborted) throw err
    if (isAbort(err)) throw new Error('The routing service took too long to answer.')
    throw err
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', forward)
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function describe(body: OsrmResponse): string {
  if (body.code === 'NoRoute') return 'No road connects those two points.'
  if (body.code === 'NoSegment') return 'One of the points is not near a road.'
  return body.message ?? `The routing service said “${body.code ?? 'unknown'}”.`
}
