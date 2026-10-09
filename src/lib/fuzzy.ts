import type { Place } from './types'

/**
 * Fuzzy string matching for place names.
 *
 * Google Maps does fuzzy matching: "trichy" resolves to "Tiruchirappalli"
 * because it compares names by character proximity, not exact substrings.
 *
 * Scoring strategy (highest first):
 *  1. Exact match (case+space-insensitive) - strongest
 *  2. Prefix match (starts with) - Google autocomplete
 *  3. Word-boundary match (term is whole word in name)
 *  4. Substring match (term anywhere in name)
 *  5. Fuzzy match (approximate character matching) - typo tolerance
 */

/** Normalize a name: fold diacritics, lowercase, trim, collapse whitespace. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** Clean a query token: fold diacritics, lowercase, strip punctuation. */
export function normalizeToken(token: string): string {
  return token
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Levenshtein (edit) distance between two strings.
 * Used for fuzzy similarity scoring.
 */
/**
 * Longest common subsequence length (for partial matching).
 */
function lcsLength(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0 || lb === 0) return 0

  // Only need two rows
  let prev = new Uint8Array(lb + 1)
  let curr = new Uint8Array(lb + 1)

  for (let i = 1; i <= la; i += 1) {
    curr[0] = 0
    const ai = a[i - 1]
    for (let j = 1; j <= lb; j += 1) {
      if (ai === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[lb]
}

/**
 * Sequence similarity: how much of the query's character sequence appears,
 * in order, in the name. This is the key for fuzzy matching like
 * "trichy" → "tiruchirappalli".
 *
 * The denominator is the query length, so the score is "coverage of what
 * the user typed": short names sharing only a few letters ("tornto" vs
 * "tokyo") score low instead of being inflated by their own brevity.
 */
function sequenceSimilarity(query: string, name: string): number {
  if (query.length === 0) return 0
  return lcsLength(query, name) / query.length
}

/**
 * Fuzzy (approximate) matching only kicks in for longer tokens.
 *
 * Short tokens must match literally: with an LCS threshold of 0.5 a 3-letter
 * query matches any name sharing two of its characters in order, so "par"
 * would rank Cairo and Perth alongside Paris. Returns the similarity
 * threshold to apply, or null when the token is too short to fuzz at all.
 */
function fuzzyThreshold(token: string): number | null {
  if (token.length < 4) return null // literal substring/word matching only
  if (token.length <= 5) return 0.75 // "toron" → Toronto, but not "pari" → Cairo
  return 0.6 // real typos: "trichy" → Tiruchirappalli (0.67), but
  // "tornto" must not match every other T-place that shares 3 letters.
}

/**
 * Decide whether query is a "fuzzy match" for a name: the name must share
 * the required proportion of the query's character sequence in order.
 * Queries shorter than 4 characters only match as literal substrings.
 */
function isFuzzyMatch(query: string, name: string): boolean {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  if (n.includes(q)) return true
  const threshold = fuzzyThreshold(q)
  if (threshold === null) return false
  // A typo in the first character is too loose to trust: "tornto" shares
  // 4/6 characters with "Statue of Liberty". Require the name to begin
  // like the token, then check character-sequence similarity.
  if (n.charCodeAt(0) !== q.charCodeAt(0)) return false
  return sequenceSimilarity(q, n) >= threshold
}

/**
 * A scored fuzzy match result with a similarity score.
 */
export interface FuzzyMatch {
  name: string
  score: number
  /** Whether the match is "good enough" to be useful despite not being exact. */
  fuzzy: boolean
  /* The original name text. */
  text: string
}

/** Sort by score descending, then by name ascending for stability. */
export function sortFuzzyResult(a: FuzzyMatch, b: FuzzyMatch): number {
  if (b.score !== a.score) return b.score - a.score
  return a.name.localeCompare(b.name)
}

/**
 * Score a single place against a query with multi-level matching.
 *
 * Returns a score where higher = more relevant, and a `fuzzy` flag for
 * approximate matches.
 */
export function scorePlaceFuzzy(
  name: string,
  displayName: string,
  query: string,
): { score: number; fuzzy: boolean; text: string } {
  const normalized = normalizeName(name)
  const displayNormalized = normalizeName(displayName)
  const tokens = query
    .split(/[\s/]+/)
    .map((t) => normalizeToken(t))
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return { score: 0, fuzzy: false, text: name }

  // Every token must appear in the place name or its display/address text so
  // multi-word queries ("new york") and address-only hits still match.
  let allMatch = true
  for (const term of tokens) {
    const inName = isFuzzyMatch(term, name) || name.toLowerCase().includes(term)
    // Address/display text matches literally only: fuzzy-matching a whole
    // address is far noisier than a name ("trichy" would hit "Türkiye"),
    // while literal hits still cover "par" → "Eiffel Tower, Paris".
    const inDisplay = displayNormalized.includes(term)
    if (!inName && !inDisplay) {
      allMatch = false
      break
    }
  }
  if (!allMatch) return { score: 0, fuzzy: false, text: name }

  const queryLower = query.toLowerCase()
  const nameLower = normalized
  let score = 0
  let fuzzy = false

  for (const term of tokens) {
    const termLower = term.toLowerCase()
    if (nameLower === termLower) {
      score += 300 // Exact match
      continue
    }
    if (nameLower.startsWith(termLower)) {
      score += 250 // Starts with
    } else if (new RegExp(`\\b${termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(nameLower)) {
      score += 200 // Word starts with
    } else if (nameLower.includes(termLower)) {
      score += 120 // Substring
    } else if (displayNormalized.includes(termLower)) {
      score += 70 // Present only in the address/display text
    } else {
      // Fuzzy: character-proximity match (longer tokens only, and only when
      // the name opens like the token — otherwise "par" would rank Cairo and
      // "tornto" would rank Statue of Liberty).
      const threshold = fuzzyThreshold(termLower)
      const sameFirst = nameLower.charCodeAt(0) === termLower.charCodeAt(0)
      const sim = threshold === null || !sameFirst ? 0 : sequenceSimilarity(termLower, nameLower)
      if (threshold !== null && sim >= threshold) {
        score += Math.round(60 + sim * 80) // Fuzzy bonus, up to 140
        fuzzy = true
      } else {
        score += 0
      }
    }
  }

  // Bonus for shorter names (more precise matches)
  if (nameLower.length > 0 && nameLower.length < 30) {
    score += Math.max(0, 15 - nameLower.length / 2)
  }

  // Boost for exact normalized match
  if (normalized === queryLower.trim()) {
    score += 50
  }

  return { score, fuzzy, text: name }
}

/**
 * Rank places against a query using multi-level fuzzy scoring.
 * Places that match exactly or as a prefix come first, followed by
 * fuzzy typos like "trichy" → "Tiruchirappalli".
 */
export function fuzzyRankPlaces(places: Place[], query: string): Place[] {
  const trimmed = query.trim()
  if (!trimmed) return places

  const scored = places.map((place) => {
    const result = scorePlaceFuzzy(place.name, place.displayName, trimmed)
    return { place, ...result }
  })

  const matched = scored.filter((item) => item.score > 0)

  // Sort: exact > prefix > word-boundary > substring > fuzzy
  matched.sort((a, b) => {
    // Exact matches first
    const aExact = a.place.name.toLowerCase() === trimmed.toLowerCase()
    const bExact = b.place.name.toLowerCase() === trimmed.toLowerCase()
    if (aExact !== bExact) return aExact ? -1 : 1

    // Prefix matches before fuzzy
    const aPrefix = a.place.name.toLowerCase().startsWith(trimmed.toLowerCase())
    const bPrefix = b.place.name.toLowerCase().startsWith(trimmed.toLowerCase())
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1

    // Fuzzy places before non-fuzzy
    if (a.fuzzy !== b.fuzzy) return a.fuzzy ? -1 : 1

    // Overall score
    if (b.score !== a.score) return b.score - a.score

    return a.place.name.localeCompare(b.place.name)
  })

  return matched.map((item) => item.place)
}

/**
 * Build autocomplete suggestions from a cached place set.
 * Uses fuzzy ranking so typos surface relevant places.
 */
export function buildFuzzySuggestions(
  raw: Place[],
  query: string,
  limit = 12,
): Place[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const isShortQuery = trimmed.length <= 2
  const cap = isShortQuery ? 15 : limit

  const ranked = fuzzyRankPlaces(raw, trimmed)
  return ranked.slice(0, cap)
}
