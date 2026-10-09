/** Persisted usage counters that make the app feel like it has a memory. */

export type StatKey = 'searches' | 'saves' | 'jumps' | 'routes'

export type AppStats = {
  searches: number
  saves: number
  jumps: number
  routes: number
  /** Total distance of every simulated route, in metres. */
  simulatedMetres: number
}

const KEY = 'spotpicker.stats'

export const EMPTY_STATS: AppStats = {
  searches: 0,
  saves: 0,
  jumps: 0,
  routes: 0,
  simulatedMetres: 0,
}

export function loadStats(): AppStats {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...EMPTY_STATS }
    const parsed = JSON.parse(raw) as Partial<AppStats>
    return {
      searches: Number(parsed.searches) || 0,
      saves: Number(parsed.saves) || 0,
      jumps: Number(parsed.jumps) || 0,
      routes: Number(parsed.routes) || 0,
      simulatedMetres: Number(parsed.simulatedMetres) || 0,
    }
  } catch {
    return { ...EMPTY_STATS }
  }
}

/** Increment a counter (or add `amount`) and persist; returns the new stats. */
export function recordStat(key: StatKey, amount = 1): AppStats {
  const next = loadStats()
  next[key] += amount
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

/** Record a completed route start: one route plus its planned distance. */
export function recordRoute(metres: number): AppStats {
  const next = loadStats()
  next.routes += 1
  next.simulatedMetres += Math.max(0, metres)
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

export function resetStats(): AppStats {
  localStorage.removeItem(KEY)
  return { ...EMPTY_STATS }
}
