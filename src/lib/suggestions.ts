import type { Place, SearchResults } from './search'
import { fuzzyRankPlaces, buildFuzzySuggestions } from './fuzzy'
import { searchRecentSearches } from './recent-searches'

/**
 * The autocomplete card shown under the search box. `addressFields` is the count of
 * address components in the Nominatim result, kept only so a candidate's structure
 * survives the only consumer that sees it (`SearchPanel`), which renders a title and a
 * subtitle. It cannot be a real semantic field — the panel renders both, not the field.
 */

/**
 * Builds the autocomplete suggestion list from a cached place set.
 *
 * Google-like autocomplete: typing "t" instantly shows places starting with "t".
 * Uses fuzzy ranking so typos like "trichy" resolve to "Tiruchirappalli"
 * while still putting prefix matches first.
 *
 * Returns up to the number of suggestions the dropdown can show.
 */
export function buildSuggestions(raw: Place[], query: string): SearchResults {
  const trimmed = query.trim()
  const suggestions = buildFuzzySuggestions(raw, trimmed)
  return {
    suggestions: suggestions.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      lat: p.lat,
      lon: p.lon,
      id: p.id,
      label: (p.name ?? (p.displayName ?? 'Unknown place')).split(',')[0] ?? 'Unknown place',
      addressFields: 0,
    })) as SearchResults['suggestions'],
    total: raw.length,
  }
}

/**
 * Re-ranks a cached result set against a new query without refetching.
 * Used for instant as-you-type filtering after the first network result.
 * Prioritises recent searches so repeat queries surface immediately.
 */
export function rerankFromCache(
  raw: Place[],
  query: string,
  previous: SearchResults | null,
): SearchResults {
  const trimmed = query.trim()
  if (!trimmed) return { suggestions: [], total: raw.length }  // If the query matches a recent search, surface those first.
  const recentMatches = searchRecentSearches(trimmed)
  if (recentMatches.length > 0) {
    return {
      suggestions: recentMatches.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        lat: p.lat,
        lon: p.lon,
        id: p.id,
        label: p.name ?? (p.displayName ?? 'Unknown place').split(',')[0] ?? 'Unknown place',
        addressFields: 0,
      }))
        .slice(0, 12) as SearchResults['suggestions'],
      total: raw.length,
    }
  }

  const cached = previous?.suggestions ?? null
  const source = cached && cached.length > 0 && trimmed.startsWith(String(previous?.total))
    ? cached
    : raw

  const ranked = fuzzyRankPlaces(source as Place[], trimmed)
  const suggestions = ranked.slice(0, 12).map((p) => ({
    name: p.name,
    displayName: p.displayName,
    lat: p.lat,
    lon: p.lon,
    id: p.id,
    label: (p.name ?? (p.displayName ?? 'Unknown place')).split(',')[0] ?? 'Unknown place',
    addressFields: 0,
  })) as SearchResults['suggestions']

  return { suggestions, total: raw.length }
}

/**
 * Merge the service response with the newly typed query so the dropdown can be
 * updated in place. Returns the same shape callers expect.
 */
export function mergeSuggestions(
  existing: SearchResults | null,
  raw: Place[],
  query: string,
): SearchResults {
  if (existing && existing.suggestions.length > 0 && raw.length === existing.total) {
    return rerankFromCache(raw, query, existing)
  }
  return buildSuggestions(raw, query)
}
