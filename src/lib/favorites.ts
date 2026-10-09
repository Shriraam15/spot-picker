import type { Favorite } from './types'

const KEY = 'spotpicker.favorites'

/**
 * localStorage can throw (private browsing, disabled storage, WebView quota).
 * Every access is therefore guarded and degrades to "no favorites" rather than
 * crashing the app.
 */
function read(): Favorite[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (f): f is Favorite =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as Favorite).id === 'string' &&
        typeof (f as Favorite).name === 'string' &&
        typeof (f as Favorite).lat === 'number' &&
        typeof (f as Favorite).lon === 'number',
    )
  } catch {
    return []
  }
}

function write(list: Favorite[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* out of quota or storage disabled — the in-memory list still works this session */
  }
}

export function loadFavorites(): Favorite[] {
  return read().sort((a, b) => b.createdAt - a.createdAt)
}

/** Adds a favorite and returns the new full list. Duplicate coordinates are rejected. */
export function addFavorite(list: Favorite[], name: string, lat: number, lon: number): Favorite[] {
  const exists = list.some((f) => Math.abs(f.lat - lat) < 1e-7 && Math.abs(f.lon - lon) < 1e-7)
  if (exists) return list
  const next: Favorite[] = [
    ...list,
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      lat,
      lon,
      createdAt: Date.now(),
    },
  ]
  write(next)
  return next
}

/** Removes by id and persists the result. */
export function removeFavorite(list: Favorite[], id: string): Favorite[] {
  const next = list.filter((f) => f.id !== id)
  write(next)
  return next
}

export type FavoriteExport = {
  version: 1
  favorites: Favorite[]
}

export function exportFavorites(list: Favorite[]): string {
  return JSON.stringify({ version: 1, favorites: list }, null, 2)
}

export function importFavorites(raw: string): Favorite[] {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return loadFavorites()
  const candidate = parsed as Record<string, unknown>
  if (candidate.version !== 1) return loadFavorites()
  if (!Array.isArray(candidate.favorites)) return loadFavorites()
  const normalized: Favorite[] = []
  for (const item of candidate.favorites) {
    if (typeof item !== 'object' || item === null) continue
    const candidateItem = item as Record<string, unknown>
    if (
      typeof candidateItem.id !== 'string' ||
      typeof candidateItem.name !== 'string' ||
      typeof candidateItem.lat !== 'number' ||
      typeof candidateItem.lon !== 'number'
    )
      continue
    normalized.push({
      id: candidateItem.id,
      name: candidateItem.name,
      lat: candidateItem.lat,
      lon: candidateItem.lon,
      createdAt: typeof candidateItem.createdAt === 'number' ? candidateItem.createdAt : Date.now(),
    })
  }
  return normalized
}

