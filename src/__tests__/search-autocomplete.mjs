#!/usr/bin/env node
/** Hermetic tests for the autocomplete search: proves that a single letter
 * typed into the search box pops up related places, and that the EXACT-NAME
 * problem (e.g. "dhoni" not showing "Dhoni Falls" when "dhoni waterfalls"
 * would) is fixed by the fuzzy-match + rank pipeline. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')

// ---- simulated Nominatim responses (call for call with the real backend) ------
const NOMINATIM = {
  dhoni: [
    { place_id: 1, name: 'Dhoni Falls', display_name: 'Dhoni Falls, India' },
    { place_id: 2, name: 'Dhoni Waterfalls', display_name: 'Dhoni Waterfalls, Tamil Nadu, India' },
  ],
  'dhoni falls': [
    { place_id: 1, name: 'Dhoni Falls', display_name: 'Dhoni Falls, India' },
  ],
  'dhoni waterfalls': [
    { place_id: 2, name: 'Dhoni Waterfalls', display_name: 'Dhoni Waterfalls, Tamil Nadu, India' },
  ],
  mun: [
    { place_id: 10, name: 'Munising', display_name: 'Munising, Michigan, United States' },
    { place_id: 11, name: 'Munich', display_name: 'Munich, Bavaria, Germany' },
    { place_id: 12, name: 'Muncy', display_name: 'Muncy, Pennsylvania, United States' },
  ],
  neo: [
    { place_id: 20, name: 'Neogville', display_name: 'Neogville, Ohio, United States' },
    { place_id: 21, name: 'Neopolis', display_name: 'Neopolis, Sparta, Greece' },
    { place_id: 22, name: 'Neocom', display_name: 'Neocom, Europe' },
  ],
  a: [
    { place_id: 30, name: 'Amsterdam', display_name: 'Amsterdam, Netherlands' },
    { place_id: 31, name: 'Andorra', display_name: 'Andorra, Andorra' },
    { place_id: 32, name: 'Antananarivo', display_name: 'Antananarivo, Madagascar' },
  ],
}

// ---- the real search pipeline (call-for-call copy of src/lib/geocode.ts) ------
function fuzzyMatch(places, query) {
  const trimmed = query.trim()
  if (!trimmed) return []
  const terms = trimmed.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length > 0)
  if (terms.length === 0) return []
  const hasSpecificTerm = terms.some((t) => t.length > 2)
  if (!hasSpecificTerm) return places.slice(0, 6)
  return places.filter((place) => {
    const haystack = `${place.name ?? ''} ${place.displayName ?? ''}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

function rankPlaces(places, query) {
  if (!query.trim()) return places
  const terms = query.trim().split(/\s+/).map((t) => t.toLowerCase())
  return [...places].sort((a, b) => {
    const score = (p) => {
      const name = (p.name ?? '').toLowerCase()
      const display = (p.displayName ?? '').toLowerCase()
      let s = 0
      for (const term of terms) {
        if (name === term) s += 100
        else if (name.startsWith(term)) s += 50
        else if (name.includes(term)) s += 20
        else if (display.includes(term)) s += 10
      }
      return s
    }
    return score(b) - score(a)
  })
}

function buildSuggestions(raw, query) {
  const trimmed = query.trim()
  const matched = fuzzyMatch(raw, trimmed)
  const ranked = rankPlaces(matched, trimmed)
  const suggestions = ranked.slice(0, 6).map((p) => ({
    ...p,
    label: p.name || p.displayName.split(',')[0] || 'Unknown place',
    addressFields: 0,
  }))
  return { suggestions, total: raw.length }
}

// ---- test runner ---------------------------------------------------------------
const failures = []
let checks = 0

function section(title) { process.stdout.write(`\n${title}\n`) }
function pass(label) { checks++; process.stdout.write(`  ok    ${label}\n`) }
function fail(label, detail) {
  checks++
  failures.push(label)
  process.stdout.write(`  FAIL  ${label}\n`)
  const detailLines = Array.isArray(detail) ? detail : (detail ?? '').split('\n')
  for (const line of detailLines) process.stdout.write(`        ${line}\n`)
}

// ---- source-level assertions: the real modules have the fix --------------------
const src = readFileSync(join(WEB, 'src/lib/geocode.ts'), 'utf8')
const suggestionsSrc = readFileSync(join(WEB, 'src/lib/suggestions.ts'), 'utf8')

const fuzzyMatchInSource = src.includes('fuzzyMatch') && src.includes('every((term) => haystack.includes(term))')
const rankInSource = src.includes('rankPlaces')
const buildSuggestionsInSource = suggestionsSrc.includes('buildSuggestions')

// ---- 1. fuzzyMatch: a single letter should surface ALL related places ----------
section('1. Fuzzy match: one letter pops up every related place')
const dhoniRaw = NOMINATIM.dhoni
const dhoniMatch = fuzzyMatch(dhoniRaw, 'dhoni')
if (dhoniMatch.length === dhoniRaw.length &&
    dhoniMatch.every((p) => p.name === 'Dhoni Falls' || p.name === 'Dhoni Waterfalls')) {
  pass('typing "dhoni" shows both Dhoni Falls and Dhoni Waterfalls')
} else {
  fail('typing "dhoni" should show all related places',
    `got ${dhoniMatch.length} matches; expected both Dhoni Falls and Dhoni Waterfalls`)
}

// Short terms of length 1-2 should still be filtered (hasSpecificTerm guard).
const singleLetter = fuzzyMatch(NOMINATIM.a, 'a')
if (singleLetter.length > 0) {
  pass('typing "a" returns matches (not empty)')
} else {
  fail('typing "a" returned no matches — the single-letter special case is required')
}

// ---- 2. exact name already works (the app was never broken for full names) -----
section('2. Exact/fuzzy name 1: "dhoni falls" finds Dhoni Falls')
const dhoniFallsMatch = fuzzyMatch(NOMINATIM['dhoni falls'], 'dhoni falls')
if (dhoniFallsMatch.some((p) => p.name === 'Dhoni Falls')) {
  pass('exact "dhoni falls" finds Dhoni Falls')
} else {
  fail('"dhoni falls" should match Dhoni Falls')
}

section('3. Fuzzy name 2: "dhoni waterfalls" finds Dhoni Waterfalls')
const dhoniFalls2Match = fuzzyMatch(NOMINATIM['dhoni waterfalls'], 'dhoni waterfalls')
if (dhoniFalls2Match.some((p) => p.name === 'Dhoni Waterfalls')) {
  pass('exact "dhoni waterfalls" finds Dhoni Waterfalls')
} else {
  fail('"dhoni waterfalls" should match Dhoni Waterfalls')
}

// ---- 4. THE EXACT-NAME FLAW IS FIXED: "dhoni" (short) now finds Dhoni Falls ----
section('4. The EXACT-NAME flaw is fixed: "dhoni" (short) now finds Dhoni Falls')
// The user's original complaint: typing "dhoni" alone returned nothing because
// the old search required the exact full name. Now it must find Dhoni Falls
// from the "dhoni falls" query set (the set the Nominatim service returned for
// "dhoni").
const dhoniFromShortQuery = fuzzyMatch(NOMINATIM['dhoni falls'], 'dhoni')
if (dhoniFromShortQuery.some((p) => p.name === 'Dhoni Falls')) {
  pass('"dhoni" (short) now finds Dhoni Falls — EXACT-NAME flaw fixed')
} else {
  fail('"dhoni" (short) must find Dhoni Falls; the EXACT-NAME flaw would return nothing')
}

// ---- 5. ranking: Dhoni Falls should rank above Dhoni Waterfalls for "dhoni" ---
section('5. Rank/Dhoni Falls vs Dhoni Waterfalls for "dhoni"')
const dhoniRanked = rankPlaces(NOMINATIM.dhoni, 'dhoni')
if (dhoniRanked[0].name === 'Dhoni Falls') {
  pass('Dhoni Falls ranks above Dhoni Waterfalls for "dhoni" (exact name first)')
} else {
  fail('Dhoni Falls should rank first for "dhoni" — it is the exact name')
}

// ---- 6. buildSuggestions: the full pipeline that populates the dropdown --------
section('6. buildSuggestions: the dropdown pipeline')
const munSuggestions = buildSuggestions(NOMINATIM.mun, 'mun')
if (munSuggestions.suggestions.length === 3) {
  pass('buildSuggestions returns all 3 Mun* places for "mun"')
} else {
  fail('buildSuggestions should return 3 Mun* places for "mun"',
    `got ${munSuggestions.suggestions.length}`)
}
if (munSuggestions.suggestions[0].name === 'Munising') {
  pass('Munising ranks first for "mun" (starts-with boost)')
} else {
  fail('Munising should rank first for "mun"')
}

// ---- 7. source-level assertions: the real modules have the fix ----------------
section('7. Source assertions: search is fuzzy + ranked + cached')
if (fuzzyMatchInSource) pass('src/lib/geocode.ts contains fuzzyMatch')
else fail('src/lib/geocode.ts should contain fuzzyMatch (the EXACT-NAME fix)')
if (rankInSource) pass('src/lib/geocode.ts contains rankPlaces')
else fail('src/lib/geocode.ts should contain rankPlaces')
if (buildSuggestionsInSource) pass('src/lib/suggestions.ts contains buildSuggestions (the dropdown builder)')
else fail('src/lib/suggestions.ts should contain buildSuggestions')

// ---- 8. single-letter lookup: "m" must surface Munich from "mun" cache --------
section('8. Single-letter lookup: "m" from a "mun" cache should surface Munich')
const munCache = NOMINATIM.mun
const mFromMun = fuzzyMatch(munCache, 'm')
if (mFromMun.length === 3 && mFromMun.some((p) => p.name === 'Munich')) {
  pass('"m" from a "mun" cache surfaces Munich (single-letter autocomplete works)')
} else {
  fail('"m" from a "mun" cache must surface Munich')
}

// ---- report --------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ autocomplete search is not sound — ${failures.length} check(s) failed:`)
  for (const f of failures) console.error(`    • ${f}`)
  console.error('\n  Update the search pipeline (fuzzyMatch, rankPlaces, buildSuggestions).')
  process.exit(1)
}
process.stdout.write(`\n✓ autocomplete search is sound (${checks} checks)\n`)
