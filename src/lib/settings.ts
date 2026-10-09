const KEY = 'spotpicker.settings'

export type AppSettings = {
  defaultSpeedKmh: number
  routePreference: 'fastest' | 'highways'
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
    }
  } catch {
    return null
  }
}

export function loadSettings(): AppSettings {
  const saved = read()
  if (saved) return saved
  return { defaultSpeedKmh: 45, routePreference: 'fastest' }
}

export function saveSettings(next: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — in-memory defaults still apply for this session */
  }
}
