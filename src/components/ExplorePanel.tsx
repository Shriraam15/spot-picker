import { useEffect, useMemo, useState } from 'react'
import type { LatLng, Place } from '@/lib/types'
import { Badge, Button, Card, CardHeader, Icon, Input } from './ui'
import {
  isWorldLoaded,
  loadAirports,
  loadAllPlaces,
  loadCountries,
  nearbyPlaces,
  type AirportRow,
  type CountryEntry,
} from '@/lib/gazetteer'
import { distanceMetres, formatDistance } from '@/lib/route'

type Props = {
  /** The pin on the map; nearby search centres here. */
  position: LatLng | null
  /** Jump the map to a picked place (same contract as search suggestions). */
  onSelect: (place: Place) => void
}

type Tab = 'places' | 'airports' | 'nearby'

const CONTINENT_ORDER = ['EU', 'AS', 'NA', 'SA', 'AF', 'OC']
const CONTINENT_NAMES: Record<string, string> = {
  AF: 'Africa',
  AS: 'Asia',
  EU: 'Europe',
  NA: 'North America',
  SA: 'South America',
  OC: 'Oceania',
}

function formatPop(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/**
 * Explore the bundled world gazetteer: browse the planet by continent →
 * country → city, find an airport by name or code, or list the places nearest
 * the current pin. Everything here works with no network at all.
 */
export default function ExplorePanel({ position, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>('places')

  // ---- places browser ----
  const [countries, setCountries] = useState<CountryEntry[] | null>(null)
  const [countryError, setCountryError] = useState<string | null>(null)
  const [continent, setContinent] = useState<string | null>(null)
  const [countryQuery, setCountryQuery] = useState('')
  const [activeCountry, setActiveCountry] = useState<CountryEntry | null>(null)

  // ---- airports ----
  const [airports, setAirports] = useState<AirportRow[] | null>(null)
  const [airportQuery, setAirportQuery] = useState('')

  // ---- nearby ----
  const [worldLoading, setWorldLoading] = useState(false)
  const [worldProgress, setWorldProgress] = useState<[number, number]>([0, 27])
  const [worldReady, setWorldReady] = useState(isWorldLoaded())
  const [nearbyNonce, setNearbyNonce] = useState(0)
  const [nearby, setNearby] = useState<Place[] | null>(null)
  const [nearbyBusy, setNearbyBusy] = useState(false)

  useEffect(() => {
    loadCountries()
      .then(setCountries)
      .catch(() => setCountryError('Could not load the country index.'))
  }, [])

  useEffect(() => {
    if (tab !== 'airports' || airports) return
    loadAirports().then(setAirports).catch(() => setAirports([]))
  }, [tab, airports])

  const countryName = useMemo(
    () => new Map((countries ?? []).map((c) => [c.iso, c.name])),
    [countries],
  )

  const visibleCountries = useMemo(() => {
    if (!countries) return []
    const q = countryQuery.trim().toLowerCase()
    return countries.filter((c) => {
      if (continent && c.continent !== continent) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.capital.toLowerCase().includes(q) ||
        c.iso.toLowerCase() === q
      )
    })
  }, [countries, continent, countryQuery])

  const visibleAirports = useMemo(() => {
    if (!airports) return []
    const q = airportQuery.trim().toLowerCase()
    const rows = q
      ? airports.filter(
          (a) => a[0].toLowerCase().includes(q) || a[2].toLowerCase().startsWith(q),
        )
      : airports
    const starts = q
      ? rows.filter((a) => a[0].toLowerCase().startsWith(q) || a[2].toLowerCase().startsWith(q))
      : rows
    return (q ? [...starts, ...rows.filter((a) => !starts.includes(a))] : rows).slice(0, 60)
  }, [airports, airportQuery])

  const runNearby = async () => {
    if (!position) return
    setNearbyBusy(true)
    try {
      if (!isWorldLoaded()) {
        setWorldLoading(true)
        await loadAllPlaces((done, total) => setWorldProgress([done, total]))
        setWorldReady(true) // the effect below performs the first query
      } else {
        setNearbyNonce((n) => n + 1)
      }
    } catch {
      setNearby([])
    } finally {
      setNearbyBusy(false)
      setWorldLoading(false)
    }
  }

  // The nearby list follows the pin: first query once the world is loaded,
  // then instantly re-centred whenever the pin moves.
  useEffect(() => {
    if (!position || !worldReady) return
    let cancelled = false
    void nearbyPlaces(position, 20)
      .then((places) => {
        if (!cancelled) setNearby(places)
      })
      .catch(() => {
        if (!cancelled) setNearby([])
      })
    return () => {
      cancelled = true
    }
  }, [position, worldReady, nearbyNonce])

  const jump = (place: Place) => onSelect(place)

  const tabButton = (id: Tab, label: string, icon: 'globe' | 'search' | 'locate') => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
        tab === id
          ? 'bg-[var(--accent)] text-[var(--accent-text)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
      }`}
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      {label}
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Explore the world"
          hint="236,000+ places bundled offline — no network needed"
        />
        <div className="flex gap-1.5 px-4 pb-3">
          {tabButton('places', 'Countries', 'globe')}
          {tabButton('airports', 'Airports', 'search')}
          {tabButton('nearby', 'Nearby', 'locate')}
        </div>

        {/* ---------- places: continent → country → city ---------- */}
        {tab === 'places' && (
          <div className="px-4 pb-4 space-y-3">
            {countryError ? (
              <p className="text-xs text-[var(--danger)]">{countryError}</p>
            ) : !countries ? (
              <p className="text-xs text-[var(--text-subtle)]">Loading country index…</p>
            ) : activeCountry ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setActiveCountry(null)}>
                    <Icon name="left" className="h-3.5 w-3.5" />
                    Countries
                  </Button>
                  <Badge>{activeCountry.continent in CONTINENT_NAMES ? CONTINENT_NAMES[activeCountry.continent] : activeCountry.continent}</Badge>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--text)]">{activeCountry.name}</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {activeCountry.capital ? `Capital: ${activeCountry.capital}` : 'Top cities by population'}
                  </p>
                </div>
                <ul className="max-h-[24rem] overflow-y-auto divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                  {activeCountry.cities.map((c, i) => (
                    <li key={`${c[0]}-${i}`}>
                      <button
                        type="button"
                        onClick={() =>
                          jump({
                            id: `x-${activeCountry.iso}-${i}`,
                            name: c[0],
                            displayName: [c[0], c[2], activeCountry.name].filter(Boolean).join(', '),
                            lat: c[3],
                            lon: c[4],
                          })
                        }
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-[var(--text)]">
                            {c[0]}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--text-muted)]">
                            {c[2] || activeCountry.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-subtle)]">
                          {formatPop(c[5])}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setContinent(null)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      continent === null
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    All
                  </button>
                  {CONTINENT_ORDER.filter((code) =>
                    countries.some((c) => c.continent === code),
                  ).map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setContinent(code)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        continent === code
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      {CONTINENT_NAMES[code] ?? code}
                    </button>
                  ))}
                </div>
                <Input
                  value={countryQuery}
                  onChange={(e) => setCountryQuery(e.target.value)}
                  placeholder="Filter countries or capitals…"
                  aria-label="Filter countries"
                />
                <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
                  {visibleCountries.length} countries
                </p>
                <ul className="max-h-[22rem] overflow-y-auto grid grid-cols-2 gap-1.5">
                  {visibleCountries.map((c) => (
                    <li key={c.iso}>
                      <button
                        type="button"
                        onClick={() => setActiveCountry(c)}
                        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-2 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <span className="block truncate text-[12px] font-medium text-[var(--text)]">
                          {c.name}
                        </span>
                        <span className="block truncate text-[10px] text-[var(--text-muted)]">
                          {c.capital || `${c.cities.length} cities`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* ---------- airports ---------- */}
        {tab === 'airports' && (
          <div className="px-4 pb-4 space-y-3">
            <Input
              value={airportQuery}
              onChange={(e) => setAirportQuery(e.target.value)}
              placeholder="Airport name or code (e.g. Heathrow, LHR)…"
              aria-label="Filter airports"
            />
            {!airports ? (
              <p className="text-xs text-[var(--text-subtle)]">Loading airports…</p>
            ) : visibleAirports.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No airport matches that.</p>
            ) : (
              <ul className="max-h-[24rem] overflow-y-auto divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                {visibleAirports.map((a, i) => (
                  <li key={`${a[2]}-${a[3]}-${i}`}>
                    <button
                      type="button"
                      onClick={() =>
                        jump({
                          id: `ap-${a[2]}-${a[3]}-${a[4]}`,
                          name: a[0],
                          displayName: [a[2] ? `${a[0]} (${a[2]})` : a[0], countryName.get(a[1]) || a[1]]
                            .filter(Boolean)
                            .join(', '),
                          lat: a[3],
                          lon: a[4],
                        })
                      }
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--text)]">
                          {a[0]}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">
                          {countryName.get(a[1]) || a[1]}
                        </span>
                      </span>
                      {a[2] ? (
                        <span className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                          {a[2]}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[10px] font-semibold text-[var(--text-subtle)]">
                        {a[5] === 'L' ? 'Large' : a[5] === 'M' ? 'Medium' : 'Small'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ---------- nearby ---------- */}
        {tab === 'nearby' && (
          <div className="px-4 pb-4 space-y-3">
            {!position ? (
              <p className="text-xs text-[var(--text-muted)]">
                Drop a pin on the map first — nearby search starts from it.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-[var(--text-muted)]">
                    Centred on {position.lat.toFixed(4)}, {position.lon.toFixed(4)}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void runNearby()}
                    disabled={nearbyBusy || worldLoading}
                  >
                    {nearbyBusy || worldLoading ? 'Loading…' : nearby ? 'Refresh' : 'Find places'}
                  </Button>
                </div>
                {worldLoading && (
                  <div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent)] transition-all"
                        style={{ width: `${Math.round((worldProgress[0] / worldProgress[1]) * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                      Loading world gazetteer… shard {worldProgress[0]}/{worldProgress[1]}
                    </p>
                  </div>
                )}
                {nearby !== null && nearby.length === 0 && !worldLoading && (
                  <p className="text-xs text-[var(--text-muted)]">
                    Nothing within 500 km of this pin.
                  </p>
                )}
                {nearby && nearby.length > 0 && (
                  <ul className="max-h-[24rem] overflow-y-auto divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                    {nearby.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => jump(p)}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-[var(--text)]">
                              {p.name}
                            </span>
                            <span className="block truncate text-[11px] text-[var(--text-muted)]">
                              {p.displayName}
                            </span>
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-[var(--accent)]">
                            {formatDistance(distanceMetres(position, p))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <p className="px-1 text-[10px] leading-relaxed text-[var(--text-subtle)]">
        Place data © GeoNames (CC BY 4.0) · airport data from OurAirports (public domain),
        bundled with the app for offline use.
      </p>
    </div>
  )
}
