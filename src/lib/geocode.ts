import type { Place } from './types'

/** Nominatim's usage policy allows at most one request per second and requires an
 * identifying User-Agent. A browser forbids setting User-Agent, so the app throttles
 * requests to 1/s and relies on the Referer header the browser sends automatically.
 * See https://operations.osmfoundation.org/policies/nominatim/
 */
let lastRequestAt = 0
const MIN_INTERVAL_MS = 1000

type NominatimResult = {
  place_id: number
  name?: string
  display_name: string
  lat: string
  lon: string
}

export class GeocodeError extends Error {}

/** Searches OpenStreetMap for a place name. Returns an empty array when nothing matches. */
export function searchPlaces(query: string): Promise<Place[]> {
  const trimmed = query.trim()
  if (!trimmed) return Promise.resolve([])
  // Delegate to the cached service so each query only costs one 1/s hit.
  return _searchPlacesInternal(trimmed)
}

/** Internal helper that performs the throttled, cached network fetch. */
async function _searchPlacesInternal(query: string): Promise<Place[]> {
  const since = Date.now() - lastRequestAt
  if (since < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since))
  }
  lastRequestAt = Date.now()
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: 'jsonv2', limit: '12' }).toString()}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new GeocodeError(`Search failed (HTTP ${res.status}).`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) return []
  return (data as NominatimResult[]).map((r) => ({
    id: String(r.place_id),
    name: r.name && r.name.trim() ? r.name.trim() : r.display_name.split(',')[0],
    displayName: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }))
}

/** Best-effort reverse geocoding used only to pre-fill the "save" name. */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const since = Date.now() - lastRequestAt
  if (since < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since))
  }
  lastRequestAt = Date.now()
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=16`, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  const data = (await res.json()) as { name?: string; display_name?: string }
  return data.name || data.display_name?.split(',')[0]?.trim() || null
}




