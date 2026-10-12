#!/usr/bin/env node
/**
 * Renders the offline world tiles that ship inside the app.
 *
 * Why these tiles are drawn here rather than downloaded: the map styles above
 * level 4 come from public tile servers (OpenStreetMap, OpenTopoMap), and their
 * usage policies do not permit keeping their tiles for offline use or bundling
 * them into an app — OSM's policy rules offline use out explicitly. So the
 * offline layer is drawn from Natural Earth vectors instead, which are public
 * domain: no provider, no keys, no attribution obligations, and the drawing is
 * ours to recolour.
 *
 * Sources (downloaded once into scripts/natural-earth/, gitignored):
 *   - ne_50m_land                            land polygons            (public domain)
 *   - ne_50m_lakes                           inland water             (public domain)
 *   - ne_50m_rivers_lake_centerlines         rivers                   (public domain)
 *   - ne_50m_admin_0_boundary_lines_land     country borders          (public domain)
 *   - ne_50m_geography_regions_polys         deserts, ranges, plateaus (public domain)
 *
 * Outputs: public/tiles/<style>/<z>/<x>/<y>.png for zooms 0..MAX_TILE_ZOOM,
 * one 256×256 indexed-colour PNG per tile per style. Indexed colour is what
 * keeps this cheap: flat map colours compress to a few hundred bytes a tile,
 * so three complete world pyramids weigh about as much as one photograph.
 *
 * Usage:
 *   npm run tiles                 # every style, zooms 0..4
 *   npm run tiles -- --max-zoom=3
 *   npm run tiles -- --only=terrain
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourceDir = join(here, 'natural-earth')
const outDir = join(root, 'public', 'tiles')

/** One tile, in pixels. The only size Leaflet draws without scaling. */
export const TILE_SIZE = 256

/** Detail multiplier while drawing: 2 means four samples per output pixel. */
const SUPERSAMPLE = 2
const SAMPLES = TILE_SIZE * SUPERSAMPLE

/**
 * The last zoom the bundled tiles cover. Beyond it Leaflet scales the zoom-4
 * tile up, which is why the map still draws when there is no data at all.
 * Kept in step with OFFLINE_MAX_ZOOM in src/lib/map-style.ts by a test.
 */
export const MAX_TILE_ZOOM = 4

/** Web Mercator stops here; beyond it the projection runs away to infinity. */
const LAT_LIMIT = 85.05112878

const SOURCES = [
  'ne_50m_land',
  'ne_50m_lakes',
  'ne_50m_rivers_lake_centerlines',
  'ne_50m_admin_0_boundary_lines_land',
  'ne_50m_geography_regions_polys',
]

const SOURCE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'

/**
 * The three styles, each a set of map colours plus which layers it bothers to
 * draw. Offline the three share one drawing in three palettes, but not one set
 * of layers: terrain carries rivers and relief tints so the switch does
 * something visible even with no data.
 */
export const STYLES = {
  light: {
    widths: { border: 1.4 },
    layers: ['land', 'lakes', 'borders'],
    colors: {
      sea: '#cfe3ec',
      land: '#f2efe7',
      lake: '#b8d8ea',
      river: '#a9cde2',
      border: '#b3a897',
      desert: '#efe1c2',
      range: '#e0d5c4',
    },
  },
  dark: {
    widths: { border: 1.4 },
    layers: ['land', 'lakes', 'borders'],
    colors: {
      sea: '#0d1722',
      land: '#1e2833',
      lake: '#16283a',
      river: '#22405c',
      border: '#3b4a59',
      desert: '#2b3039',
      range: '#272f3c',
    },
  },
  terrain: {
    widths: { border: 1.2, river: 2 },
    layers: ['land', 'regions', 'lakes', 'rivers', 'borders'],
    colors: {
      sea: '#bcd8e6',
      land: '#dfe6cf',
      lake: '#a5cde4',
      river: '#7fb0d0',
      border: '#a4907c',
      desert: '#f0e0b4',
      range: '#cbb494',
    },
  },
}

// ---------------------------------------------------------------------------
// Projection: lon/lat → the normalised square every slippy tile comes from.
// ---------------------------------------------------------------------------

/**
 * Global map coordinates: x and y both run 0→1 over the Web Mercator square.
 * Projecting each vertex once means a tile only has to shift and scale them.
 */
export function project(lon, lat) {
  const clamped = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat))
  const rad = (clamped * Math.PI) / 180
  const mercator = Math.log(Math.tan(Math.PI / 4 + rad / 2))
  return { x: (lon + 180) / 360, y: (1 - mercator / Math.PI) / 2 }
}

/** The normalised square a tile covers, so geometry can be pruned per tile. */
export function tileBounds(zoom, x, y) {
  const span = 1 / 2 ** zoom
  return { minX: x * span, minY: y * span, maxX: (x + 1) * span, maxY: (y + 1) * span }
}

