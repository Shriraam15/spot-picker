import type { AppStats } from '@/lib/stats'
import { Card, CardHeader } from './ui'

type Props = {
  stats: AppStats
  favoriteCount: number
  recentCount: number
}

function formatKm(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(1)} km`
}

/**
 * A compact dashboard of everything the user has done in the app — the thing
 * that makes a tool feel like it is keeping score with you.
 */
export default function StatsCard({ stats, favoriteCount, recentCount }: Props) {
  const tiles: { label: string; value: string; sub: string }[] = [
    { label: 'Searches', value: String(stats.searches), sub: `${recentCount} recent` },
    { label: 'Saved spots', value: String(favoriteCount), sub: 'on this device' },
    { label: 'Places picked', value: String(stats.jumps), sub: 'map jumps' },
    {
      label: 'Routes simulated',
      value: String(stats.routes),
      sub: formatKm(stats.simulatedMetres),
    },
  ]

  return (
    <Card>
      <CardHeader title="Your activity" hint="Counts from this device" />
      <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
          >
            <p className="text-lg font-semibold tabular-nums text-[var(--text)]">
              {tile.value}
            </p>
            <p className="text-[11px] font-medium text-[var(--text-muted)]">{tile.label}</p>
            <p className="text-[10px] text-[var(--text-subtle)]">{tile.sub}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}
