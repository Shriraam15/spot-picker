import type { LatLng, Place } from './types'
import { normalizeToken, scorePlaceFuzzy } from './fuzzy'
import { distanceMetres } from './route'

/**
 * Offline world gazetteer.
 *
 * The app bundles a ~16 MB dataset of every populated place on Earth
 * (236k rows, GeoNames CC BY 4.0), sharded by first letter under public/data.
 * Search fetches only the shard(s) the query touches (a few hundred KB),
 * so a deep search works with no network at all. The Explore page can load
 * the whole world once for "places near me".
 *
 * Row format: [name, cc, admin, lat, lon, pop, mark, alternates?]
 *   mark: C country capital, A/2/3/4/5 admin capital, x suburb, l locality, …
 * Airport rows: [name, cc, iataOrIcao, lat, lon, kind(L/M/S)]
 */
export type PlaceRow = [string, string, string, number, number, number, string, (string[])?]

export type CountryEntry = {
  iso: string
  name: string
  capital: string
  continent: string
  cities: [string, string, string, number, number, number][]
}

export type AirportRow = [string, string, string, number, number, 'L' | 'M' | 'S']

const BASE = `${import.meta.env.BASE_URL}data`
const LETTERS = 'abcdefghijklmnopqrstuvwxyz#'
/** Parsed shards kept in memory: at most ~10 letters (~7 MB) at a time. */
const SHARD_CACHE_MAX = 10

const shardCache = new Map<string, PlaceRow[]>()
let countriesPromise: Promise<CountryEntry[]> | null = null
let airportsPromise: Promise<AirportRow[]> | null = null
/** Full-world rows, populated by loadAllPlaces(); supersedes the LRU cache. */
let worldRows: PlaceRow[] | null = null

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) throw new Error(`Gazetteer fetch ${path} failed: ${res.status}`)
  return (await res.json()) as T
}

/** Fold diacritics and pick the shard letter for a query/name prefix. */
export function shardLetter(text: string): string {
  const folded = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
  const c = folded.charAt(0)
  return c >= 'a' && c <= 'z' ? c : '#'
}

async function loadShard(letter: string): Promise<PlaceRow[]> {
  const cached = shardCache.get(letter)
  if (cached) {
    // Refresh LRU position.
    shardCache.delete(letter)
    shardCache.set(letter, cached)
    return cached
  }
  // The '#' bucket ships as other.json: '#' in a URL is read as a fragment.
  const file = letter === '#' ? 'other' : letter
  const rows = await fetchJson<PlaceRow[]>(`p/${encodeURIComponent(file)}.json`)
  shardCache.set(letter, rows)
  if (shardCache.size > SHARD_CACHE_MAX) {
    const oldest = shardCache.keys().next().value
    if (oldest !== undefined) shardCache.delete(oldest)
  }
  return rows
}

let countryNamesPromise: Promise<Map<string, string>> | null = null
function countryNames(): Promise<Map<string, string>> {
  if (!countryNamesPromise) {
    countryNamesPromise = loadCountries().then((list) => new Map(list.map((c) => [c.iso, c.name])))
  }
  return countryNamesPromise
}

export function loadCountries(): Promise<CountryEntry[]> {
  if (!countriesPromise) countriesPromise = fetchJson<CountryEntry[]>('countries.json')
  return countriesPromise
}

export function loadAirports(): Promise<AirportRow[]> {
  if (!airportsPromise) airportsPromise = fetchJson<AirportRow[]>('airports.json')
  return airportsPromise
}

/** Row → Place. displayName reads like "Paris, Île-de-France, France". */
function rowToPlace(row: PlaceRow, countryName: string): Place {
  const [name, cc, admin, lat, lon] = row
  const parts = [name, admin, countryName || (cc || '')].filter(
    (p, i) => p && !(i > 0 && p === name),
  )
  return {
    id: `g-${Math.round(lat * 1000)}-${Math.round(lon * 1000)}-${name}`,
    name,
    displayName: parts.join(', '),
    lat,
    lon,
  }
}

/**
 * Deep offline search over the shards the query can possibly hit.
 * Scores the place name, the "name, admin, country" display string, and any
 * bundled alternate name ("Bombay" → Mumbai).
 */
export async function searchOffline(query: string, limit = 15): Promise<Place[]> {
  const tokens = query
    .split(/[\s/]+/)
    .map((t) => normalizeToken(t))
    .filter(Boolean)
  if (tokens.length === 0) return []

  const letters = [...new Set(tokens.map(shardLetter))]
  const rowsPerShard = await Promise.all(letters.map(loadShard))
  const names = await countryNames()

  const scored: { place: Place; score: number }[] = []
  const seen = new Set<string>()
  for (const rows of rowsPerShard) {
    for (const row of rows) {
      const place = rowToPlace(row, names.get(row[1]) || '')
      let best = scorePlaceFuzzy(place.name, place.displayName, query)
      if (best.score <= 0 && row[7]) {
        // Alternate names compete with plain substrings, not with prefix hits.
        for (const alt of row[7]) {
          const s = scorePlaceFuzzy(alt, place.displayName, query)
          if (s.score > best.score) best = { ...s, score: Math.min(s.score, 140) }
        }
      }
      if (best.score <= 0) continue
      const key = `${place.name}|${place.lat.toFixed(2)}|${place.lon.toFixed(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      scored.push({ place, score: best.score })
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name),
  )
  return scored.slice(0, limit).map((s) => s.place)
}

/**
 * Load every shard for radius queries (nearby explorer). Progress reports
 * letters done / total. After this the LRU shard cache is dropped in favour
 * of the single world array, so peak memory stays ~35 MB instead of doubling.
 */
export async function loadAllPlaces(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (worldRows) return
  const total = LETTERS.length
  let done = 0
  const rows = await Promise.all(
    LETTERS.split('').map(async (letter) => {
      const r = await loadShard(letter)
      done += 1
      onProgress?.(done, total)
      return r
    }),
  )
  worldRows = rows.flat()
  shardCache.clear()
}

export function isWorldLoaded(): boolean {
  return worldRows !== null
}

/** Nearest gazetteer places to a point, closest first. */
export async function nearbyPlaces(
  center: LatLng,
  limit = 20,
  maxKm = 500,
): Promise<Place[]> {
  await loadAllPlaces()
  if (!worldRows) return []
  const names = await countryNames()
  const maxM = maxKm * 1000
  const scored: { place: Place; d: number }[] = []
  // The dataset contains repeated rows (a city and its admin seat can share a
  // name and round to the same coordinates); collapsing them by id keeps both
  // the list and its React keys unique.
  const seen = new Set<string>()
  for (const row of worldRows) {
    const d = distanceMetres(center, { lat: row[3], lon: row[4] })
    if (d > maxM) continue
    const place = rowToPlace(row, names.get(row[1]) || '')
    if (seen.has(place.id)) continue
    seen.add(place.id)
    scored.push({ place, d })
  }
  scored.sort((a, b) => a.d - b.d)
  return scored.slice(0, limit).map((s) => s.place)
}

/** Is this place within `metres` of any already-kept result? (dedupe helper) */
export function withinAny(place: Place, kept: Place[], metres: number): boolean {
  return kept.some((k) => distanceMetres(k, place) < metres)
}