// ---------------------------------------------------------------------------
// Geometry: load once, keep vertices and a bounding box per ring.
// ---------------------------------------------------------------------------

const bboxOf = (points) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

const toRing = (coordinates) => {
  const points = coordinates.map(([lon, lat]) => project(lon, lat))
  return { points, bbox: bboxOf(points) }
}

/** A polygon is its rings: later rings in a GeoJSON polygon are holes. */
const toPolygon = (geometry) => {
  if (geometry.type === 'Polygon') return [geometry.coordinates.map(toRing)]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((poly) => poly.map(toRing))
  return []
}

const toLines = (geometry) => {
  if (geometry.type === 'LineString') return [toRing(geometry.coordinates)]
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map(toRing)
  return []
}

function loadFeatures(name) {
  const path = join(sourceDir, `${name}.geojson`)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const polygons = []
  const lines = []
  for (const feature of parsed.features) {
    if (!feature.geometry) continue
    polygons.push(...toPolygon(feature.geometry).map((rings) => ({ rings, bbox: bboxOf(rings.flatMap((r) => r.points)), props: feature.properties })))
    lines.push(...toLines(feature.geometry).map((ring) => ({ ring, props: feature.properties })))
  }
  return { polygons: polygons.filter((p) => p.rings.length), lines }
}

