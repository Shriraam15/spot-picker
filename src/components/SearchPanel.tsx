import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnSelectFlow, Place, SearchResults } from '@/lib/search'
import type { Favorite as _Favorite } from '@/lib/types'
import { Button, Card, CardHeader, Icon } from './ui'
import { getRecentSearches, type RecentSearch, searchRecentSearches } from '@/lib/recent-searches'

type Props = {
  /** Suggestions to render while the user type. */
  suggestions: SearchResults['suggestions']
  /** Fired on every keystroke so the parent can rerank its local cache
   * instantly, before any network round-trip. */
  onQueryChange?: (query: string) => void
  /** Whether the service is waiting on the 1/s throttle. */
  loading: boolean
  /** Service errors to surface. */
  error: string | null
  /** Exact-name search. */
  onSearch: (query: string, flow?: OnSelectFlow) => void
  /** Choose a suggestion from the list. */
  onSelect: (place: Place, flow?: OnSelectFlow) => void
}

export default function SearchPanel({
  suggestions,
  loading,
  error,
  onSearch,
  onSelect,
  onQueryChange,
}: Props) {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(-1)
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([])
  const [showRecent, setShowRecent] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Load recent searches when query is empty
  useEffect(() => {
    if (!query.trim()) {
      const recent = getRecentSearches()
      setRecentSearches(recent)
      setShowRecent(true)
    } else {
      setShowRecent(false)
    }
  }, [query])

  // Search recent searches as-you-type when the query is short but non-empty
  // (so the dropdown also shows recently visited places before the network call).
  const [recentMatches, setRecentMatches] = useState<Place[]>([])
  useEffect(() => {
    if (!query.trim()) {
      setRecentMatches([])
      return
    }
    // Show up to 3 recent-search matches while typing, blended with the
    // fuzzy autocompletion below.
    const matches = searchRecentSearches(query)
    setRecentMatches(matches.slice(0, 3))
  }, [query])

  const handleSelectRecent = useCallback((item: RecentSearch) => {
    setQuery(item.query)
    setShowRecent(false)
    // Trigger search with the recent query
    onSearch(item.query, 'jump')
    inputRef.current?.focus()
    // Add to recent searches on selection
    onSelect(item.place, 'jump')
  }, [onSearch, onSelect])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocused((f) => Math.min(f + 1, suggestions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocused((f) => Math.max(f - 1, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (focused >= 0 && focused < suggestions.length) {
          const s = suggestions[focused]
          onSelect(s, 'jump')
          setQuery('')
          setFocused(-1)
        } else if (query.trim()) {
          onSearch(query.trim())
          setQuery('')
          setFocused(-1)
        }
      } else if (e.key === 'Escape') {
        setQuery('')
        setFocused(-1)
        inputRef.current?.blur()
      }
    },
    [focused, suggestions, query, onSelect, onSearch],
  )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      onSearch(query.trim(), 'jump')
      // Add to recent searches after successful search
      inputRef.current?.blur()
    }
  }

  // Also trigger an instant search when the user presses Enter on an empty
  // query and there are recent matches: this is the "Google search bar"
  // behaviour the user asked for.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !query.trim() && recentMatches.length > 0) {
      e.preventDefault()
      const first = recentMatches[0]
      setQuery(first.name)
      setShowRecent(false)
      onSearch(first.name, 'jump')
      inputRef.current?.focus()
      onSelect(first, 'jump')
      return
    }
    onKeyDown(e)
  }

  return (
    <Card className="transition-all duration-300">
      <CardHeader
        title="Search a place"
        hint="Type to search, or pick from recent places below"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('')
              setShowRecent(true)
              inputRef.current?.focus()
            }}
            disabled={!recentSearches.length}
          >
            <Icon name="clock" className="h-3.5 w-3.5" />
            Recent
          </Button>
        }
      />

      <form onSubmit={submit} className="px-4 pb-3">
        {/* Search input with glow effect */}
        <div
          className={`relative flex items-center gap-2 rounded-xl border bg-[var(--surface-2)] px-3 transition-all duration-300 ${
            query
              ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(var(--accent-rgb),0.12)]'
              : 'border-[var(--border)] hover:border-[var(--border-strong)]'
          }`}
        >
          {/* Decorative glow when focused */}
          {query && (
            <div
              className="pointer-events-none absolute -inset-1 rounded-xl bg-gradient-to-r from-[var(--accent)]/20 to-transparent opacity-50 blur-sm"
            />
          )}
          
          <Icon name="search" className="h-4 w-4 shrink-0 text-[var(--text-subtle)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              onQueryChange?.(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search places…"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Search places"
            className="h-11 w-full bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setFocused(-1)
                setShowRecent(true)
              }}
              aria-label="Clear search"
              className="text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* Show recent searches when nothing typed yet */}
        {!query.trim() && recentSearches.length > 0 && showRecent ? (
          <div className="mt-3">
            <p className="mb-2 text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              Recent Searches
            </p>
            <ul
              ref={listRef}
              className="max-h-40 overflow-y-auto divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
            >
              {recentSearches.map((item) => (
                <li key={item.timestamp}>
                  <button
                    type="button"
                    onClick={() => handleSelectRecent(item)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] hover:bg-[var(--surface-2)]`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon name="clock" className="h-3.5 w-3.5 text-[var(--text-subtle)] shrink-0" />
                      <span className="text-[13px] font-medium text-[var(--text)]">{item.place.name}</span>
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {item.place.displayName} · {new Date(item.timestamp).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : query.trim().length > 0 ? (
          <ul
            ref={listRef}
            className="max-h-64 overflow-y-auto divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {loading ? (
              <li className="px-3 py-3 text-xs text-[var(--text-subtle)]">
                <span className="inline-flex items-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="32" strokeDashoffset="32" />
                  </svg>
                  Searching places…
                </span>
              </li>
            ) : recentMatches.length > 0 ? (
              <li className="px-3 pt-3 pb-0 text-xs font-semibold text-[var(--text-subtle)] uppercase tracking-wider">
                Recent searches
              </li>
            ) : null}
            {recentMatches.map((s) => (
              <li key={`recent-${s.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(s.name)
                    setShowRecent(true)
                    onSelect(s, 'jump')
                  }}
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] hover:bg-[var(--surface-2)]`}
                >
                  <span className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                    <span className="text-[13px] font-medium text-[var(--text)]">{s.name}</span>
                  </span>
                  <span className="line-clamp-2 text-[11px] text-[var(--text-muted)]">{s.displayName}</span>
                </button>
              </li>
            ))}
            {recentMatches.length > 0 ? (
              <li className="px-3 py-1.5 text-[10px] text-[var(--text-subtle)] -mt-1">
                Tap to search this place &middot; {recentMatches.length} match{recentMatches.length !== 1 ? 'es' : ''}
              </li>
            ) : null}
            {suggestions.length === 0 ? (
              <li className="px-3 py-3 text-xs text-[var(--text-muted)]">
                No places match &mdash; try a different spelling or more letters.
              </li>
            ) : (
              suggestions.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('')
                      setShowRecent(true)
                      onSelect(s, 'jump')
                    }}
                    onMouseEnter={() => setFocused(i)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                      i === focused ? 'bg-[var(--surface-2)] ring-1 ring-[var(--accent)]/30' : 'hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                      <span className="text-[13px] font-medium text-[var(--text)]">{s.name}</span>
                    </span>
                    <span className="line-clamp-2 text-[11px] text-[var(--text-muted)]">
                      {s.displayName}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}

        {error ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!query.trim() || loading}>
            {loading ? 'Searching…' : 'Search'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!query.trim()}
            onClick={() => {
              if (query.trim()) {
                onSearch(query.trim(), 'save')
                setQuery('')
                setShowRecent(true)
              }
            }}
          >
            <Icon name="star" className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </form>
    </Card>
  )
}
