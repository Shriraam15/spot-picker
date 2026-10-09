import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from '@/components/MapView'
import SearchPanel from '@/components/SearchPanel'
import FavoritesPanel from '@/components/FavoritesPanel'
import SetupPanel from '@/components/SetupPanel'
import RoutePanel from '@/components/RoutePanel'
import SettingsPanel from '@/components/SettingsPanel'
import HistoryPanel from '@/components/HistoryPanel'
import ExplorePanel from '@/components/ExplorePanel'
import CoordTools from '@/components/CoordTools'
import StatsCard from '@/components/StatsCard'
import type { RoutingState } from '@/components/RoutePanel'
import MockBar from '@/components/MockBar'
import { Button, Card, CardHeader, Icon } from '@/components/ui'
import type { IconName } from '@/components/ui'
import LockScreen from '@/components/LockScreen'
import { hasSecuritySetup, lockSecurity } from '@/lib/security'
import { useTheme } from '@/lib/theme'
import { formatLatLng } from '@/lib/format'
import { nudge, pathDistanceMetres } from '@/lib/route'
import { loadStats, recordRoute, recordStat } from '@/lib/stats'
import { directLineOption, fetchRouteOptions } from '@/lib/routing'
import { tap } from '@/lib/haptics'
import { addFavorite, loadFavorites, removeFavorite, exportFavorites, importFavorites } from '@/lib/favorites'
import type { Favorite } from '@/lib/types'
import { reverseGeocode, searchPlaces } from '@/lib/geocode'
import { buildSuggestions, rerankFromCache } from '@/lib/suggestions'
import { SEED_PLACES } from '@/lib/seed-places'
import { WORLD_TOP } from '@/lib/world-seed'
import { searchOffline, withinAny } from '@/lib/gazetteer'
import { fuzzyRankPlaces } from '@/lib/fuzzy'
import type { SearchResults } from '@/lib/search'
import {
  UNAVAILABLE_STATE,
  getDiagnostics,
  getMockState,
  getRoute,
  isNative,
  onNativeEvent,
  openAboutPhone,
  openAppSettings,
  openDeveloperOptions,
  openExternal,
  requestPermissions,
  readProbeResult,
  startLiveUpdateTest,
  startMock,
  startRoute,
  stopMock,
} from '@/lib/native'
import { saveSettings, type AppSettings } from '@/lib/settings'
import { getRecentSearches, removeRecentSearch, addRecentSearch } from '@/lib/recent-searches'
import type {
  LatLng,
  MockState,
  ProbeResult,
  Place,
  RouteModeId,
  RouteOption,
  RoutePreference,
  RouteProgress,
} from '@/lib/types'
import { ROUTE_MODES } from '@/lib/types'
import type { AppPage } from '@/lib/navigation'
import type { RecentSearch as RecentSearchType } from '@/lib/recent-searches'

type Notice = { id: number; text: string; tone: 'success' | 'danger' | 'neutral' }

/** How long the live-update self-test listens before it reports, in seconds. */
const PROBE_SECONDS = 8

/** The route defaults loaded from settings, used to seed the first render. */
const initialRouteDefaults: {
  mode: RouteModeId
  speedKmh: number
  preference: RoutePreference
} = {
  mode: 'walk',
  speedKmh: 45,
  preference: 'fastest',
}


/**
 * How Google Maps names the same travel modes. Google cannot be told about a
 * mock location, so the app hands it the journey instead: the dot follows this
 * route, and this is the same route in the app you are comparing against.
 */
const GOOGLE_TRAVEL_MODE: Record<RouteModeId, string> = {
  walk: 'walking',
  // Google has no running mode; walking is the honest nearest thing.
  run: 'walking',
  cycle: 'bicycling',
  drive: 'driving',
}

