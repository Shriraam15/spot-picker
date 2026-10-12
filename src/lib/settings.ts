import { isMapStyleId, type MapStyleId } from './map-style'

const KEY = 'spotpicker.settings'

export type AppSettings = {
  defaultSpeedKmh: number
  routePreference: 'fastest' | 'highways'
  /** Which basemap the map draws. */
  mapStyle: MapStyleId
}

/**
 * The map style that matches the app's theme.
 *
 * Nothing has been chosen yet on a first run, and opening the app to a white
 * map at night is the kind of thing that gets fixed twice, so the theme decides
 * until the user does.
 */
function themeStyle(): MapStyleId {
  try {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function read(): AppSettings | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Record<string, unknown>
    if (typeof candidate.defaultSpeedKmh !== 'number') return null
    if (typeof candidate.routePreference !== 'string') return null
    if (candidate.routePreference !== 'fastest' && candidate.routePreference !== 'highways') return null
    return {
      defaultSpeedKmh: candidate.defaultSpeedKmh,
      routePreference: candidate.routePreference as AppSettings['routePreference'],
      // Settings written before the map had styles carry no opinion about it.
      mapStyle: isMapStyleId(candidate.mapStyle) ? candidate.mapStyle : themeStyle(),
    }
  } catch {
    return null
  }
}

export function loadSettings(): AppSettings {
  const saved = read()
  if (saved) return saved
  return { defaultSpeedKmh: 45, routePreference: 'fastest', mapStyle: themeStyle() }
}

export function saveSettings(next: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — in-memory defaults still apply for this session */
  }
}
