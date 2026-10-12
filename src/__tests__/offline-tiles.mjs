#!/usr/bin/env node
/**
 * Regression tests for the offline map: the tiles in public/tiles and the style
 * registry that points at them.
 *
 * These read the committed PNGs and decode them, rather than trusting the
 * generator that produced them: the thing that ships is the artifact, and the
 * failures worth catching are the quiet ones — a style with a missing zoom, a
 * dark palette that is not actually dark, a tile in the middle of a continent
 * that is sea because a polygon's edges were clipped away, or the app and the
 * generator disagreeing about how deep the bundle goes.
 *
 * No network, no browser. Run with `npm test`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { MAP_STYLES, OFFLINE_MAX_ZOOM, mapStyle, offlineTileUrl } from '../lib/map-style.ts'
import { MAX_TILE_ZOOM, STYLES, TILE_SIZE, tileBounds } from '../../scripts/build-tiles.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tilesDir = join(here, '..', '..', 'public', 'tiles')

const failures = []
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`  ok    ${label}\n`)
    return
  }
  failures.push(label)
  process.stdout.write(`  FAIL  ${label}\n`)
  if (detail) {
    for (const line of String(detail).split('\n')) process.stdout.write(`        ${line}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

/** Decodes one of our indexed PNGs: IHDR, PLTE and a zlib stream of raw rows. */
function readTile(path) {
  const buffer = readFileSync(path)
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let palette = []
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.slice(offset + 4, offset + 8).toString('ascii')
    const body = buffer.slice(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      colorType = body[9]
    }
    if (type === 'PLTE') {
      for (let i = 0; i < body.length; i += 3) palette.push([body[i], body[i + 1], body[i + 2]])
    }
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (width + 1)] !== 0) throw new Error(`${path}: filter ${raw[y * (width + 1)]}, expected 0`)
    raw.copy(pixels, y * width, y * (width + 1) + 1, y * (width + 1) + 1 + width)
  }
  return { width, height, depth, colorType, palette, pixels }
}

const tilePath = (style, z, x, y) => join(tilesDir, style, String(z), String(x), `${y}.png`)

/** Slippy-tile coordinates of a point, and where it lands inside that tile. */
function tileOf(lon, lat, zoom) {
  const size = 2 ** zoom
  const x = Math.floor(((lon + 180) / 360) * size)
  const rad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * size)
  return { x, y }
}

