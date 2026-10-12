import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardHeader, Icon, type IconName } from './ui'
import { formatDistance } from '@/lib/route'
import { tap } from '@/lib/haptics'

type Props = {
  /** Moves the selected spot by metres north/east. */
  onNudge: (northMetres: number, eastMetres: number) => void
  /** The pad is inert until there is a spot to move. */
  disabled: boolean
}

/** Step sizes, from "stand exactly there" to "cross the street". */
const STEPS = [5, 25, 100, 500] as const

/** How long a finger must be held before the pad starts repeating. */
const HOLD_DELAY_MS = 320
/** Gap between repeats once it is repeating. */
const REPEAT_MS = 150
/**
 * Repeats are capped: a held finger should feel like a slow walk, not a
 * teleport, and an unbounded repeat can send the pin kilometres away before the
 * user notices what they are holding.
 */
const MAX_REPEATS = 40

type Direction = {
  id: string
  label: string
  north: number
  east: number
  /** A stroke icon for the four compass points. */
  icon?: IconName
  /** A glyph for the diagonals, where a rotated arrow is ambiguous. */
  glyph?: string
}

/** The eight directions plus the middle, in the order they fill a 3×3 grid. */
const PAD: (Direction | 'centre')[] = [
  { id: 'nw', label: 'north-west', north: 1, east: -1, glyph: '↖' },
  { id: 'n', label: 'north', north: 1, east: 0, icon: 'up' },
  { id: 'ne', label: 'north-east', north: 1, east: 1, glyph: '↗' },
  { id: 'w', label: 'west', north: 0, east: -1, icon: 'left' },
  'centre',
  { id: 'e', label: 'east', north: 0, east: 1, icon: 'right' },
  { id: 'sw', label: 'south-west', north: -1, east: -1, glyph: '↙' },
  { id: 's', label: 'south', north: -1, east: 0, icon: 'down' },
  { id: 'se', label: 'south-east', north: -1, east: 1, glyph: '↘' },
]

/**
 * A pad for moving the selected spot a few metres at a time.
 *
 * Tapping the map picks a place to within a tap's accuracy; this is what turns
 * "somewhere on that street" into "that doorway". Holding a direction repeats,
 * so a long move is one gesture, and the total distance moved is reported since
 * the last reset so the user can see exactly how far the pin has travelled.
 */
export default function NudgePad({ onNudge, disabled }: Props) {
  const [step, setStep] = useState<number>(STEPS[1])
  const [moved, setMoved] = useState(0)
  const [holding, setHolding] = useState(false)

  const holdTimer = useRef<number | null>(null)
  const repeatTimer = useRef<number | null>(null)
  const repeats = useRef(0)

  const clearTimers = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (repeatTimer.current !== null) {
      window.clearInterval(repeatTimer.current)
      repeatTimer.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const apply = useCallback(
    (north: number, east: number) => {
      onNudge(north * step, east * step)
      setMoved((prev) => prev + Math.hypot(north * step, east * step))
    },
    [onNudge, step],
  )

  const start = useCallback(
    (north: number, east: number) => {
      if (disabled) return
      clearTimers()
      repeats.current = 0
      setHolding(true)
      apply(north, east)
      tap(6)
      holdTimer.current = window.setTimeout(() => {
        repeatTimer.current = window.setInterval(() => {
          if (repeats.current >= MAX_REPEATS) {
            clearTimers()
            setHolding(false)
            return
          }
          repeats.current += 1
          apply(north, east)
        }, REPEAT_MS)
      }, HOLD_DELAY_MS)
    },
    [apply, clearTimers, disabled],
  )

  const stop = useCallback(() => {
    clearTimers()
    setHolding(false)
  }, [clearTimers])

  return (
    <Card>
      <CardHeader
        title="Fine-tune the spot"
        hint="Tap to step, hold to walk — every press moves the pin, not the map"
        action={
          <button
            type="button"
            onClick={() => setMoved(0)}
            disabled={moved === 0}
            className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
          >
            Reset{moved > 0 ? ` (${formatDistance(moved)})` : ''}
          </button>
        }
      />

      <div className="px-4 pb-4">
        {/* step size */}
        <div className="mb-3 flex gap-1.5">
          {STEPS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setStep(value)
                tap(5)
              }}
              className={`flex-1 rounded-lg py-1.5 text-[11px] font-medium transition-all active:scale-95 ${
                step === value
                  ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                  : 'bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {value} m
            </button>
          ))}
        </div>

        {/* the pad */}
        <div className="grid touch-none grid-cols-3 gap-1.5 select-none">
          {PAD.map((cell, index) =>
            cell === 'centre' ? (
              <div
                key={`centre-${index}`}
                className="grid h-12 place-items-center rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)]"
              >
                <span className="text-[10px] font-semibold tracking-wider text-[var(--text-subtle)] uppercase">
                  {holding ? 'moving' : `${step} m`}
                </span>
              </div>
            ) : (
              <button
                key={cell.id}
                type="button"
                disabled={disabled}
                onPointerDown={() => start(cell.north, cell.east)}
                onPointerUp={stop}
                onPointerLeave={stop}
                onPointerCancel={stop}
                onContextMenu={(event) => event.preventDefault()}
                aria-label={`Move ${cell.label} by ${step} metres`}
                className="grid h-12 place-items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] transition-all active:scale-95 active:bg-[var(--accent-soft)] active:text-[var(--accent)] disabled:opacity-40"
              >
                {cell.icon ? (
                  <Icon name={cell.icon} className="h-4 w-4" />
                ) : (
                  <span className="text-base leading-none">{cell.glyph}</span>
                )}
              </button>
            ),
          )}
        </div>

        <p className="mt-3 text-[11px] text-[var(--text-subtle)]">
          {disabled
            ? 'Pick a spot on the map first — then these buttons move it.'
            : `${formatDistance(moved)} moved since the last reset.`}
        </p>
      </div>
    </Card>
  )
}
