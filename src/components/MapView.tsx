import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { LatLng } from '@/lib/types'
import { splitRoute } from '@/lib/route'
import {
  OFFLINE_ATTRIBUTION,
  OFFLINE_MAX_ZOOM,
  TRANSPARENT_TILE,
  mapStyle,
  offlineTileUrl,
  type MapStyleId,
} from '@/lib/map-style'
import { WORLD_TOP } from '@/lib/world-seed'

const WORLD_CENTER: [number, number] = [20, 4]

/**
 * Place names to show on the offline world, by zoom: the bundle carries the
 * largest places first, and a world view cannot fit more than a handful.
 */
const LABEL_COUNTS: Record<number, number> = { 0: 6, 1: 10, 2: 18, 3: 30, 4: 44 }
const MAX_LABELS = 44

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
  /** Which basemap to draw. */
  style?: MapStyleId
  /** Called when the online tiles start or stop arriving. */
  onTilesStateChange?: (offline: boolean) => void
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
  style = 'light',
  onTilesStateChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const liveMarkerRef = useRef<L.Marker | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  const baseLayerRef = useRef<L.TileLayer | null>(null)
  const onlineLayerRef = useRef<L.TileLayer | null>(null)
  const labelsLayerRef = useRef<L.LayerGroup | null>(null)
  /** True once the online tiles have stopped arriving; the world shows through. */
  const offlineRef = useRef(false)
  const drawLabelsRef = useRef<() => void>(() => {})
  // Keep the latest callbacks without re-creating the map when they change identity.
  const onPickRef = useRef(onPick)
  const onLocateRef = useRef(onLocateStateChange)
  const onSelectRouteRef = useRef(onSelectRoute)
  const onTilesStateRef = useRef(onTilesStateChange)
  onPickRef.current = onPick
  onLocateRef.current = onLocateStateChange
  onSelectRouteRef.current = onSelectRoute
  onTilesStateRef.current = onTilesStateChange

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
      baseLayerRef.current = null
      onlineLayerRef.current = null
      labelsLayerRef.current = null
      drawLabelsRef.current = () => {}
    }
  }, [])

  // ---- the basemap: the provider's tiles over the bundled world ------------
  //
  // Laid out as two layers on purpose. The offline world sits underneath, so a
  // tile that never arrives — no data, a blocked host — simply fails and lets
  // the world below show: nothing is hidden behind a broken-image icon, and the
  // pin and the route still sit on a map of somewhere.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const chosen = mapStyle(style)

    // maxNativeZoom is what makes the bundle enough: past zoom 4 Leaflet scales
    // the zoom-4 tile up rather than asking for a tile nobody has.
    const base = L.tileLayer(offlineTileUrl(chosen.id), {
      attribution: OFFLINE_ATTRIBUTION,
      maxNativeZoom: OFFLINE_MAX_ZOOM,
      maxZoom: chosen.maxZoom,
      errorTileUrl: TRANSPARENT_TILE,
      className: 'map-tiles-base',
    })
    const online = L.tileLayer(chosen.tiles, {
      attribution: chosen.attribution,
      maxZoom: chosen.maxZoom,
      errorTileUrl: TRANSPARENT_TILE,
      crossOrigin: true,
      className: chosen.dark ? 'map-tiles-online map-tiles-dark' : 'map-tiles-online',
    })
    base.addTo(map)
    online.addTo(map)
    baseLayerRef.current = base
    onlineLayerRef.current = online

    let loaded = 0
    let failed = 0
    let settle: number | null = null

    // Offline is a fact about the tiles, not about navigator.onLine: a phone on
    // a captive portal reports being online and still fetches nothing.
    const setOffline = (next: boolean) => {
      if (offlineRef.current === next) return
      offlineRef.current = next
      drawLabelsRef.current()
      onTilesStateRef.current?.(next)
    }
    // The verdict is per batch of tiles, not per session: signal dropping
    // halfway through a pan has to be noticed as much as it is on the first
    // load. Leaflet announces each batch with `loading`.
    const onLoading = () => {
      loaded = 0
      failed = 0
    }
    const settleSoon = () => {
      if (settle !== null) return
      settle = window.setTimeout(() => {
        settle = null
        if (failed >= 2 && failed > loaded) setOffline(true)
        else if (loaded > 0 && loaded >= failed) setOffline(false)
      }, 400)
    }
    const onLoad = (event: L.TileEvent) => {
      // Leaflet swaps a tile that failed for `errorTileUrl` and then fires
      // `load` for that stand-in, so an error tile counts as an arrival unless
      // it is filtered out — and it would keep the map claiming to be online
      // while it is drawing the bundled world underneath.
      const src = (event as { tile?: HTMLImageElement }).tile?.src ?? ''
      if (src.startsWith('data:')) return
      loaded += 1
      settleSoon()
    }
    const onError = () => {
      failed += 1
      settleSoon()
    }
    online.on('loading', onLoading)
    online.on('tileload', onLoad)
    online.on('tileerror', onError)

    return () => {
      if (settle !== null) window.clearTimeout(settle)
      online.off('loading', onLoading)
      online.off('tileload', onLoad)
      online.off('tileerror', onError)
      base.remove()
      online.remove()
      baseLayerRef.current = null
      onlineLayerRef.current = null
    }
  }, [style])

  // ---- place names, for the world the bundle carries -----------------------
  //
  // The offline tiles are a drawing, not a map with names on it, and a world
  // with no names is hard to read. The gazetteer already ships the biggest
  // places, so they are drawn as labels while the provider's tiles are not
  // arriving — and cleared the moment they are.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layer = L.layerGroup().addTo(map)
    labelsLayerRef.current = layer
    const draw = () => {
      layer.clearLayers()
      if (!offlineRef.current) return
      const limit = LABEL_COUNTS[Math.round(map.getZoom())] ?? MAX_LABELS
      for (const place of WORLD_TOP.slice(0, limit)) {
        L.marker([place.lat, place.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'offline-label',
            html: `<span>${escapeHtml(place.name)}</span>`,
            iconSize: [0, 0],
          }),
        }).addTo(layer)
      }
    }
    drawLabelsRef.current = draw
    map.on('zoomend', draw)
    return () => {
      map.off('zoomend', draw)
      layer.remove()
      labelsLayerRef.current = null
      drawLabelsRef.current = () => {}
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
