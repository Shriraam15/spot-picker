import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { LatLng } from '@/lib/types'
import { splitRoute } from '@/lib/route'

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const WORLD_CENTER: [number, number] = [20, 4]

/**
 * Reads a design token so Leaflet's vector layers follow the app theme instead
 * of hard-coding two palettes. `document.documentElement` carries the `dark`
 * class, so this resolves to the values in force right now.
 */
function token(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

type Props = {
  /** The currently selected position; drives the pin. */
  position: LatLng | null
  onPick: (position: LatLng) => void
  /**
   * Command the map to fly somewhere. Increment `nonce` on every request —
   * repeated requests with the same coordinates must still animate.
   */
  flyTo?: { position: LatLng; zoom?: number; nonce: number }
  /** Increment to centre on the device's real GPS fix. */
  locateNonce?: number
  /** Increment to return to the world view. */
  resetNonce?: number
  onLocateStateChange?: (state: 'idle' | 'locating' | 'denied' | 'error') => void
  /**
   * The chosen path, drawn as a two-tone polyline. It is kept apart from the
   * waypoints because a road-following path carries hundreds of vertices, none
   * of which is a point the user picked — drawing a marker on each would bury
   * the map in dots.
   */
  path?: LatLng[]
  /** The points the user actually chose: start, any stops, destination. */
  waypoints?: LatLng[]
  /** Routes the user did not choose, drawn faintly and tappable. */
  alternatives?: { id: string; points: LatLng[] }[]
  /** Called with the id of an alternative the user tapped. */
  onSelectRoute?: (id: string) => void
  /**
   * Frames these points. Increment `nonce` to ask again: a route built from
   * saved spots never touches the map, so without this the path would be drawn
   * somewhere off screen and the map would look empty.
   */
  frameRoute?: { points: LatLng[]; nonce: number } | null
  /** How far along that route playback has reached, for the two-tone line. */
  travelledMetres?: number
  /** The coordinate the mock location is publishing right now. */
  livePosition?: LatLng | null
  /** Keep the live position centred while a route plays. */
  follow?: boolean
  /** Redraws the vectors when the palette changes. */
  theme?: string
}

/**
 * The interactive map. Leaflet owns the DOM, so React drives it only through
 * props and refs; the instance is created once and torn down on unmount.
 */
export default function MapView({
  position,
  onPick,
  flyTo,
  locateNonce,
  resetNonce,
  onLocateStateChange,
  path,
  waypoints,
  alternatives,
  onSelectRoute,
  frameRoute,
  travelledMetres = 0,
  livePosition,
  follow = false,
  theme,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const liveMarkerRef = useRef<L.Marker | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  // Keep the latest callbacks without re-creating the map when they change identity.
  const onPickRef = useRef(onPick)
  const onLocateRef = useRef(onLocateStateChange)
  const onSelectRouteRef = useRef(onSelectRoute)
  onPickRef.current = onPick
  onLocateRef.current = onLocateStateChange
  onSelectRouteRef.current = onSelectRoute

  // ---- create the map once -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    // Wheel zoom fights page scrolling on touch devices, so only enable it
    // where a precise pointer exists.
    const hasFinePointer = window.matchMedia('(pointer: fine)').matches

    const map = L.map(containerRef.current, {
      center: WORLD_CENTER,
      zoom: 2,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: true,
      scrollWheelZoom: hasFinePointer,
      worldCopyJump: true,
    })
    mapRef.current = map

    // OpenStreetMap's standard tiles are key-free; dark mode is achieved with a
    // CSS filter on .leaflet-tile-pane (see index.css) rather than a second,
    // API-key-gated tile provider.
    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map)

    map.on('click', (e: L.LeafletMouseEvent) => {
      onPickRef.current?.({ lat: e.latlng.lat, lon: e.latlng.lng })
    })

    // Leaflet mis-measures when its container changes size (rotation, keyboard
    // show/hide, WebView layout passes), so re-measure on every resize.
    const onResize = () => map.invalidateSize()
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    observer.observe(containerRef.current)

    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
      map.remove()
      mapRef.current = null
      markerRef.current = null
      liveMarkerRef.current = null
      routeLayerRef.current = null
    }
  }, [])

  // ---- draw or move the pin ----------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !position) return

    if (!markerRef.current) {
      // A divIcon avoids Leaflet's default marker images, whose URLs break
      // under a bundler and would need extra assets inside the APK.
      const icon = L.divIcon({
        className: 'spot-pin',
        html: '<span class="spot-pin__pulse"></span><span class="spot-pin__dot"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      })
      markerRef.current = L.marker([position.lat, position.lon], {
        icon,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(map)
    } else {
      markerRef.current.setLatLng([position.lat, position.lon])
    }
  }, [position])

  // ---- the route: alternatives, the chosen path, and the waypoints ---------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    routeLayerRef.current?.remove()
    const group = L.layerGroup()
    routeLayerRef.current = group

    const accent = token('--accent', '#4f46e5')
    const muted = token('--text-subtle', '#a1a1aa')

    // The routes on offer but not taken, drawn first so the chosen one sits on
    // top. Tapping one selects it, which is how a route stops being random.
    for (const alternative of alternatives ?? []) {
      if (alternative.points.length < 2) continue
      const latLngs = alternative.points.map((p) => [p.lat, p.lon] as [number, number])
      // A hairline is impossible to hit with a finger, and a route that cannot
      // be tapped is a route that cannot be chosen. So the tap lands on an
      // invisible, much wider line underneath the one that is drawn.
      L.polyline(latLngs, {
        color: muted,
        weight: 26,
        opacity: 0.001,
        lineCap: 'round',
      })
        .on('click', () => onSelectRouteRef.current?.(alternative.id))
        .addTo(group)
      L.polyline(latLngs, {
        color: muted,
        weight: 3,
        opacity: 0.55,
        dashArray: '2 7',
        interactive: false,
      }).addTo(group)
    }

    if (path && path.length >= 2) {
      const { travelled, remaining } = splitRoute(path, travelledMetres)

      // The part already covered is solid and accented; what is still to come is
      // dashed and quiet, so the progress is readable at a glance. Both halves
      // are the accent at different strengths rather than a border colour: a
      // near-background grey is indistinguishable from the map in dark mode, and
      // the chosen path has to stay the most legible line on screen either way.
      if (remaining.length > 1) {
        L.polyline(
          remaining.map((p) => [p.lat, p.lon] as [number, number]),
          { color: accent, weight: 3, opacity: 0.7, dashArray: '6 6' },
        ).addTo(group)
      }
      if (travelled.length > 1) {
        L.polyline(
          travelled.map((p) => [p.lat, p.lon] as [number, number]),
          { color: accent, weight: 4, opacity: 0.95 },
        ).addTo(group)
      }
    }

    const points = waypoints ?? []
    points.forEach((point, index) => {
      const isStart = index === 0
      const isEnd = index === points.length - 1 && points.length > 1
      const color = isStart
        ? token('--success', '#059669')
        : isEnd
          ? token('--danger', '#dc2626')
          : accent
      L.circleMarker([point.lat, point.lon], {
        radius: isStart || isEnd ? 6 : 4,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      }).addTo(group)
    })

    group.addTo(map)
  }, [path, waypoints, alternatives, travelledMetres, theme])

  // ---- the moving position ----------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !livePosition) {
      liveMarkerRef.current?.remove()
      liveMarkerRef.current = null
      return
    }

    if (!liveMarkerRef.current) {
      const icon = L.divIcon({
        className: 'route-pin',
        html: '<span class="route-pin__pulse"></span><span class="route-pin__dot"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      })
      liveMarkerRef.current = L.marker([livePosition.lat, livePosition.lon], {
        icon,
        keyboard: false,
        zIndexOffset: 1200,
      }).addTo(map)
    } else {
      liveMarkerRef.current.setLatLng([livePosition.lat, livePosition.lon])
    }
  }, [livePosition])

  // ---- commands from the parent ------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !flyTo) return
    map.flyTo([flyTo.position.lat, flyTo.position.lon], flyTo.zoom ?? 15, { duration: 0.7 })
    // `nonce` is the trigger; `flyTo.position` is intentionally not a dependency
    // so that re-picking the same spot still animates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce])

  // Keep the moving position on screen, but only when asked: following while the
  // user is panning the map on purpose would be infuriating.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !follow || !livePosition) return
    map.panTo([livePosition.lat, livePosition.lon], { animate: true, duration: 0.6 })
  }, [follow, livePosition])

  useEffect(() => {
    const map = mapRef.current
    if (!map || locateNonce === undefined) return
    onLocateRef.current?.('locating')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here: LatLng = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        map.flyTo([here.lat, here.lon], 16, { duration: 0.8 })
        onPickRef.current?.(here)
        onLocateRef.current?.('idle')
      },
      () => onLocateRef.current?.('denied'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    )
  }, [locateNonce])

  useEffect(() => {
    const map = mapRef.current
    if (!map || resetNonce === undefined || resetNonce === 0) return
    map.flyTo(WORLD_CENTER, 2, { duration: 0.7 })
  }, [resetNonce])

  // Frame a freshly built route, so the path and both endpoints are on screen
  // whether they came from the map or from saved spots.
  useEffect(() => {
    const map = mapRef.current
    const points = frameRoute?.points
    if (!map || !points || points.length < 2) return
    map.fitBounds(
      L.latLngBounds(points.map((point) => [point.lat, point.lon] as [number, number])),
      { padding: [48, 48], maxZoom: 16, animate: true },
    )
    // `nonce` is the trigger; the points themselves are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRoute?.nonce])

  return <div ref={containerRef} className="h-full w-full" />
}
