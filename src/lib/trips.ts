import type { LatLng, RouteModeId } from './types'
import { pathDistanceMetres } from './route'

/**
 * A log of simulated journeys.
 *
 * Every route the user plays is kept — where it started, where it ended, the
 * path it took, how long it ran and how far it actually got. The Android
 * service does the moving, so this is the only place the journey survives once
 * it is over; without it a simulated trip is gone the moment the phone stops,
 * and there is nothing to repeat tomorrow.
 *
 * The record is written twice on purpose:
 *  - once when playback starts, so a trip shows up (and is replayable) even if
 *    the app is killed mid-journey;
 *  - again when playback ends, so the distance actually travelled and the real
 *    duration replace the plan. A trip that never got its second write is
 *    reported as "incomplete" rather than pretending it finished.
 */

export type Trip = {
  id: string
  /** When playback started, ms since epoch. */
  startedAt: number
  /** When playback ended, or null while it is still running / was cut short. */
  finishedAt: number | null
  mode: RouteModeId
  /** The speed the journey was played at, km/h. */
  speedKmh: number
  /** Planned length of the path, in metres. */
  plannedMetres: number
  /** How far the dot actually got, in metres. */
  travelledMetres: number
  /** The endpoints in order: start, stops, destination. */
  waypoints: LatLng[]
  /** A short human label: "Koramangala → Indiranagar" or a pair of coordinates. */
  label: string
}

const KEY = 'spotpicker.trips'
/** Enough history to be useful, small enough to stay inside localStorage. */
const MAX_TRIPS = 40

function read(): Trip[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((trip): trip is Trip => {
      if (!trip || typeof trip !== 'object') return false
      const t = trip as Trip
      return (
        typeof t.id === 'string' &&
        typeof t.startedAt === 'number' &&
        Array.isArray(t.waypoints) &&
        t.waypoints.every(
          (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number',
        )
      )
    })
  } catch {
    return []
  }
}

function write(list: Trip[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_TRIPS)))
  } catch {
    /* storage disabled or full: the list still works for this session */
  }
}

/** Newest first. */
export function loadTrips(): Trip[] {
  return read().sort((a, b) => b.startedAt - a.startedAt)
}

/** A name for the journey, chosen from the endpoints the user picked. */
export function tripLabel(waypoints: LatLng[], names: (string | null)[]): string {
  const first = names[0]?.trim()
  const last = names[names.length - 1]?.trim()
  if (first && last && first !== last) return `${first} → ${last}`
  if (first) return first
  if (waypoints.length >= 2) {
    const a = waypoints[0]
    const b = waypoints[waypoints.length - 1]
    return `${a.lat.toFixed(4)},${a.lon.toFixed(4)} → ${b.lat.toFixed(4)},${b.lon.toFixed(4)}`
  }
  return 'Simulated trip'
}

/** Records the start of a journey and returns the stored trip. */
export function startTrip(input: {
  waypoints: LatLng[]
  mode: RouteModeId
  speedKmh: number
  label: string
}): Trip {
  const trip: Trip = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    startedAt: Date.now(),
    finishedAt: null,
    mode: input.mode,
    speedKmh: input.speedKmh,
    plannedMetres: pathDistanceMetres(input.waypoints),
    travelledMetres: 0,
    waypoints: input.waypoints,
    label: input.label,
  }
  write([trip, ...read()])
  return trip
}

/**
 * Closes a trip. Called when the service reports the route finished, and also
 * when the user stops it early — a journey that was interrupted is still a
 * journey, and `finishedAt` is what makes its duration real.
 */
export function finishTrip(
  id: string,
  patch: { travelledMetres?: number; finishedAt?: number },
): Trip[] {
  const next = read().map((trip) =>
    trip.id === id
      ? {
          ...trip,
          finishedAt: patch.finishedAt ?? Date.now(),
          travelledMetres: patch.travelledMetres ?? trip.travelledMetres,
        }
      : trip,
  )
  write(next)
  return next.sort((a, b) => b.startedAt - a.startedAt)
}

export function removeTrip(id: string): Trip[] {
  const next = read().filter((trip) => trip.id !== id)
  write(next)
  return next.sort((a, b) => b.startedAt - a.startedAt)
}

export function clearTrips(): Trip[] {
  write([])
  return []
}

/** How long a trip ran, in seconds: real duration, or planned when it is still open. */
export function tripSeconds(trip: Trip): number {
  if (trip.finishedAt && trip.finishedAt > trip.startedAt) {
    return Math.round((trip.finishedAt - trip.startedAt) / 1000)
  }
  return 0
}

/** Average speed of a trip in km/h, from what actually happened. */
export function tripAverageKmh(trip: Trip): number {
  const seconds = tripSeconds(trip)
  if (seconds <= 0) return 0
  return (trip.travelledMetres / seconds) * 3.6
}