/** The pixel a point lands on inside its tile, by drawing it back through the projection. */
function pixelAt(tile, lon, lat, zoom, x, y) {
  const bounds = tileBounds(zoom, x, y)
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180
  const gx = (lon + 180) / 360
  const gy = (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2
  const clamp = (value) => Math.max(0, Math.min(tile.width - 1, value))
  return {
    px: clamp(Math.round(((gx - bounds.minX) / (bounds.maxX - bounds.minX)) * tile.width - 0.5)),
    py: clamp(Math.round(((gy - bounds.minY) / (bounds.maxY - bounds.minY)) * tile.height - 0.5)),
  }
}

/** The most common colour around a pixel, so one border line cannot decide it. */
function patchColour(tile, px, py, spread = 3) {
  const counts = new Map()
  for (let dy = -spread; dy <= spread; dy += 1) {
    for (let dx = -spread; dx <= spread; dx += 1) {
      const x = px + dx
      const y = py + dy
      if (x < 0 || y < 0 || x >= tile.width || y >= tile.height) continue
      const colour = tile.palette[tile.pixels[y * tile.width + x]]
      if (!colour) continue
      const key = colour.join(',')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best = null
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count }
  return best ? best.key.split(',').map(Number) : null
}

/** What a style paints at a point, at the deepest bundled zoom. */
function colourAt(styleId, lon, lat) {
  const { x, y } = tileOf(lon, lat, OFFLINE_MAX_ZOOM)
  const tile = readTile(tilePath(styleId, OFFLINE_MAX_ZOOM, x, y))
  const { px, py } = pixelAt(tile, lon, lat, OFFLINE_MAX_ZOOM, x, y)
  return patchColour(tile, px, py)
}

const rgb = (style, name) =>
  STYLES[style].colors[name]
    .slice(1)
    .match(/../g)
    .map((hex) => parseInt(hex, 16))

const same = (a, b, tolerance = 2) =>
  a && b && Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance

// ---------------------------------------------------------------------------
section('1. The bundle and the app agree')
// ---------------------------------------------------------------------------
check(
  'the generator and the app cover the same zooms',
  MAX_TILE_ZOOM === OFFLINE_MAX_ZOOM,
  `generator ${MAX_TILE_ZOOM}, app ${OFFLINE_MAX_ZOOM}`,
)
check(
  'the offline world is deep enough to be worth having',
  OFFLINE_MAX_ZOOM >= 3,
  `${OFFLINE_MAX_ZOOM}`,
)
check(
  'every style has a bundled palette behind it',
  MAP_STYLES.every((style) => style.id in STYLES) && MAP_STYLES.length === Object.keys(STYLES).length,
  `app: ${MAP_STYLES.map((s) => s.id).join(', ')} / tiles: ${Object.keys(STYLES).join(', ')}`,
)
check(
  'every style on offer is key-free and credited',
  MAP_STYLES.every((style) => /^https:\/\//.test(style.tiles) && style.attribution.length > 10),
)
check(
  'the offline tiles are served from the app bundle, not a host',
  MAP_STYLES.every((style) => offlineTileUrl(style.id, './').startsWith('./tiles/')),
  MAP_STYLES.map((style) => offlineTileUrl(style.id, './')).join(' '),
)
check(
  'a style that is not one of ours falls back rather than throwing',
  mapStyle('swiss').id === MAP_STYLES[0].id,
)

// ---------------------------------------------------------------------------
section('2. Every tile the app promises is on disk')
// ---------------------------------------------------------------------------
let files = 0
let bytes = 0
for (const style of MAP_STYLES) {
  let missing = 0
  let present = 0
  for (let zoom = 0; zoom <= OFFLINE_MAX_ZOOM; zoom += 1) {
    const side = 2 ** zoom
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        const path = tilePath(style.id, zoom, x, y)
        if (!existsSync(path)) {
          missing += 1
          if (missing <= 3) process.stdout.write(`        missing ${style.id}/${zoom}/${x}/${y}.png\n`)
          continue
        }
        present += 1
        bytes += statSync(path).size
      }
    }
  }
  files += present
  // One tile at zoom 0, four at zoom 1, and so on: sum of 4^z, z = 0…max.
  const expected = (4 ** (OFFLINE_MAX_ZOOM + 1) - 1) / 3
  check(
    `${style.id}: the whole pyramid, zooms 0–${OFFLINE_MAX_ZOOM}`,
    missing === 0 && present === expected,
    `present ${present} of ${expected}, missing ${missing}`,
  )
}
check(
  'the whole offline world fits in a sensible payload',
  bytes > 100 * 1024 && bytes < 4 * 1024 * 1024,
  `${files} tiles, ${(bytes / 1024).toFixed(0)} KB`,
)

// ---------------------------------------------------------------------------
section('3. The tiles are PNGs a browser will draw')
// ---------------------------------------------------------------------------
const probe = readTile(tilePath('light', 0, 0, 0))
check('tiles are 256×256', probe.width === TILE_SIZE && probe.height === TILE_SIZE, `${probe.width}×${probe.height}`)
check('tiles are 8-bit indexed colour', probe.depth === 8 && probe.colorType === 3, `depth ${probe.depth}, type ${probe.colorType}`)
check(
  'the palette is a map palette, not a photograph',
  probe.palette.length >= 3 && probe.palette.length <= 256,
  `${probe.palette.length} colours`,
)
check('the tiles are a PNG, signature and all', readFileSync(tilePath('light', 0, 0, 0)).slice(0, 4).toString('hex') === '89504e47')

// ---------------------------------------------------------------------------
section('4. The drawing is really there')
// ---------------------------------------------------------------------------
const world = readTile(tilePath('light', 0, 0, 0))
const sea = rgb('light', 'sea')
const land = rgb('light', 'land')
let seaPixels = 0
let landPixels = 0
for (let i = 0; i < world.pixels.length; i += 1) {
  const colour = world.palette[world.pixels[i]]
  if (same(colour, sea)) seaPixels += 1
  if (same(colour, land)) landPixels += 1
}
const seaShare = seaPixels / world.pixels.length
const landShare = landPixels / world.pixels.length
check(
  'the world tile is mostly ocean',
  seaShare > 0.5 && seaShare < 0.85,
  `${(seaShare * 100).toFixed(1)}% sea`,
)
check(
  'the world tile has continents on it',
  landShare > 0.15,
  `${(landShare * 100).toFixed(1)}% land`,
)

/** The tiles that touch a point, so a border cannot hide the answer. */
const LAND_POINTS = [
  ['Paris', 2.35, 48.86],
  ['the Sahara', 15, 25],
  ['central Australia', 133, -25],
  ['the Amazon basin', -60, -5],
  ['Antarctica', 0, -80],
  ['Siberia', 100, 60],
]
const SEA_POINTS = [
  ['the mid-Atlantic', -30, 30],
  ['the central Pacific', -140, 0],
  ['the Indian Ocean', 75, -20],
  ['the Southern Ocean', 0, -60],
]
for (const [label, lon, lat] of LAND_POINTS) {
  const colour = colourAt('light', lon, lat)
  check(`${label} is drawn as land`, same(colour, land), `got ${colour?.join(',')}`)
}
for (const [label, lon, lat] of SEA_POINTS) {
  const colour = colourAt('light', lon, lat)
  check(`${label} is drawn as sea`, same(colour, sea), `got ${colour?.join(',')}`)
}

// A tile in the middle of a continent is the case that goes wrong quietly: it
// has no coastline of its own, so a renderer that clips polygon edges to the
// tile fills it with sea.
const inland = tileOf(15, 25, OFFLINE_MAX_ZOOM)
const inlandTile = readTile(tilePath('light', OFFLINE_MAX_ZOOM, inland.x, inland.y))
check(
  'a tile with no coastline on it is still land',
  same(inlandTile.palette[inlandTile.pixels[Math.floor(inlandTile.pixels.length / 2)]], land),
  `centre pixel ${inlandTile.palette[inlandTile.pixels[Math.floor(inlandTile.pixels.length / 2)]]?.join(',')}`,
)

// ---------------------------------------------------------------------------
section('5. The three styles are three different maps')
// ---------------------------------------------------------------------------
for (const style of MAP_STYLES) {
  const tile = readTile(tilePath(style.id, 0, 0, 0))
  check(
    `${style.id}: the sea and the land are told apart`,
    !same(rgb(style.id, 'sea'), rgb(style.id, 'land'), 4),
    `${rgb(style.id, 'sea')} vs ${rgb(style.id, 'land')}`,
  )
  const distinct = new Set(tile.pixels).size
  check(
    `${style.id}: the world tile is drawn, not blank`,
    distinct >= 4,
    `${distinct} colours on the tile`,
  )
}
const lightLand = rgb('light', 'land')
const darkLand = rgb('dark', 'land')
const lightSea = rgb('light', 'sea')
const darkSea = rgb('dark', 'sea')
const luminance = (colour) => 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2]
check(
  'the dark style is darker than the light one, land and sea alike',
  luminance(darkLand) < luminance(lightLand) - 80 && luminance(darkSea) < luminance(lightSea) - 80,
  `land ${luminance(lightLand).toFixed(0)}→${luminance(darkLand).toFixed(0)}, sea ${luminance(lightSea).toFixed(0)}→${luminance(darkSea).toFixed(0)}`,
)
const terrainTile = readTile(tilePath('terrain', 3, 6, 2))
const lightTile = readTile(tilePath('light', 3, 6, 2))
check(
  'terrain is a richer drawing than the plain styles',
  terrainTile.palette.length > lightTile.palette.length,
  `terrain ${terrainTile.palette.length} colours vs light ${lightTile.palette.length}`,
)
check(
  'the styles are not the same file with a different name',
  !readFileSync(tilePath('terrain', 3, 6, 2)).equals(readFileSync(tilePath('light', 3, 6, 2))),
)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ the offline map is broken — ${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`    • ${failure}`)
  console.error('')
  process.exit(1)
}

process.stdout.write(`\n✓ the offline map is sound (${checks} checks, ${files} tiles)\n`)