/** Google Maps directions for the chosen points. No API key is involved. */
function googleMapsUrl(points: LatLng[], mode: RouteModeId): string | null {
  if (points.length < 2) return null
  const at = (point: LatLng) => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`
  const params = new URLSearchParams({
    api: '1',
    origin: at(points[0]),
    destination: at(points[points.length - 1]),
    travelmode: GOOGLE_TRAVEL_MODE[mode],
  })
  const waypoints = points.slice(1, -1).map(at)
  if (waypoints.length > 0) params.set('waypoints', waypoints.join('|'))
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

/**
 * Which route to play once the router answers.
 *
 * The straight hop is put on the map the moment an endpoint changes, so the
 * path on screen always belongs to the points on screen — but it is a
 * placeholder, and following roads is the whole point, so it is promoted as soon
 * as a road route exists. A road route the user picked themselves survives a
 * refetch untouched.
 */
function pickOption(
  options: RouteOption[],
  chosenByUser: string | null,
  preference: RoutePreference,
): RouteOption | null {
  // A route the user tapped — a chip, or the line on the map — is the answer,
  // full stop. Everything else is a default that the preference may change.
  const chosen = options.find((option) => option.id === chosenByUser)
  if (chosen) return chosen
  const roads = options.filter((option) => option.snapped)
  if (roads.length === 0) return options[0] ?? null
  if (preference === 'highways') {
    // The router cannot be asked to prefer numbered roads, so the routes it did
    // offer are compared and the one that spends the most distance on them wins.
    const best = roads.reduce((a, b) =>
      (b.highwayShare ?? 0) > (a.highwayShare ?? 0) ? b : a,
    )
    if ((best.highwayShare ?? 0) > 0) return best
  }
  return roads[0]
}

/** How often an automatically retried start may be re-attempted. */
const AUTO_RETRY_INTERVAL_MS = 10_000

/** The app's six pages, in the order the bottom tab bar shows them. */
const NAV_TABS: { page: AppPage; label: string; icon: IconName }[] = [
  { page: 'home', label: 'Home', icon: 'locate' },
  { page: 'search', label: 'Search', icon: 'search' },
  { page: 'explore', label: 'Explore', icon: 'globe' },
  { page: 'favorites', label: 'Saved', icon: 'star' },
  { page: 'history', label: 'Recent', icon: 'clock' },
  { page: 'settings', label: 'Settings', icon: 'settings' },
]

export default function App() {
  const { theme, toggle } = useTheme()

  const [position, setPosition] = useState<LatLng | null>(null)
  const [search, setSearch] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites())
  const [saving, setSaving] = useState(false)
  // Read the native status during the initial render rather than in an effect:
  // it is a plain synchronous bridge call, and doing it here keeps the first
  // paint from showing a stale "Action needed" state.
  const [mockState, setMockState] = useState<MockState>(() =>
    isNative() ? getMockState() : UNAVAILABLE_STATE,
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // ---- security lock state -----------------------------------------------
  const [securityLocked, setSecurityLocked] = useState(true)
  const [securityInitialized, setSecurityInitialized] = useState(() => hasSecuritySetup())

  // ---- navigation ---------------------------------------------------------
  const [currentPage, setCurrentPage] = useState<AppPage>('home')
  const [recentSearches, setRecentSearches] = useState<RecentSearchType[]>(() => getRecentSearches())

  // ---- route simulation ---------------------------------------------------
  /** The points the user picked, in order: start, any stops, destination. */
  const [endpoints, setEndpoints] = useState<LatLng[]>([])
  const [{ mode, speedKmh, preference }, setRouteDefaults] = useState<{
    mode: RouteModeId
    speedKmh: number
    preference: RoutePreference
  }>(initialRouteDefaults)
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([])
  const [userRouteId, setUserRouteId] = useState<string | null>(null)
  const [routing, setRouting] = useState<RoutingState>('idle')
  const [routingError, setRoutingError] = useState<string | null>(null)
  const [routeProgress, setRouteProgress] = useState<RouteProgress | null>(() =>
    isNative() ? getRoute() : null,
  )
  const [follow, setFollow] = useState(true)
  /** Verdict of the last live-update self-test, if one has been run. */
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [testing, setTesting] = useState(false)

  // Commands sent to the map; bumping the nonce triggers the effect in MapView.
  const [flyTo, setFlyTo] = useState<{ position: LatLng; zoom?: number; nonce: number } | null>(null)
  const [frameRoute, setFrameRoute] = useState<{ points: LatLng[]; nonce: number } | null>(null)
  const [locateNonce, setLocateNonce] = useState(0)
  const [resetNonce, setResetNonce] = useState(0)

  const setupRef = useRef<HTMLDivElement | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set when a start is refused, so the app can finish the job by itself once the
  // user has been to Developer options and picked Spot Picker.
  const pendingStartRef = useRef(false)
  // Spacing between those automatic retries. Rate-limited rather than "once per
  // selection change": some OEM builds report the mock-location app-op
  // inconsistently, so a transition to "selected" is not something the app is
  // guaranteed to observe — the user's selection has to be re-checked instead.
  const lastAutoRetryRef = useRef(0)

  const flash = useCallback((text: string, tone: Notice['tone'] = 'neutral') => {
    setNotice({ id: Date.now(), text, tone })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 4200)
  }, [])

  // ---- native mock-location state ----------------------------------------
  const refreshMock = useCallback(() => setMockState(getMockState()), [])

  // Diagnostics for a failure that cannot be reproduced from a computer, so a
  // report from the phone carries everything that decides whether mock location
  // can run. Read on demand rather than on a timer, so it is never stale.
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const refreshDiagnostics = useCallback(
    () => setDiagnostics(isNative() ? getDiagnostics() : null),
    [],
  )

  useEffect(() => {
    if (!isNative()) return
    // The foreground service can be stopped from Android's own UI (the
    // notification action), and a route reports its own completion, so stay in
    // sync with native events rather than guessing from the button state.
    return onNativeEvent((event) => {
      if (event.type === 'mockState') refreshMock()
      if (event.type === 'routeFinished') {
        setRouteProgress(getRoute())
        flash('Route complete — still publishing the last position', 'success')
      }
      if (event.type === 'probeResult') {
        const result = readProbeResult(event)
        setTesting(false)
        setProbe(result)
        flash(
          result.ok
            ? `Live updates are arriving (${result.updates.toString()})`
            : 'Android is not delivering live updates',
          result.ok ? 'success' : 'danger',
        )
      }
      if (event.type === 'error' && typeof event.message === 'string') {
        // A refused start is already the persistent, actionable card in the
        // action bar, and the app keeps retrying while the user is in Settings:
        // flashing that message on every attempt would be pure noise. The manual
        // path flashes what the bridge returned, so nothing is lost here.
        if (!pendingStartRef.current) flash(event.message, 'danger')
        refreshMock()
        // Keep the report current: this is the text the user is asked to send.
        refreshDiagnostics()
      }
    })
  }, [refreshMock, flash, refreshDiagnostics])

  const locateState = useCallback(
    (state: 'idle' | 'locating' | 'denied' | 'error') => {
      if (state === 'denied' || state === 'error') flash('Could not read your real location', 'danger')
    },
    [flash],
  )

  // ---- start / stop -------------------------------------------------------
  const handleStart = useCallback(() => {
    if (!position) return
    setBusy(true)
    const result = startMock(position.lat, position.lon)
    setBusy(false)
    if (result.ok) {
      pendingStartRef.current = false
      tap([10, 24, 10])
      flash('Starting mock location', 'success')
    } else {
      // Let the poll finish the job once the user has selected this app under
      // Developer options: they already told us what they want.
      pendingStartRef.current = true
      tap(40)
      flash(result.error ?? 'Could not start mock location', 'danger')
      refreshDiagnostics()
    }
    refreshMock()
  }, [position, flash, refreshMock, refreshDiagnostics])

  // The polling loop below runs on a timer, so it reads the target from a ref
  // rather than closing over a stale `position`.
  const positionRef = useRef<LatLng | null>(position)
  useEffect(() => {
    positionRef.current = position
  }, [position])

  const handleStop = useCallback(() => {
    setBusy(true)
    const result = stopMock()
    setBusy(false)
    if (result.ok) {
      // Drop the running state at once rather than waiting for a native event
      // that may never arrive. If the service somehow survived, the poll puts
      // the button back.
      setMockState((prev) => ({ ...prev, running: false, starting: false }))
      setRouteProgress(getRoute())
      tap(20)
      flash('Mock location stopped')
    } else {
      flash(result.error ?? 'Could not stop mock location', 'danger')
    }
    refreshMock()
  }, [flash, refreshMock])

  // ---- the route on offer --------------------------------------------------
  /**
   * Changing an endpoint gives the map something that belongs to it straight
   * away — the direct hop — and the router replaces it a moment later. Without
   * this the previous endpoints' road route would stay on screen while the new
   * one is in flight, which reads as the app ignoring the pin.
   */
  const updateEndpoints = useCallback((next: LatLng[]) => {
    setEndpoints(next)
    if (next.length >= 2) {
      // The points may have come from saved spots rather than from the map, so
      // the map has to be told to look at them.
      setFrameRoute({ points: next, nonce: Date.now() })
      // A straight hop for this pair, right now; the router replaces it in a
      // moment. It is not a user choice, so it does not become one.
      setRouteOptions([directLineOption(next)])
      setRouting('loading')
      setRoutingError(null)
    } else {
      setRouteOptions([])
      setRouting('idle')
      setRoutingError(null)
    }
  }, [])

  /**
   * Changing the preference is a command, not a hint: it clears a manual pick so
   * the route it asks for is the one that appears. Leaving the pick in place
   * would make the switch look broken to anyone who had tapped a route first.
   */
  const updatePreference = useCallback((next: RoutePreference) => {
    setRouteDefaults((prev) => ({ ...prev, preference: next, userRouteId: null }))
  }, [])

  const saveRouteDefaults = useCallback(
    (next: AppSettings) => {
      saveSettings(next)
      setRouteDefaults((prev) => ({
        ...prev,
        speedKmh: next.defaultSpeedKmh,
        preference: next.routePreference,
      }))
    },
    [],
  )

  /** A mode carries its own speed, which the slider can still override. */
  const updateMode = useCallback(
    (next: RouteModeId) => {
      setRouteDefaults((prev) => {
        const preset = ROUTE_MODES.find((item) => item.id === next)
        return {
          ...prev,
          mode: next,
          speedKmh: preset ? preset.defaultSpeedKmh : prev.speedKmh,
        }
      })
      // A mode change re-routes, so the panel should say so at once. Announcing
      // it here rather than in the effect keeps the effect to what it is for:
      // synchronising with a service outside React.
      if (endpoints.length >= 2) setRouting('loading')
    },
    [endpoints.length],
  )

  // Road routes are fetched only when the endpoints or the mode change, behind a
  // short debounce: adding three stops quickly must cost one request, not three.
  // The public router is free and rate-limited, and an abandoned request is
  // aborted rather than left to finish.
  useEffect(() => {
    if (endpoints.length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetchRouteOptions(endpoints, mode, controller.signal)
        .then((result) => {
          setRouteOptions(result.options)
          setRoutingError(result.error)
          setRouting(result.error ? 'error' : 'ready')
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setRouting('error')
          setRoutingError(
            error instanceof Error ? error.message : 'Could not fetch a route.',
          )
        })
    }, 450)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [endpoints, mode])

  // The route that gets played: the one the user picked, or the default the
  // preference asks for. Deriving it means changing the preference re-picks
  // immediately, without re-asking the router for the same three routes.
  const selectedOption = useMemo(
    () => pickOption(routeOptions, userRouteId, preference),
    [routeOptions, userRouteId, preference],
  )
  /** The path that will actually be played. */
  const routePoints = selectedOption ? selectedOption.points : endpoints

  // The routes not taken are still drawn, so a different one can be picked by
  // tapping it on the map rather than hunting for the chip.
  const otherRoutes = useMemo(
    () =>
      routeOptions
        .filter((option) => option.id !== selectedOption?.id)
        .map((option) => ({ id: option.id, points: option.points })),
    [routeOptions, selectedOption?.id],
  )

  /** The same journey, for Google Maps: the routes it takes between your points. */
  const mapsUrl = useMemo(() => googleMapsUrl(endpoints, mode), [endpoints, mode])

  const handleOpenInMaps = useCallback(() => {
    if (!mapsUrl) return
    const result = openExternal(mapsUrl)
    if (result.ok) tap(8)
    else flash(result.error ?? 'Could not open Google Maps.', 'danger')
  }, [mapsUrl, flash])

  const handleRetryRouting = useCallback(() => {
    if (endpoints.length < 2) return
    setRouting('loading')
    setRoutingError(null)
    // Re-running the effect is not possible from here, so ask directly. The
    // fetch is small and the user has explicitly asked for it.
    void fetchRouteOptions(endpoints, mode)
      .then((result) => {
        setRouteOptions(result.options)
        setRoutingError(result.error)
        setRouting(result.error ? 'error' : 'ready')
      })
      .catch(() => {
        setRouting('error')
        setRoutingError('Could not fetch a route.')
      })
  }, [endpoints, mode])

  // ---- live-update self-test ----------------------------------------------
  const handleTestUpdates = useCallback(() => {
    const result = startLiveUpdateTest(PROBE_SECONDS)
    if (result.ok) {
      setTesting(true)
      setProbe(null)
      tap(8)
      flash(`Listening for live updates for ${PROBE_SECONDS} s…`)
    } else {
      setTesting(false)
      flash(result.error ?? 'Could not run the live-update test.', 'danger')
    }
  }, [flash])

  /**
   * Plays the chosen path at the chosen speed, dressed as the chosen mode. The
   * Android service does the walking, so it keeps going with the screen off.
   */
  const [stats, setStats] = useState(loadStats())

  const handleStartRoute = useCallback(() => {
    if (routePoints.length < 2) return
    setBusy(true)
    const result = startRoute(routePoints, speedKmh, mode)
    setBusy(false)
    // Read progress immediately so the bar does not sit on "Idle" until the
    // first poll lands.
    setRouteProgress(getRoute())
    if (result.ok) {
      tap([10, 24, 10])
      setFollow(true)
      setStats(recordRoute(pathDistanceMetres(routePoints)))
      // Frame the whole journey before following it: the moving dot is only
      // half the picture, and the path it is walking is the other half.
      setFrameRoute({ points: routePoints, nonce: Date.now() })
      flash('Route simulation started', 'success')
    } else {
      tap(40)
      flash(result.error ?? 'Could not start the route', 'danger')
      refreshDiagnostics()
    }
    refreshMock()
  }, [routePoints, speedKmh, mode, flash, refreshMock, refreshDiagnostics])

  // ---- status polling -----------------------------------------------------
  // The service can also be stopped by Android killing it, and a start that the
  // system refuses never produces an event the web app is guaranteed to see.
  // Re-reading the status on a timer is what keeps the Start/Stop button
  // honest: the worst case is that it corrects itself within a couple of seconds.
  useEffect(() => {
    if (!isNative()) return
    const sync = () => {
      if (document.visibilityState !== 'visible') return
      const next = getMockState()
      setMockState(next)
      // A refused start is a two-step job: the user has to go to Developer
      // options and pick Spot Picker. When that lands, finish the start instead
      // of making them find the pin and press the button again.
      const target = positionRef.current
      const retryDue = Date.now() - lastAutoRetryRef.current >= AUTO_RETRY_INTERVAL_MS
      if (next.appSelected && !next.running && next.error && pendingStartRef.current && target && retryDue) {
        lastAutoRetryRef.current = Date.now()
        // Once the selection lands, this succeeds and the pending flag clears; if
        // it is still refused, the card stays put and the next attempt is another
        // interval away. Nothing to lose by asking again — the user already asked.
        const result = startMock(target.lat, target.lon)
        if (result.ok) {
          pendingStartRef.current = false
          tap([10, 24, 10])
          flash('Mock location started', 'success')
        }
        setRouteProgress(getRoute())
      }
    }
    const id = window.setInterval(sync, 2000)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [flash])

  // Route progress moves every second, but only while a route is loaded: there is
  // no reason to cross the bridge for it the rest of the time.
  const routeIsActive = routeProgress?.active === true

  useEffect(() => {
    if (!isNative() || !routeIsActive) return
    const sync = () => {
      if (document.visibilityState !== 'visible') return
      setRouteProgress(getRoute())
      refreshMock()
    }
    const id = window.setInterval(sync, 1000)
    return () => window.clearInterval(id)
  }, [routeIsActive, refreshMock])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    [],
  )

  // ---- selection ---------------------------------------------------------
  const pick = useCallback((next: LatLng) => {
    setPosition(next)
    tap(8)
  }, [])

  const jumpTo = useCallback((next: LatLng, zoom?: number) => {
    setPosition(next)
    setFlyTo({ position: next, zoom, nonce: Date.now() })
  }, [])

  /**
   * Nudging is how a spot gets to the right doorway. While the mock is running
   * the new target is pushed straight to the service, which retargets without
   * tearing down the providers, so the fix other apps are reading never blinks.
   */
  const handleNudge = useCallback(
    (northMetres: number, eastMetres: number) => {
      if (!position) return
      const next = nudge(position, northMetres, eastMetres)
      setPosition(next)
      tap(6)
      if (mockState.running) startMock(next.lat, next.lon)
    },
    [position, mockState.running],
  )

  // ---- search ------------------------------------------------------------
  /**
   * The last query we fetched for, and the last raw result set we got back.
   * If the user keeps typing and the new query is just refining the old one,
   * we can re-rank from the cached result set instantly instead of waiting for
   * another Nominatim request.
   */
  const [lastSearchQuery, setLastSearchQuery] = useState('')
  const [lastSearchResults, setLastSearchResults] = useState<Place[] | null>(null)

  const handleSelectPlace = useCallback(
    (place: Place) => {
      jumpTo({ lat: place.lat, lon: place.lon }, 14)
      setSearch(null)
      setStats(recordStat('jumps'))
    },
    [jumpTo],
  )

  // ---- favorites ---------------------------------------------------------
  const handleSave = useCallback(
    async (rawName: string) => {
      if (!position) return
      setSaving(true)
      try {
        // Only ask Nominatim when the user did not type a name themselves,
        // which keeps us well inside the 1 request/second usage policy.
        let name = rawName.trim()
        if (!name) name = (await reverseGeocode(position.lat, position.lon)) ?? ''
        if (!name) name = formatLatLng(position)
        setFavorites((prev) => addFavorite(prev, name, position.lat, position.lon))
        setStats(recordStat('saves'))
        flash('Spot saved', 'success')
      } finally {
        setSaving(false)
      }
    },
    [position, flash],
  )

  const coordinateLatRef = useRef<HTMLInputElement | null>(null)
  const coordinateLonRef = useRef<HTMLInputElement | null>(null)

  const handleCoordinateJump = useCallback(async () => {
    const latInput = coordinateLatRef.current?.value
    const lonInput = coordinateLonRef.current?.value
    if (!latInput || !lonInput) {
      flash('Enter both latitude and longitude', 'danger')
      return
    }
    const lat = Number(latInput)
    const lon = Number(lonInput)
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      flash('Invalid coordinates — latitude must be -90 to 90, longitude -180 to 180', 'danger')
      return
    }

    // Search for the place at these coordinates using reverse geocoding
    setLoading(true)
    setError(null)
    try {
      const place = await reverseGeocode(lat, lon)
      if (place) {
        const name = place.split(',')[0].trim()
        jumpTo({ lat, lon }, 14)
        setSearch({ suggestions: [{
          name,
          displayName: place,
          lat,
          lon,
          id: String(Date.now()),
          label: name,
          addressFields: 0,
        }], total: 1 })
        flash(name, 'success')
      } else {
        jumpTo({ lat, lon }, 14)
        setSearch({ suggestions: [], total: 0 })
        flash(formatLatLng({ lat, lon }), 'success')
      }
    } catch {
      jumpTo({ lat, lon }, 14)
      setSearch({ suggestions: [], total: 0 })
      flash('Could not reverse geocode — jumping to coordinates anyway', 'danger')
    } finally {
      setLoading(false)
    }
  }, [flash, jumpTo])

  const openSetup = useCallback(() => {
    setupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  // ---- recent searches handlers -------------------------------------------
  const handleAddRecentSearch = useCallback((query: string, place: Place) => {
    const updated = addRecentSearch(query, place)
    setRecentSearches(updated)
  }, [])

  const handleRemoveRecentSearch = useCallback((timestamp: number) => {
    removeRecentSearch(timestamp)
    setRecentSearches(getRecentSearches())
  }, [])

  const handleClearRecentSearches = useCallback(() => {
    // Clear from localStorage
    localStorage.removeItem('spotpicker.recent-searches')
    setRecentSearches([])
    flash('Recent searches cleared', 'neutral')
  }, [flash])

  // ---- search handler (uses handleAddRecentSearch) -----------------------
  const handleSearch = useCallback(async (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return

    setLoading(true)
    setError(null)

    // If we already have cached results for the previous query, and the new
    // query is just a refinement of it, re-rank from cache first.
    if (trimmed && lastSearchResults && trimmed.startsWith(lastSearchQuery)) {        setSearch(rerankFromCache(lastSearchResults, trimmed, search))
    
    }

    // Deep offline search runs in parallel with the network: the bundled
    // gazetteer answers on its own when Nominatim is unreachable, and merges
    // with it when both succeed (curated landmarks fill any remaining gaps).
    const offlineP = searchOffline(trimmed).catch(() => [] as Place[])

    const present = (places: Place[]) => {
      setLastSearchQuery(trimmed)
      setLastSearchResults(places)
      setSearch(buildSuggestions(places, trimmed))
      if (places.length > 0) {
        handleAddRecentSearch(trimmed, places[0])
        setRecentSearches(getRecentSearches())
        setStats(recordStat('searches'))
      }
    }

    try {
      const remote = await searchPlaces(trimmed)
      const offline = [
        ...(await offlineP),
        ...fuzzyRankPlaces(SEED_PLACES, trimmed),
      ]
      // Network results first (address-level precision), then offline
      // gazetteer entries that are not already represented nearby.
      const merged = [...remote]
      for (const p of offline) {
        if (!withinAny(p, merged, 8000)) merged.push(p)
      }
      if (merged.length > 0) {
        present(merged)
        setError(null)
      } else {
        setSearch(null)
        setError(`No places matched “${trimmed}”.`)
      }
    } catch (err) {
      // Offline: the bundled gazetteer (plus curated landmarks) still answers.
      // A curated landmark can be the same place as a gazetteer row, so collapse
      // by id before the list reaches React (duplicate keys are a render error).
      const rawOffline = [
        ...(await offlineP),
        ...fuzzyRankPlaces(SEED_PLACES, trimmed),
      ]
      const offline = rawOffline.filter(
        (p, i) => rawOffline.findIndex((q) => q.id === p.id) === i,
      )
      if (offline.length > 0) {
        present(offline)
        setError(null)
      } else {
        setSearch(null)
        setError(err instanceof Error ? err.message : 'Search failed.')
      }
    } finally {
      setLoading(false)
    }
  }, [lastSearchQuery, lastSearchResults, search, handleAddRecentSearch])

  // ---- as-you-type local suggestions ---------------------------------------
  // Rerank everything we already hold — saved spots, the last result set and
  // the built-in seed dataset — on every keystroke, so typing "T" instantly
  // pops every place whose name contains "t", no waiting for the network and
  // no Enter key needed, even on a fresh profile with no history at all.
  const handleQueryChange = useCallback(
    (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) return

      const seen = new Set<string>()
      const cache: Place[] = []
      const candidates: Place[] = favorites.map((f) => ({
        id: f.id,
        name: f.name,
        displayName: f.name,
        lat: f.lat,
        lon: f.lon,
      }))
      if (lastSearchResults) candidates.push(...lastSearchResults)
      candidates.push(...SEED_PLACES, ...WORLD_TOP)
      // Cross-source dedupe: curated seeds and the generated tier-1 list hold
      // the same cities at slightly different coordinates.
      for (const place of candidates) {
        const key = `${place.name.toLowerCase()}|${Math.round(place.lat * 100)}|${Math.round(place.lon * 100)}`
        if (!seen.has(key)) {
          seen.add(key)
          cache.push(place)
        }
      }

      if (cache.length > 0) setSearch(buildSuggestions(cache, trimmed))
    },
    [favorites, lastSearchResults],
  )

  // ---- favorites handlers -------------------------------------------------
  const handleExportFavorites = useCallback(async () => {
    const text = exportFavorites(favorites)
    try {
      await navigator.clipboard.writeText(text)
      flash('Favorites exported to clipboard', 'success')
    } catch {
      flash('Failed to copy to clipboard', 'danger')
    }
  }, [favorites, flash])

  const handleImportFavorites = useCallback(() => {
    const text = prompt('Paste exported favorites JSON here:')
    if (text && text.trim()) {
      const imported = importFavorites(text)
      if (imported.length > 0) {
        setFavorites(imported)
        flash(`Imported ${imported.length} favorite${imported.length !== 1 ? 's' : ''}`, 'success')
      } else {
        flash('No valid favorites found in the text', 'danger')
      }
    }
  }, [flash])

  // ---- navigation handlers ------------------------------------------------
  const navigateTo = useCallback((page: AppPage) => {
    // If the lock is engaged, do not navigate to any page — require unlock.
    if (securityLocked) return
    setCurrentPage(page)
  }, [securityLocked])

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip only when the user is actually typing. A focused button must not
      // swallow shortcuts — after any click (Save, Refresh, a nav card) digit
      // navigation would otherwise go dead until the user clicked elsewhere.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag ?? '')) return
      if (target?.isContentEditable) return

      const key = e.key
      // Number keys 1-5 map to home/search/favorites/history/settings,
      // 6 opens the world explorer.
      if (key >= '1' && key <= '5') {
        const pages: AppPage[] = ['home', 'search', 'favorites', 'history', 'settings']
        navigateTo(pages[Number(key) - 1])
      }
      if (key === '6') navigateTo('explore')
      // Escape returns to Home from any other page (the browser-back feel)
      if (key === 'Escape' && currentPage !== 'home') {
        setCurrentPage('home')
      }
      // '/' focuses the search input
      if (key === '/' && !e.ctrlKey && !e.metaKey) {
        const input = document.querySelector('input[aria-label="Search places"]') as HTMLInputElement | null
        input?.focus()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentPage, navigateTo])

  // ---- security unlock handling ------------------------------------------
  const handleUnlock = useCallback(() => {
    setSecurityInitialized(true)
    setSecurityLocked(false)
  }, [])


  /**
   * The screen that actually fixes a refused start: Developer options when they
   * are already unlocked, About phone when they are still hidden.
   */
  const fixSelection = useCallback(() => {
    if (mockState.developerOptions) openDeveloperOptions()
    else openAboutPhone()
  }, [mockState.developerOptions])

  // The published position is what the phone reports, which is what the readout
  // and the map should show while the mock is live.
  const livePosition: LatLng | null =
    mockState.running && routeProgress?.lat != null && routeProgress.lon != null
      ? { lat: routeProgress.lat, lon: routeProgress.lon }
      : null
  const status = mockState.running
    ? routeProgress?.active
      ? 'Simulating'
      : 'Publishing'
    : !mockState.available
      ? 'Browser preview'
      : mockState.appSelected && mockState.hasPermission
        ? 'Ready'
        : 'Setup needed'

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg)]">
      {/* ---- security lock screen ---- */}
      {securityLocked && (
        <LockScreen
          isInitialized={securityInitialized}
          onUnlock={handleUnlock}
        />
      )}

      {/* ---- navigation header ---- */}
      <header className="relative flex h-14 shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-[var(--border)] bg-[var(--surface)]/90 px-4 backdrop-blur-xl">
        {/* Decorative background glow */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -left-10 h-40 w-60 rounded-full opacity-[0.15] blur-3xl"
          style={{ background: 'radial-gradient(circle, var(--accent), transparent 70%)' }}
        />
        
        <div className="relative flex min-w-0 items-center gap-3">
          {/* Logo with glow effect */}
          <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-[var(--accent-text)] shadow-[var(--shadow-sm)] transition-transform hover:scale-105 active:scale-95">
            <Icon name="locate" className="h-4.5 w-4.5" />
            <span className="absolute inset-0 rounded-xl bg-[var(--accent)]/20 blur-md -z-10" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-[var(--text)]">
              Spot Picker
            </h1>
            <p className="hidden truncate text-[11px] text-[var(--text-muted)] sm:block">
              Drop a pin, use it as your location
            </p>
          </div>
        </div>

        {/* Navigation lives in the bottom tab bar (see <nav> at the end of the
            layout) — the header only carries identity and status, so nothing on
            top of the page can ever clip or cover content. */}

        <div className="relative flex items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline-flex ${
              mockState.running
                ? 'border-transparent bg-[var(--success-soft)] text-[var(--success)]'
                : 'border-[var(--border)] text-[var(--text-muted)]'
            }`}
          >
            {status}
          </span>
          <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle colour theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* ---- page content ---- */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Map section - shown on home and when viewing places */}
        {(currentPage === 'home' || currentPage === 'search' || currentPage === 'explore' || currentPage === 'favorites') && (
          <div className="relative isolate h-[38vh] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
            <MapView
              position={position}
              onPick={pick}
              flyTo={flyTo ?? undefined}
              locateNonce={locateNonce || undefined}
              resetNonce={resetNonce || undefined}
              onLocateStateChange={locateState}
              path={routePoints}
              waypoints={endpoints}
              alternatives={otherRoutes}
              onSelectRoute={setUserRouteId}
              frameRoute={frameRoute}
              travelledMetres={routeProgress?.active ? routeProgress.travelledMetres : 0}
              livePosition={livePosition}
              follow={follow && livePosition !== null}
              theme={theme}
            />

            {/* Map controls */}
            <div className="pointer-events-none absolute right-3 bottom-3 z-[900] flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                aria-label="Centre on my location"
                onClick={() => setLocateNonce(Date.now())}
                className="shadow-lg shadow-[var(--accent)]/20"
              >
                <Icon name="locate" className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Reset to world view"
                onClick={() => setResetNonce(Date.now())}
              >
                <Icon name="globe" className="h-4 w-4" />
              </Button>
            </div>

            {/* Page-specific hint overlay */}
            {currentPage === 'search' && search?.suggestions.length === 0 && loading === false && (
              <div className="absolute top-3 left-1/2 z-[900] max-w-[90%] -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-[var(--shadow-lg)] backdrop-blur bg-[var(--surface)]/90 text-[var(--text-muted)]">
                <Icon name="search" className="inline h-3.5 w-3.5 mr-1" />
                Search for places or pick from recent
              </div>
            )}

            {currentPage === 'favorites' && favorites.length === 0 && (
              <div className="absolute top-3 left-1/2 z-[900] max-w-[90%] -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-[var(--shadow-lg)] backdrop-blur bg-[var(--surface)]/90 text-[var(--text-muted)]">
                <Icon name="star" className="inline h-3.5 w-3.5 mr-1" />
                No saved spots yet — search and save places
              </div>
            )}

            {notice ? (
              <div
                role="status"
                className={`pointer-events-none absolute top-3 left-1/2 z-[900] max-w-[90%] -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-[var(--shadow-lg)] backdrop-blur ${
                  notice.tone === 'success'
                    ? 'bg-[var(--success-soft)] text-[var(--success)]'
                    : notice.tone === 'danger'
                      ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                      : 'bg-[var(--surface)] text-[var(--text)]'
                }`}
              >
                {notice.text}
              </div>
            ) : null}
          </div>
        )}

        {/* Side panels */}
        <div className="flex min-h-0 flex-1 flex-col lg:w-[400px] lg:max-w-[400px] lg:border-l lg:border-[var(--border)] bg-[var(--bg)]">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {/* Home page - main panels */}
            {currentPage === 'home' && (
              <>
                <SearchPanel
                  suggestions={search?.suggestions ?? []}
                  loading={loading}
                  error={error}
                  onSearch={handleSearch}
                  onQueryChange={handleQueryChange}
                  onSelect={(place, flow) => {
                    handleSelectPlace(place)
                    if (flow === 'save') {
                      // Handle save flow
                    }
                  }}
                />

                <RoutePanel
                  favorites={favorites}
                  position={position}
                  endpoints={endpoints}
                  mode={mode}
                  speedKmh={speedKmh}
                  options={routeOptions}
                  selectedId={selectedOption?.id ?? null}
                  preference={preference}
                  routing={routing}
                  routingError={routingError}
                  canOpenInMaps={mapsUrl !== null}
                  progress={routeProgress}
                  follow={follow}
                  busy={busy}
                  onChangeEndpoints={updateEndpoints}
                  onChangeMode={updateMode}
                  onChangeSpeed={(next) => setRouteDefaults((prev) => ({ ...prev, speedKmh: next }))}
                  onSelectRoute={setUserRouteId}
                  onChangePreference={updatePreference}
                  onSaveDefaults={saveRouteDefaults}
                  onRetryRouting={handleRetryRouting}
                  onOpenInMaps={handleOpenInMaps}
                  onToggleFollow={() => setFollow((prev) => !prev)}
                  onStart={handleStartRoute}
                  onStop={handleStop}
                  onJumpTo={(next) => jumpTo(next, 15)}
                />

                <FavoritesPanel
                  favorites={favorites}
                  position={position}
                  suggestedName={position ? formatLatLng(position) : 'Name this spot'}
                  saving={saving}
                  onSave={(name) => void handleSave(name)}
                  onSelect={(favorite) => jumpTo({ lat: favorite.lat, lon: favorite.lon }, 15)}
                  onRemove={(id) => setFavorites((prev) => removeFavorite(prev, id))}
                  onSetFavorites={setFavorites}
                />

                <StatsCard
                  stats={stats}
                  favoriteCount={favorites.length}
                  recentCount={recentSearches.length}
                />

                <div ref={setupRef}>
                  <SetupPanel
                    mockState={mockState}
                    position={position}
                    diagnostics={diagnostics}
                    onOpenDeveloperOptions={openDeveloperOptions}
                    onOpenAboutPhone={openAboutPhone}
                    onOpenAppSettings={openAppSettings}
                    onRequestPermissions={requestPermissions}
                    onRefreshDiagnostics={refreshDiagnostics}
                    probe={probe}
                    testing={testing}
                    onTestUpdates={handleTestUpdates}
                  />
                </div>          <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <strong className="font-medium text-[var(--text)]">Use responsibly.</strong> Don&apos;t

                  mislead people who rely on your real location for safety.
                </p>
              </>
            )}

            {/* Search page - full search focused view */}
            {currentPage === 'search' && (
              <>
                <SearchPanel
                  suggestions={search?.suggestions ?? []}
                  loading={loading}
                  error={error}
                  onSearch={handleSearch}
                  onQueryChange={handleQueryChange}
                  onSelect={(place) => {
                    handleSelectPlace(place)
                    navigateTo('home')
                  }}
                />

                {/* Coordinate input page */}
                <Card className="w-full">
                  <CardHeader
                    title="Coordinates"
                    hint="Jump to any location by entering coordinates"
                  />
                  <div className="px-4 pb-4 space-y-3">
                    <div className="flex gap-2">
                      <input
                        ref={coordinateLatRef}
                        type="number"
                        inputMode="decimal"
                        step="any"
                        placeholder="Latitude (e.g. 12.9716)"
                        className="flex-1 h-10 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)]"
                      />
                      <input
                        ref={coordinateLonRef}
                        type="number"
                        inputMode="decimal"
                        step="any"
                        placeholder="Longitude (e.g. 77.5946)"
                        className="flex-1 h-10 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={handleCoordinateJump}
                    >
                      <Icon name="globe" className="h-3.5 w-3.5" />
                      Jump to Coordinates
                    </Button>
                  </div>
                </Card>

                {/* Coordinate converter & measuring tape */}
                <CoordTools
                  position={position}
                  onJump={(point) => jumpTo(point, 15)}
                />

                {/* Popular places suggestion */}
                <Card>
                  <CardHeader
                    title="Popular"
                    hint="Quick access to common locations"
                  />
                  <div className="px-4 pb-4 flex flex-wrap gap-2">
                    {['New York', 'London', 'Tokyo', 'Sydney'].map((city) => (
                      <Button
                        key={city}
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          handleSearch(city)
                        }}
                      >
                        {city}
                      </Button>
                    ))}
                  </div>
                </Card>
              </>
            )}

            {/* Favorites page */}
            {currentPage === 'favorites' && (
              <FavoritesPanel
                favorites={favorites}
                position={position}
                suggestedName={position ? formatLatLng(position) : 'Name this spot'}
                saving={saving}
                onSave={(name) => void handleSave(name)}
                onSelect={(favorite) => {
                  jumpTo({ lat: favorite.lat, lon: favorite.lon }, 15)
                  navigateTo('home')
                }}
                onRemove={(id) => setFavorites((prev) => removeFavorite(prev, id))}
                onSetFavorites={setFavorites}
              />
            )}

            {/* Explore page */}
            {currentPage === 'explore' && (
              <ExplorePanel
                position={position}
                onSelect={(place) => {
                  handleSelectPlace(place)
                  navigateTo('home')
                }}
              />
            )}

            {/* History page */}
            {currentPage === 'history' && (
              <HistoryPanel
                favorites={favorites}
                recentSearches={recentSearches}
                onRemoveRecent={handleRemoveRecentSearch}
                onJumpTo={(pos, zoom) => jumpTo(pos, zoom ?? 14)}
                onAddToRoute={(pos) => {
                  const dup = endpoints.some(
                    (p) => Math.abs(p.lat - pos.lat) < 1e-9 && Math.abs(p.lon - pos.lon) < 1e-9,
                  )
                  if (!dup) updateEndpoints([...endpoints, pos])
                }}
              />
            )}

            {/* Settings page */}
            {currentPage === 'settings' && (
              <SettingsPanel
                favorites={favorites}
                onClearRecentSearches={handleClearRecentSearches}
                onExportFavorites={handleExportFavorites}
                onImportFavorites={handleImportFavorites}
                onLock={() => {
                  lockSecurity()
                  setSecurityLocked(true)
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ---- action bar ---- */}
      <MockBar
        mockState={mockState}
        position={position}
        livePosition={livePosition}
        route={routeProgress}
        busy={busy}
        follow={follow}
        onStart={handleStart}
        onStop={handleStop}
        onNudge={handleNudge}
        onToggleFollow={() => setFollow((prev) => !prev)}
        onOpenSetup={openSetup}
        onFix={fixSelection}
      />

      {/* ---- bottom tab bar: how a real mobile app switches pages. It lives in
           normal flow, so it can never overlap or cover the content above it. ---- */}
      <nav
        className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]/95 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-xl"
        aria-label="Main navigation"
      >
        <div className="mx-auto flex w-full max-w-lg items-stretch justify-between gap-1 px-2 pt-1.5">
          {NAV_TABS.map((tab) => {
            const active = currentPage === tab.page
            return (
              <button
                key={tab.page}
                type="button"
                onClick={() => navigateTo(tab.page)}
                aria-label={tab.label}
                aria-current={active ? 'page' : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 transition-all active:scale-95 ${
                  active
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                }`}
              >
                <Icon name={tab.icon} className="h-5 w-5" />
                <span className="w-full truncate text-center text-[10px] font-medium">
                  {tab.label}
                </span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
