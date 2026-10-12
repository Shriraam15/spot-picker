/** A geographic position selected on the map. */
export type LatLng = {
  lat: number
  lon: number
}

/** A target position the joystick is steering to. The service publishes
 * whatever is current while the thumb is held, so this is a stream of
 * targets rather than one command: the phone follows the thumb, the route
 * underneath keeps advancing, and letting go re-joins the journey.
 */
export type ManualPosition = {
  /** The coordinate the thumb is dragging the mock toward. */
  lat: number
  /** The coordinate the thumb is dragging the mock toward, in longitude. */
  lon: number
}

/** A place returned by the Nominatim search endpoint. */
export type Place = {
  id: string
  name: string
  displayName: string
  lat: number
  lon: number
}

/** A user-saved location, persisted in localStorage. */
export type Favorite = {
  id: string
  name: string
  lat: number
  lon: number
  createdAt: number
}




/** A place returned by the Nominatim search endpoint. */

/**
 * Live progress of a simulated route. Reported by the Android foreground
 * service, because it is the side that plays the route.
 */
export type RouteProgress = {
  /** True while a route is loaded (a finished route stays loaded). */
  active: boolean
  /** True once playback reached the end and is holding the last point. */
  finished: boolean
  /** True while the mock location itself is publishing. */
  running: boolean
  /** The coordinate being published right now, or null before the first fix. */
  lat: number | null
  lon: number | null
  travelledMetres: number
  totalMetres: number
  speedKmh: number
}

/**
 * A travel mode. It seeds the default speed and tells the Android side how
 * believable the fixes should look, and it is what the user picks instead of
 * being handed a fixed speed.
 */
export type RouteModeId = 'walk' | 'run' | 'cycle' | 'drive'

type TravelMode = {
  id: RouteModeId
  label: string
  /** Icon name from components/ui.tsx. */
  icon: 'walk' | 'run' | 'bike' | 'car'
  defaultSpeedKmh: number
  /** One line explaining when to pick it. */
  hint: string
}

/** The modes offered, in the order they are shown. */
export const ROUTE_MODES: TravelMode[] = [
  { id: 'walk', label: 'Walk', icon: 'walk', defaultSpeedKmh: 5, hint: '5 km/h — a stroll' },
  { id: 'run', label: 'Run', icon: 'run', defaultSpeedKmh: 12, hint: '12 km/h — a jog' },
  { id: 'cycle', label: 'Cycle', icon: 'bike', defaultSpeedKmh: 20, hint: '20 km/h — a bike' },
  { id: 'drive', label: 'Drive', icon: 'car', defaultSpeedKmh: 45, hint: '45 km/h — traffic' },
]

/**
 * One path between the chosen endpoints. The user picks between these, which is
 * what makes a route chosen rather than implied: OSRM can offer alternatives,
 * and a direct line is always kept as the last option so a route can still be
 * simulated with no network at all.
 */
export type RouteOption = {
  id: string
  label: string
  points: LatLng[]
  distanceMetres: number
  /** True when the path follows roads; false for the direct line fallback. */
  snapped: boolean
  /** Rough shape of the path, for the picker (OSRM sometimes explains itself). */
  detail?: string
  /**
   * The signed road numbers this route uses, longest stretch first: `A 100`,
   * `B 2`, `I 95`. These are the numbers on the road signs — the same ones
   * Google Maps shows — so a simulated journey can be described by the fixed
   * routes it follows instead of by a pair of coordinates.
   */
  roads?: string[]
  /** Up to three road names or numbers to name the route by, longest first. */
  via?: string[]
  /**
   * Share of the distance covered on a *numbered* road (0–1). It is how a
   * highway route is recognised: the router cannot be asked to prefer them, so
   * the routes it offers are compared instead.
   */
  highwayShare?: number
}

/** Which offered route to favour when several exist. */
export type RoutePreference = 'fastest' | 'highways'

/** Answer from the native live-update self-test. */
export type ProbeResult = {
  ok: boolean
  updates: number
  providers: string
  movedMetres: number
  worstGapMs: number
  mockFlagged: boolean
  message: string
}

/** What happens when the user taps a suggestion. */
export type OnSelectFlow = 'jump' | 'add-to-route' | 'save' | 'reverse'

/** Overall state of the device mock-location feature (native build only). */
export type MockState = {
  /** True when running inside the Android wrapper. */
  available: boolean
  /** True when the user has picked this app under "Select mock location app". */
  appSelected: boolean
  /**
   * True once Developer options have been unlocked. "Select mock location app"
   * is unreachable before that, which is the difference between "unlock them
   * first" and "pick Spot Picker in the list".
   */
  developerOptions: boolean
  /** True when the foreground service is currently pushing test locations. */
  running: boolean
  /** True while a start request is on its way to the service. */
  starting: boolean
  /** True when ACCESS_FINE_LOCATION has been granted. */
  hasPermission: boolean
  /** Last error reported by the native layer, if any. */
  error: string | null
}
