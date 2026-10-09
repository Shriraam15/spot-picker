import type { Place } from './types'

export type { Place }

/** One autocomplete (type-ahead) suggestion shown while the user types. */
export interface AutocompleteSuggestion extends Place {
  /** A short human label for the chip: e.g. "Dhoni Falls" or "New Delhi, India". */
  label: string
  /** How many address fields the Nominatim result carried, for ranking hints. */
  addressFields: number
}

/** Result of a live search + rank for the autocomplete dropdown. */
export interface SearchResults {
  /** Suggestions ordered by relevance. */
  suggestions: AutocompleteSuggestion[]
  /** Number of places found by the service for the current query. */
  total: number
}

/** A user-saved spot: a place the user bookmarked, plus a friendly nick. */
export interface SavedPlace {
  /** Stable id, e.g. "fav-1710564231482". */
  id: string
  place: Place
  /** Nickname the user gave it (defaults to place.name). */
  nickname: string
  /** When it was added. */
  createdAt: number
}

export interface SavedPlaceWithMeta extends SavedPlace {
  /** Distance from the app's last-known pull location, in km, when set. */
  distanceKm?: number
  /** The route length in metres if a route was last built from this place. */
  routeMetres?: number
}

export type SavedItem = SavedPlace | SavedPlaceWithMeta

/** A readable label for the current module's stage. */
export type ModuleStage = 'home' | 'search' | 'route' | 'favorites' | 'profile'

/** Keyboard shortcut config used by the search panel's '/' focus. */
export interface ShortcutConfig {
  focusSearch: string
  nextPanel: string
  prevPanel: string
}

/** What happens when the user taps a suggestion. */
export type OnSelectFlow = 'jump' | 'add-to-route' | 'save' | 'reverse'

/** The current pull location reported by the mock service. */
export interface CurrentPosition {
  lat: number
  lon: number
  accuracyM: number
  velocityMps: number
  bearingDeg: number
  isMock: boolean
}
