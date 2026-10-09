import type { Place } from './types'

const KEY = 'spotpicker.recent-searches'
const MAX_RECENT = 10

export interface RecentSearch {
  query: string
  place: Place
  timestamp: number
}

function read(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is RecentSearch =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as RecentSearch).query === 'string' &&
        typeof (item as RecentSearch).timestamp === 'number' &&
        (item as RecentSearch).place !== null,
    )
  } catch {
    return []
  }
}

function write(list: RecentSearch[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

export function getRecentSearches(): RecentSearch[] {
  return read().sort((a, b) => b.timestamp - a.timestamp)
}

export function addRecentSearch(query: string, place: Place): RecentSearch[] {
  const current = read()
  // Remove duplicate if same place already exists
  const filtered = current.filter(
    (item) => !(item.query.toLowerCase() === query.toLowerCase() &&
               item.place.id === place.id),
  )
  const next: RecentSearch[] = [
    { query, place, timestamp: Date.now() },
    ...filtered,
  ].slice(0, MAX_RECENT)
  write(next)
  return next
}

export function clearRecentSearches(): void {
  write([])
}

export function removeRecentSearch(timestamp: number): void {
  const current = read()
  write(current.filter((item) => item.timestamp !== timestamp))
}

/** Returns places from recent searches matching the query */
export function searchRecentSearches(query: string): Place[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []

  const recent = getRecentSearches()
  const terms = trimmed.split(/[\s/]+/).filter((t) => t.length > 0)

  return recent
    .filter((item) => {
      const haystack = `${item.place.name ?? ''} ${item.place.displayName ?? ''}`.toLowerCase()
      if (haystack.includes(trimmed)) return true
      return terms.every((term) => haystack.includes(term))
    })
    .map((item) => item.place)
    .slice(0, 5)
}