async function ensureSources() {
  mkdirSync(sourceDir, { recursive: true })
  for (const name of SOURCES) {
    const path = join(sourceDir, `${name}.geojson`)
    if (existsSync(path)) continue
    const url = `${SOURCE_BASE}/${name}.geojson`
    process.stdout.write(`Downloading ${name} …`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`)
    writeFileSync(path, await res.text())
    process.stdout.write(' done\n')
  }
}

// ---------------------------------------------------------------------------
// Rasterising: exact coverage per sample row, so polygons are clipped once.
// ---------------------------------------------------------------------------

/**
 * Fills a set of polygons into an index buffer.
 *
 * Edges are converted to sample space and clipped to the tile before any
 * filling happens, which is what keeps this linear: a world coastline only
 * contributes the handful of edges that actually cross the tile.
 */
function fillPolygons(buffer, polygons, bounds, colorIndex, scale) {
  const span = 2 ** scale
  for (const polygon of polygons) {
    if (
      polygon.bbox.maxX < bounds.minX ||
      polygon.bbox.minX > bounds.maxX ||
      polygon.bbox.maxY < bounds.minY ||
      polygon.bbox.minY > bounds.maxY
    ) {
      continue
    }

    // Every ring of the polygon shares the even-odd rule, holes included.
    //
    // The edges are deliberately *not* clipped to the tile. A tile in the
    // middle of a continent has no edge of its own anywhere near it, and
    // dropping the far-away edges would leave the tile looking like sea: what
    // fills it is the parity of everything crossing the row to its left. So
    // edges are kept whole and the span is clamped when it is painted.
    const edges = []
    for (const ring of polygon.rings) {
      const points = ring.points
      if (ring.bbox.maxX < bounds.minX || ring.bbox.minX > bounds.maxX) continue
      for (let i = 1; i < points.length; i += 1) {
        const ax = (points[i - 1].x - bounds.minX) * span * SAMPLES
        const ay = (points[i - 1].y - bounds.minY) * span * SAMPLES
        const bx = (points[i].x - bounds.minX) * span * SAMPLES
        const by = (points[i].y - bounds.minY) * span * SAMPLES
        if (ay === by) continue
        // A ring that jumps the whole map is a seam at the antimeridian, not a
        // line across the world. Natural Earth splits its land and lakes at the
        // seam, so nothing that should fill a tile is lost by ignoring one.
        if (Math.abs(bx - ax) > SAMPLES) continue
        edges.push({ y0: ay, y1: by, x0: ax, slope: (bx - ax) / (by - ay), top: Math.min(ay, by), bottom: Math.max(ay, by) })
      }
    }

    for (let row = 0; row < SAMPLES; row += 1) {
      const hits = []
      for (const edge of edges) {
        // Half-open rows: a vertex shared by two edges must count once.
        if (row < edge.top || row >= edge.bottom) continue
        hits.push(edge.x0 + (row - edge.y0) * edge.slope)
      }
      if (hits.length < 2) continue
      hits.sort((a, b) => a - b)
      const base = row * SAMPLES
      for (let i = 0; i + 1 < hits.length; i += 2) {
        let start = Math.max(0, Math.ceil(hits[i]))
        const end = Math.min(SAMPLES - 1, Math.floor(hits[i + 1]))
        for (; start <= end; start += 1) buffer[base + start] = colorIndex
      }
    }
  }
}

/** Cohen–Sutherland against the sample square; null when the edge misses it. */
function clipSegment(ax, ay, bx, by) {
  const max = SAMPLES - 1
  const codes = (x, y) => (x < 0 ? 1 : 0) | (x > max ? 2 : 0) | (y < 0 ? 4 : 0) | (y > max ? 8 : 0)
  let [x0, y0, x1, y1] = [ax, ay, bx, by]
  let code0 = codes(x0, y0)
  let code1 = codes(x1, y1)
  for (let guard = 0; guard < 12; guard += 1) {
    if (!(code0 | code1)) return [x0, y0, x1, y1]
    if (code0 & code1) return null
    const code = code0 || code1
    let x
    let y
    if (code & 8) {
      y = max
      x = x0 + ((x1 - x0) * (max - y0)) / (y1 - y0)
    } else if (code & 4) {
      y = 0
      x = x0 + ((x1 - x0) * (0 - y0)) / (y1 - y0)
    } else if (code & 2) {
      x = max
      y = y0 + ((y1 - y0) * (max - x0)) / (x1 - x0)
    } else {
      x = 0
      y = y0 + ((y1 - y0) * (0 - x0)) / (x1 - x0)
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (code === code0) {
      x0 = x
      y0 = y
      code0 = codes(x0, y0)
    } else {
      x1 = x
      y1 = y
      code1 = codes(x1, y1)
    }
  }
  return [x0, y0, x1, y1]
}

/** Strokes polylines as thick sample points, one square per step. */
function strokeLines(buffer, lines, bounds, colorIndex, scale, width) {
  const span = 2 ** scale
  const half = Math.max(0, Math.round((width * SUPERSAMPLE) / 2) - 1)
  for (const line of lines) {
    const points = line.ring.points
    for (let i = 1; i < points.length; i += 1) {
      const ax = (points[i - 1].x - bounds.minX) * span * SAMPLES
      const ay = (points[i - 1].y - bounds.minY) * span * SAMPLES
      const bx = (points[i].x - bounds.minX) * span * SAMPLES
      const by = (points[i].y - bounds.minY) * span * SAMPLES
      if (Math.abs(bx - ax) > SAMPLES) continue
      const clipped = clipSegment(ax, ay, bx, by)
      if (!clipped) continue
      const [x0, y0, x1, y1] = clipped
      const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))
      if (steps <= 0) continue
      for (let step = 0; step <= steps; step += 1) {
        const cx = Math.round(x0 + ((x1 - x0) * step) / steps)
        const cy = Math.round(y0 + ((y1 - y0) * step) / steps)
        for (let dy = -half; dy <= half; dy += 1) {
          const row = cy + dy
          if (row < 0 || row >= SAMPLES) continue
          for (let dx = -half; dx <= half; dx += 1) {
            const col = cx + dx
            if (col < 0 || col >= SAMPLES) continue
            buffer[row * SAMPLES + col] = colorIndex
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Palettes: base colours plus the blends antialiasing needs, as one index.
// ---------------------------------------------------------------------------

const parseHex = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/**
 * A colour table that grows as antialiasing needs it, deduplicated by colour:
 * a PNG palette holds 256 entries, and mixing two map colours produces plenty
 * of near-duplicates without this.
 */
function createPalette(colors) {
  const entries = []
  const lookup = new Map()
  const add = (rgb) => {
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}`
    const hit = lookup.get(key)
    if (hit !== undefined) return hit
    if (entries.length >= 256) return 0
    entries.push(rgb)
    lookup.set(key, entries.length - 1)
    return entries.length - 1
  }
  for (const color of colors) add(color)
  return { entries, add }
}

/** Drops a line of the buffer by averaging each 2×2 block of samples. */
function downsample(samples, palette) {
  const key = (a, b, c, d) => a | (b << 3) | (c << 6) | (d << 9)
  const cache = new Map()
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE)
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const a = samples[(y * 2) * SAMPLES + x * 2]
      const b = samples[(y * 2) * SAMPLES + x * 2 + 1]
      const c = samples[(y * 2 + 1) * SAMPLES + x * 2]
      const d = samples[(y * 2 + 1) * SAMPLES + x * 2 + 1]
      if (a === b && b === c && c === d) {
        out[y * TILE_SIZE + x] = a
        continue
      }
      const k = key(a, b, c, d)
      const hit = cache.get(k)
      if (hit !== undefined) {
        out[y * TILE_SIZE + x] = hit
        continue
      }
      // The average of the four samples: a blend of map colours, which reads
      // as a soft edge at 256 px even though the drawing is exact.
      const mixed = blend([a, b, c, d], palette.entries)
      const index = palette.add(mixed)
      cache.set(k, index)
      out[y * TILE_SIZE + x] = index
    }
  }
  return out
}

