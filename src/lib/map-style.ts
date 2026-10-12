/**
 * The map's styles, and the tiles that back them.
 *
 * Two layers stand behind every style. On top, the online tiles from a key-free
 * public provider, which are what a normal connection draws. Underneath, the
 * offline tiles that ship inside the app: a world drawn from Natural Earth
 * vectors at zooms 0–4, in the same three palettes. When a tile cannot be
 * fetched — no data, a blocked host, a plane — the request fails quietly and
 * the world underneath is already there, so the map still draws and the pin,
 * the route and the playback all still mean something.
 *
 * Why the offline layer is drawn by us rather than cached from a provider: the
 * OpenStreetMap tile policy forbids offline use and pre-seeding, and the other
 * providers either require an API key or say nothing about keeping their tiles.
 * Our own tiles are public-domain data, so there is nothing to ask permission
 * for. See scripts/build-tiles.mjs for the renderer.
 */
export type MapStyleId = 'light' | 'dark' | 'terrain'

export type MapStyle = {
  id: MapStyleId
  label: string
  /** One line for the style picker. */
  hint: string
  /** The online provider's tile URL template. */
  tiles: string
  /** The credit that provider's terms require, as HTML. */
  attribution: string
  /** The deepest zoom the provider serves. */
  maxZoom: number
  /** Drawn for a dark map, so the tiles need the palette flip. */
  dark?: boolean
}

/**
 * The last zoom the bundled tiles cover. Past it Leaflet scales the zoom-4 tile
 * up, which is blurry but never blank.
 *
 * Kept in step with MAX_TILE_ZOOM in scripts/build-tiles.mjs by a test, so the
 * app and the tiles it ships cannot drift apart.
 */
export const OFFLINE_MAX_ZOOM = 4

/**
 * Credit for the offline layer. Natural Earth asks for it; it is public domain.
 *
 * Named "offline world" rather than "offline map" on purpose: the badge that
 * says the tiles are not arriving reads "Offline map", and a credit line with
 * the same words would make the two indistinguishable both to a reader and to
 * a test looking for the badge.
 */
export const OFFLINE_ATTRIBUTION =
  'Offline world: <a href="https://www.naturalearthdata.com/">Natural Earth</a>'

/**
 * The three styles, in the order they are offered.
 *
 * Only key-free providers appear here. Dark is the same OpenStreetMap tiles
 * flipped by a filter rather than a second provider, because every dark raster
 * basemap with a nicer palette now wants an API key the app would have to ship.
 */
export const MAP_STYLES: MapStyle[] = [
  {
    id: 'light',
    label: 'Light',
    hint: 'OpenStreetMap: bright, detailed, places named',
    tiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  {
    id: 'dark',
    label: 'Dark',
    hint: 'The same map, dimmed for night use',
    tiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    dark: true,
  },
  {
    id: 'terrain',
    label: 'Terrain',
    hint: 'OpenTopoMap: hills, contours and rivers',
    tiles: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      'Kartendaten: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende, SRTM | ' +
      'Kartendarstellung: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxZoom: 17,
  },
]

export function isMapStyleId(value: unknown): value is MapStyleId {
  return value === 'light' || value === 'dark' || value === 'terrain'
}

/** The style named, or the first one when the name is not one of ours. */
export function mapStyle(id: MapStyleId): MapStyle {
  return MAP_STYLES.find((style) => style.id === id) ?? MAP_STYLES[0]
}

/** Where a style's bundled tiles live, under the app's own base path. */
export function offlineTileUrl(id: MapStyleId, base = import.meta.env.BASE_URL): string {
  return `${base}tiles/${id}/{z}/{x}/{y}.png`
}

/** The credit as plain text, for prose that is not the map itself. */
export function attributionText(id: MapStyleId): string {
  return mapStyle(id)
    .attribution.replace(/<[^>]+>/g, '')
    .replace(/&copy;/g, '©')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A transparent pixel, used as `errorTileUrl`: a tile that cannot be fetched
 * must show what is behind it rather than a broken-image box.
 */
export const TRANSPARENT_TILE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
