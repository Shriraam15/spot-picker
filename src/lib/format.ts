import type { LatLng } from './types'

/**
 * Formats a coordinate to 6 decimal places, which is roughly 10 cm of precision —
 * more than enough for picking a place, and it matches what most map apps show.
 */
export function formatCoord(value: number): string {
  return value.toFixed(6)
}

/** "12.971599, 77.594566" — the order people expect to read. */
export function formatLatLng({ lat, lon }: LatLng): string {
  return `${formatCoord(lat)}, ${formatCoord(lon)}`
}

/** DMS form, e.g. "12.971599° N, 77.594566° E". */
export function formatDms({ lat, lon }: LatLng): string {
  const part = (value: number, pos: string, neg: string) =>
    `${formatCoord(Math.abs(value))}° ${value >= 0 ? pos : neg}`
  return `${part(lat, 'N', 'S')}  ·  ${part(lon, 'E', 'W')}`
}

/** A short, human label like "Home", "Work" or "Somewhere in Karnataka". */
/** True degrees-minutes-seconds, e.g. `35°41'22.20"N 139°41'30.12"E`. */
export function formatTrueDms({ lat, lon }: LatLng): string {
  const part = (value: number, pos: string, neg: string): string => {
    const abs = Math.abs(value)
    let d = Math.floor(abs)
    const mFloat = (abs - d) * 60
    let m = Math.floor(mFloat)
    let s = (mFloat - m) * 60
    if (s >= 59.995) {
      s = 0
      m += 1
    }
    if (m >= 60) {
      m = 0
      d += 1
    }
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}"${value >= 0 ? pos : neg}`
  }
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`
}

/**
 * Parse a coordinate the way a human would type it:
 *   "12.9716, 77.5946"           plain decimal degrees
 *   "40°42'46\"N, 74°0'21\"W"    degrees / minutes / seconds with hemisphere
 *   "12.9716 77.5946"            space separated decimal
 * Returns null when the text is not a plausible pair.
 */
export function parseLatLngInput(text: string): LatLng | null {
  const t = text.trim()
  if (!t) return null

  const decimal = t.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (decimal) {
    const lat = Number(decimal[1])
    const lon = Number(decimal[2])
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon }
    return null
  }

  // DMS: each part is d [m] [s] with an optional hemisphere letter.
  const parts = [
    ...t.matchAll(
      /(\d+(?:\.\d+)?)\s*[°d]\s*(?:(\d+)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?\s*([NSEW])?/gi,
    ),
  ]
  if (parts.length >= 2 || (parts.length === 2 && parts.every((p) => p[4]))) {
    const toDeg = (p: RegExpMatchArray) => {
      const d = Number(p[1])
      const m = Number(p[2] || 0)
      const s = Number(p[3] || 0)
      return d + m / 60 + s / 3600
    }
    let lat: number | null = null
    let lon: number | null = null
    for (const p of parts) {
      const hemi = (p[4] || '').toUpperCase()
      const value = toDeg(p)
      if (hemi === 'S' || hemi === 'N') lat = hemi === 'S' ? -value : value
      else if (hemi === 'E' || hemi === 'W') lon = hemi === 'E' ? value : -value
      else if (lat === null && value <= 90) lat = value
      else if (lon === null) lon = value
    }
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon }
    }
  }
  return null
}

export function suggestName(placeName: string | null, { lat, lon }: LatLng): string {
  if (placeName && placeName.trim()) return placeName.trim()
  return `${formatCoord(lat)}, ${formatCoord(lon)}`
}

/**
 * Wall clock time, seconds included: "14:07:32".
 *
 * A simulated position is only believable when the time next to it is moving,
 * so the dashboard ticks this every second rather than showing a frozen stamp.
 */
export function formatClock(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * An elapsed duration counted up from a start time: "1h 04m 09s".
 * Returns "--:--" when there is nothing running, so the tile never lies with a
 * zero that looks like a stopped clock.
 */
export function formatElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${pad(m)}m ${pad(s)}s`
}

/**
 * A rough arrival estimate: "in 6 min", "in 1h 12m", or "—" when it cannot be
 * known yet (no speed, or no route). Deliberately approximate: a simulated
 * journey is not a promise.
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`
}

/** Clamps a number into a range, used to keep the map inside valid coordinates. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
