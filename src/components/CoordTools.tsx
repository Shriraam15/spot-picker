import { useState } from 'react'
import type { LatLng } from '@/lib/types'
import { Badge, Button, Card, CardHeader, Icon, Input } from './ui'
import { formatLatLng, formatTrueDms, parseLatLngInput } from '@/lib/format'
import { bearingDegrees, distanceMetres, formatDistance } from '@/lib/route'

type Props = {
  /** The pin on the map — used to prefill and as a measuring point. */
  position: LatLng | null
  onJump: (point: LatLng) => void
}

const COMPASS = (deg: number) => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(deg / 45) % 8]
}

/**
 * The toolbox for people who work with coordinates: convert between decimal
 * degrees and DMS (pasting either form), jump to what you parsed, and measure
 * the distance and bearing between two points.
 */
export default function CoordTools({ position, onJump }: Props) {
  const [convertCustom, setConvertCustom] = useState<string | null>(null)
  const [fromA, setFromA] = useState('')
  const [fromB, setFromB] = useState('')

  // The field follows the pin until the user types their own coordinate —
  // derived at render time, so no effect (and no flicker) involved.
  const convertText =
    convertCustom ?? (position ? formatLatLng(position) : '')

  const parsed = parseLatLngInput(convertText)
  const a = parseLatLngInput(fromA)
  const b = parseLatLngInput(fromB)

  let measure: { metres: number; bearing: number } | null = null
  if (a && b) {
    measure = { metres: distanceMetres(a, b), bearing: bearingDegrees(a, b) }
  }

  return (
    <Card>
      <CardHeader
        title="Coordinate tools"
        hint="Convert formats and measure between two points"
      />

      {/* ---- converter ---- */}
      <div className="space-y-2 px-4 pb-3">
        {position && convertCustom !== null ? (
          <button
            type="button"
            className="text-[11px] text-[var(--accent)] underline-offset-2 hover:underline"
            onClick={() => setConvertCustom(null)}
          >
            Back to the pin
          </button>
        ) : null}
        <Input
          value={convertText}
          onChange={(e) => setConvertCustom(e.target.value)}
          placeholder={'Decimal "12.9716, 77.5946" — or DMS 12°58\'18"N 77°35\'41"E'}
          aria-label="Coordinate to convert"
        />
        {convertText.trim() && !parsed ? (
          <p className="text-[11px] text-[var(--danger)]">
            Could not read that as a coordinate pair.
          </p>
        ) : null}
        {parsed ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] text-[var(--text-muted)]">Decimal</p>
                <p className="truncate font-mono text-[13px] text-[var(--text)]">
                  {formatLatLng(parsed)}
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">DMS</p>
                <p className="truncate font-mono text-[13px] text-[var(--text)]">
                  {formatTrueDms(parsed)}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => onJump(parsed)}>
                <Icon name="locate" className="h-3.5 w-3.5" />
                Jump
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- distance & bearing ---- */}
      <div className="space-y-2 border-t border-[var(--border)] px-4 pt-3 pb-4">
        <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
          Distance &amp; bearing
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={fromA}
            onChange={(e) => setFromA(e.target.value)}
            placeholder="Point A — decimal or DMS"
            aria-label="Point A"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!position}
            onClick={() => position && setFromA(formatLatLng(position))}
            title="Use the pin as point A"
          >
            <Icon name="locate" className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={fromB}
            onChange={(e) => setFromB(e.target.value)}
            placeholder="Point B — decimal or DMS"
            aria-label="Point B"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!position}
            onClick={() => position && setFromB(formatLatLng(position))}
            title="Use the pin as point B"
          >
            <Icon name="locate" className="h-3.5 w-3.5" />
          </Button>
        </div>

        {measure ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{formatDistance(measure.metres)}</Badge>
            <Badge>
              {Math.round(measure.bearing)}° {COMPASS(measure.bearing)}
            </Badge>
            <span className="text-[11px] text-[var(--text-subtle)]">
              A → B, from true north
            </span>
          </div>
        ) : fromA.trim() && fromB.trim() && !(a && b) ? (
          <p className="text-[11px] text-[var(--danger)]">
            Both points need to parse — decimal pair or DMS.
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-subtle)]">
            Paste two points (or drop the pin for one of them) to measure.
          </p>
        )}
      </div>
    </Card>
  )
}