/** The average colour of four palette entries, as a colour. */
function blend(indices, entries) {
  let r = 0
  let g = 0
  let b = 0
  for (const index of indices) {
    const color = entries[index]
    r += color[0]
    g += color[1]
    b += color[2]
  }
  return [Math.round(r / indices.length), Math.round(g / indices.length), Math.round(b / indices.length)]
}

// ---------------------------------------------------------------------------
// PNG: indexed colour, filter 0 rows, one zlib stream.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Encodes 8-bit palette indices as a PNG a browser will draw as-is. */
export function encodePng(indices, palette) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(TILE_SIZE, 0)
  header.writeUInt32BE(TILE_SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 3 // indexed colour
  const raw = Buffer.alloc((TILE_SIZE + 1) * TILE_SIZE)
  for (let y = 0; y < TILE_SIZE; y += 1) {
    raw[y * (TILE_SIZE + 1)] = 0 // filter: none
    raw.set(indices.subarray(y * TILE_SIZE, (y + 1) * TILE_SIZE), y * (TILE_SIZE + 1) + 1)
  }
  const plte = Buffer.alloc(palette.length * 3)
  palette.forEach((color, i) => {
    plte[i * 3] = color[0]
    plte[i * 3 + 1] = color[1]
    plte[i * 3 + 2] = color[2]
  })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// One tile, one style.
// ---------------------------------------------------------------------------

export function renderTile({ zoom, x, y, style, data }) {
  const spec = STYLES[style]
  const bounds = tileBounds(zoom, x, y)
  const order = ['sea', 'land', 'desert', 'range', 'lake', 'river', 'border']
  const palette = createPalette(order.map((name) => parseHex(spec.colors[name])))
  const index = Object.fromEntries(order.map((name, i) => [name, i]))

  const samples = new Uint8Array(SAMPLES * SAMPLES).fill(index.sea)
  const scale = zoom

  if (spec.layers.includes('land')) fillPolygons(samples, data.land.polygons, bounds, index.land, scale)
  if (spec.layers.includes('regions')) {
    const deserts = data.regions.polygons.filter((p) => p.props.FEATURECLA === 'Desert')
    const relief = data.regions.polygons.filter((p) =>
      ['Range/mtn', 'Plateau', 'Foothills'].includes(p.props.FEATURECLA),
    )
    fillPolygons(samples, relief, bounds, index.range, scale)
    fillPolygons(samples, deserts, bounds, index.desert, scale)
  }
  if (spec.layers.includes('lakes')) fillPolygons(samples, data.lakes.polygons, bounds, index.lake, scale)
  if (spec.layers.includes('rivers')) {
    strokeLines(samples, data.rivers.lines, bounds, index.river, scale, spec.widths.river ?? 1)
  }
  if (spec.layers.includes('borders')) {
    strokeLines(samples, data.borders.lines, bounds, index.border, scale, spec.widths.border ?? 1)
  }

  return encodePng(downsample(samples, palette), palette.entries)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argument(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function main() {
  const maxZoom = Number(argument('max-zoom', MAX_TILE_ZOOM))
  const only = argument('only', '')
  const styles = only ? only.split(',').filter((s) => s in STYLES) : Object.keys(STYLES)
  if (!styles.length) throw new Error(`--only=${only} names no style. Try: ${Object.keys(STYLES).join(', ')}`)

  await ensureSources()

  process.stdout.write('Reading Natural Earth vectors …')
  const data = {
    land: loadFeatures('ne_50m_land'),
    lakes: loadFeatures('ne_50m_lakes'),
    rivers: loadFeatures('ne_50m_rivers_lake_centerlines'),
    borders: loadFeatures('ne_50m_admin_0_boundary_lines_land'),
    regions: loadFeatures('ne_50m_geography_regions_polys'),
  }
  process.stdout.write(
    ` ${data.land.polygons.length} land, ${data.lakes.polygons.length} water, ` +
      `${data.borders.lines.length} border, ${data.regions.polygons.length} region shapes\n`,
  )

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

  let grandTotal = 0
  for (const style of styles) {
    let count = 0
    let bytes = 0
    for (let zoom = 0; zoom <= maxZoom; zoom += 1) {
      const side = 2 ** zoom
      for (let x = 0; x < side; x += 1) {
        const dir = join(outDir, style, String(zoom), String(x))
        mkdirSync(dir, { recursive: true })
        for (let y = 0; y < side; y += 1) {
          const png = renderTile({ zoom, x, y, style, data })
          writeFileSync(join(dir, `${y}.png`), png)
          count += 1
          bytes += png.length
        }
      }
    }
    grandTotal += bytes
    console.log(
      `  ${style.padEnd(8)} ${String(count).padStart(5)} tiles  ${(bytes / 1024).toFixed(0)} KB  ` +
        `(zooms 0–${maxZoom})`,
    )
  }
  console.log(`Offline tiles: ${(grandTotal / 1024).toFixed(0)} KB in public/tiles/`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
