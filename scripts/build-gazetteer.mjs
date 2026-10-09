#!/usr/bin/env node
/**
 * Builds the offline world gazetteer that ships inside the app.
 *
 * Sources (download once into scripts/geonames/, see npm run data):
 *   - cities500.zip         GeoNames populated places > 500 people  (CC BY 4.0)
 *   - countryInfo.txt       GeoNames country metadata               (CC BY 4.0)
 *   - admin1CodesASCII.txt  GeoNames state/province names           (CC BY 4.0)
 *   - airports.csv          OurAirports data                        (public domain)
 *
 * Outputs:
 *   - public/data/p/{a-z|#}.json  letter-sharded place rows (fetched on demand)
 *   - public/data/countries.json  continents → countries → top 20 cities
 *   - public/data/airports.json   airport rows for the Explore tab
 *   - src/lib/world-seed.ts       tier-1 top places, bundled for instant suggestions
 *
 * Row format (places):  [name, cc, admin, lat, lon, pop, mark, alternates?]
 *   mark: C country capital, A/2/3/4/5 admin capital, x suburb/section,
 *         l locality, r railway stop, s split, w destroyed, '' plain town
 * Row format (airports): [name, cc, iataOrIcao, lat, lon, kind]
 *   kind: L large, M medium, S small
 */
import { execSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'geonames')
const root = join(here, '..')
const dataDir = join(root, 'public', 'data')
const shardDir = join(dataDir, 'p')

/** Fold diacritics so "Évora" shards to e and "São Paulo" matches "sao". */
const fold = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const foldFirst = (s) => {
  const c = fold(s.trim()).toLowerCase().charAt(0)
  return c >= 'a' && c <= 'z' ? c : '#'
}

const round4 = (n) => Math.round(n * 10000) / 10000

// ---------------------------------------------------------------------------
// Extract cities500.txt once (it is 40 MB of raw TSV inside the zip).
// ---------------------------------------------------------------------------
const citiesTxt = join(src, 'cities500.txt')
if (!existsSync(citiesTxt)) {
  console.log('Extracting cities500.zip …')
  execSync(`unzip -o -q ${JSON.stringify(join(src, 'cities500.zip'))} -d ${JSON.stringify(src)}`)
}

// ---------------------------------------------------------------------------
// countries: ISO → { name, continent, capital }
// ---------------------------------------------------------------------------
const countryText = readFileSync(join(src, 'countryInfo.txt'), 'utf8')
const countryLines = countryText.split(/\r?\n/)
const headerLine = countryLines.find((l) => l.startsWith('#ISO\t'))
const countryCols = headerLine.slice(1).split('\t')
const col = (name) => countryCols.indexOf(name)
const C_ISO = col('ISO')
const C_NAME = col('Country')
const C_CAPITAL = col('Capital')
const C_CONTINENT = col('Continent')

const countries = new Map()
for (const line of countryLines) {
  if (!line || line.startsWith('#')) continue
  const f = line.split('\t')
  if (!f[C_ISO] || f[C_ISO].length !== 2) continue
  countries.set(f[C_ISO], { iso: f[C_ISO], name: f[C_NAME] || f[C_ISO], capital: f[C_CAPITAL] || '', continent: f[C_CONTINENT] || '' })
}

// ---------------------------------------------------------------------------
// admin1: "US.CA" → "California"
// ---------------------------------------------------------------------------
const adminMap = new Map()
const adminRl = createReadStream(join(src, 'admin1CodesASCII.txt'))
for await (const line of createInterface({ input: adminRl, crlfDelay: Infinity })) {
  const [code, name] = line.split('\t')
  if (code && name) adminMap.set(code, name)
}

// ---------------------------------------------------------------------------
// Stream cities500.txt → shards + country top lists + tier-1 candidates.
// ---------------------------------------------------------------------------
const MARKERS = {
  PPLC: 'C', PPLA: 'A', PPLA2: '2', PPLA3: '3', PPLA4: '4', PPLA5: '5',
  PPLX: 'x', PPLL: 'l', PPLR: 'r', PPLS: 's', PPLW: 'w', PPLF: 'f', PPL: '',
}

const shards = new Map() // letter → row[]
const shardOf = (letter) => {
  if (!shards.has(letter)) shards.set(letter, [])
  return shards.get(letter)
}
const countryTop = new Map() // iso → row[]
const tier1 = []
let placeCount = 0

const citiesRl = createReadStream(citiesTxt)
let lineNo = 0
for await (const raw of createInterface({ input: citiesRl, crlfDelay: Infinity })) {
  lineNo += 1
  if (!raw) continue
  const f = raw.split('\t')
  // 0 id 1 name 2 asciiname 3 alternates 4 lat 5 lon 6 fclass 7 fcode
  // 8 cc 10 admin1 14 population
  if (f[6] !== 'P') continue
  const name = f[1]
  if (!name) continue
  const cc = f[8] && countries.has(f[8]) ? f[8] : ''
  const admin = f[10] && f[8] ? adminMap.get(`${f[8]}.${f[10]}`) || '' : ''
  const lat = Number(f[4])
  const lon = Number(f[5])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
  const pop = Number(f[14]) || 0
  const mark = MARKERS[f[7]] ?? ''

  // Up to 1 ASCII alternate ("Bombay" → Mumbai) so offline search finds
  // historic/alternate names without bloating the payload. Non-ASCII
  // alternates are dropped because the search normalizer only keeps a-z0-9.
  let alts
  const altRaw = f[3]
  if (altRaw) {
    for (const a of altRaw.split(',')) {
      if (!a || a.length < 3 || a.length > 40) continue
      const fa = fold(a).toLowerCase()
      if (!/^[a-z0-9 .'-]+$/.test(fa)) continue
      if (fa === name.toLowerCase() || fa === (f[2] || '').toLowerCase()) continue
      if (!alts) alts = []
      if (alts.length >= 1) break
      if (!alts.includes(fa)) alts.push(fa)
    }
  }

  const row = [name, cc, admin, round4(lat), round4(lon), pop, mark]
  if (alts && alts.length) row.push(alts)

  shardOf(foldFirst(name)).push(row)
  placeCount += 1

  // Major cities also appear in the shard of their best alternate name, so
  // offline search finds "Bombay" → Mumbai or "Cologne" → Köln without a
  // separate (multi-MB) alias index. Costs ~250 KB; only pop ≥ 50k qualifies.
  if (alts && alts.length && pop >= 50000 && foldFirst(alts[0]) !== foldFirst(name)) {
    shardOf(foldFirst(alts[0])).push(row)
  }

  if (cc) {
    let list = countryTop.get(cc)
    if (!list) { list = []; countryTop.set(cc, list) }
    if (list.length < 20) {
      list.push(row)
      list.sort((a, b) => b[5] - a[5])
      if (list.length > 20) list.pop()
    } else if (pop > list[19][5]) {
      list[19] = row
      list.sort((a, b) => b[5] - a[5])
    }
  }

  // Tier-1 candidates: every country capital plus significant cities.
  if (mark === 'C' || pop >= 150000) tier1.push(row)
}
console.log(`Parsed ${placeCount} places from ${lineNo} rows`)

// ---------------------------------------------------------------------------
// airports.csv (OurAirports, public domain): large/medium/small with a code.
// ---------------------------------------------------------------------------
const airText = readFileSync(join(src, 'airports.csv'), 'utf8')

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const airRows = parseCsv(airText)
const airHead = airRows[0]
const ai = (n) => airHead.indexOf(n)
const KIND = { large_airport: 'L', medium_airport: 'M', small_airport: 'S' }
const airportRows = []
for (let i = 1; i < airRows.length; i += 1) {
  const r = airRows[i]
  const kind = KIND[r[ai('type')]]
  if (!kind) continue
  const iata = r[ai('iata_code')]
  // Payload budget: every large/medium airport plus small strips that have
  // an IATA code — drops tiny private helipads while keeping all the
  // airports a traveller would actually mock a location at.
  if (kind === 'S' && !iata) continue
  const name = r[ai('name')]
  const lat = Number(r[ai('latitude_deg')])
  const lon = Number(r[ai('longitude_deg')])
  const cc = r[ai('iso_country')]
  const code = iata || r[ai('icao_code')] || ''
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !cc) continue
  airportRows.push([name, cc, code, round4(lat), round4(lon), kind])
}
airportRows.sort((a, b) => (a[5] === b[5] ? a[0].localeCompare(b[0]) : a[5].localeCompare(b[5])))
console.log(`Parsed ${airportRows.length} airports`)

// ---------------------------------------------------------------------------
// Write outputs.
// ---------------------------------------------------------------------------
mkdirSync(shardDir, { recursive: true })

let totalBytes = 0
const write = (path, value) => {
  const json = JSON.stringify(value)
  writeFileSync(path, json)
  totalBytes += json.length
  console.log(`  ${path.replace(root + '/', '')}  ${(json.length / 1024 / 1024).toFixed(2)} MB`)
}

const letters = 'abcdefghijklmnopqrstuvwxyz#'
for (const letter of letters) {
  // '#' is not a safe file name in a URL (it would be read as a fragment),
  // so that bucket ships as other.json.
  const file = letter === '#' ? 'other' : letter
  write(join(shardDir, `${file}.json`), shards.get(letter) || [])
}

const countriesOut = [...countries.values()]
  .map((c) => ({
    ...c,
    cities: (countryTop.get(c.iso) || []).map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]]),
  }))
  .filter((c) => c.cities.length > 0)
  .sort((a, b) => a.name.localeCompare(b.name))
write(join(dataDir, 'countries.json'), countriesOut)
write(join(dataDir, 'airports.json'), airportRows)

// ---------------------------------------------------------------------------
// Tier-1 seed module: top places by population (cap 3000), plus the curated
// landmark entries already in seed-places.ts stay as they are.
// ---------------------------------------------------------------------------
tier1.sort((a, b) => b[5] - a[5])
const top = tier1.slice(0, 3000)
const ts = `// AUTO-GENERATED by scripts/build-gazetteer.mjs — do not edit by hand.
// Tier-1 offline places (capitals + the world's largest cities) used for
// instant as-you-type suggestions before any file or network is touched.
import type { Place } from './types'

export const WORLD_TOP: Place[] = [
${top
  .map(
    (r) =>
      `  { id: 'w-${r[1] || 'xx'}-${Math.round(r[3] * 1000)}-${Math.round(r[4] * 1000)}', name: ${JSON.stringify(r[0])}, displayName: ${JSON.stringify([r[2], countries.get(r[1])?.name || r[1]].filter(Boolean).join(', '))}, lat: ${r[3]}, lon: ${r[4]} },`,
  )
  .join('\n')}
]
`
writeFileSync(join(root, 'src', 'lib', 'world-seed.ts'), ts)
totalBytes += ts.length
console.log(`  src/lib/world-seed.ts  ${(ts.length / 1024).toFixed(0)} KB (${top.length} places)`)
console.log(`Total data payload: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
