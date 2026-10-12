import { useCallback, useEffect, useRef, useState } from 'react'
import { ROUTE_MODES } from '@/lib/types'
import { WALK_TICK_MS, walkStep } from '@/lib/walk'
import { formatDistance } from '@/lib/route'
import { tap } from '@/lib/haptics'
import { Icon } from './ui'

/**
 * A draggable joystick that walks the mocked position.
 *
 * The nudge pads step the pin a fixed distance at a time; this is a rate
 * control instead. The thumb is held away from the centre and the mock keeps
 * walking that way, one step per tick, at the pace picked below and scaled by
 * how far the stick is pushed. Letting go hands the position back to the route,
 * which kept advancing underneath the whole time.
 *
 * The walk is stepped from here rather than handed to the service as a second
 * route because the service publishes the newest target it is given: a stream
 * of targets that accumulate is what makes the dot travel in any direction
 * instead of jumping to a point.
 */
type Props = {
  /** The stick is inert unless the mock location is actually publishing. */
  disabled: boolean
  /** The speed the route is planned at, which seeds the stick's own pace. */
  defaultSpeedKmh: number
  /** One step of the walk: metres north/east to move the mock right now. */
  onWalk: (northMetres: number, eastMetres: number) => void
  /** The finger left the stick. */
  onRelease: () => void
}

/** Distance from the centre, in pad pixels, at which the stick is fully pushed. */
const FULL_PX = 42

/** The four travel modes double as paces, so the stick speaks the app's language. */
const PACES = ROUTE_MODES

/** The pace nearest a planned speed, so a driving route does not start at a stroll. */
function nearestPaceKmh(speedKmh: number): number {
  return PACES.reduce(
    (best, mode) =>
      Math.abs(mode.defaultSpeedKmh - speedKmh) < Math.abs(best - speedKmh)
        ? mode.defaultSpeedKmh
        : best,
    PACES[0].defaultSpeedKmh,
  )
}

export default function Joystick({ disabled, defaultSpeedKmh, onWalk, onRelease }: Props) {
  const [pace, setPace] = useState(() => nearestPaceKmh(defaultSpeedKmh))
  const [thumb, setThumb] = useState({ x: 0, y: 0 })
  const [held, setHeld] = useState(false)
  const [walked, setWalked] = useState(0)

  const padRef = useRef<HTMLDivElement | null>(null)
  /** The step the next tick sends, or null while the thumb sits in the deadzone. */
  const stepRef = useRef<{ northMetres: number; eastMetres: number } | null>(null)
  /** True once a step has been sent, so a deadzone tap has nothing to hand back. */
  const steered = useRef(false)
  const timerRef = useRef<number | null>(null)

  // The walk loop outlives renders, so it reads the newest callback and pace
  // from refs rather than being rebuilt every time either of them changes.
  const walkRef = useRef(onWalk)
  const paceRef = useRef(pace)
  useEffect(() => {
    walkRef.current = onWalk
  }, [onWalk])
  useEffect(() => {
    paceRef.current = pace
  }, [pace])

  /** Aims the stick from a pointer position: direction, and how hard it is pushed. */
  const aim = useCallback((clientX: number, clientY: number) => {
    const rect = padRef.current?.getBoundingClientRect()
    if (!rect) return
    const dx = clientX - (rect.left + rect.width / 2)
    const dy = clientY - (rect.top + rect.height / 2)
    const distance = Math.hypot(dx, dy)
    if (distance === 0) return
    stepRef.current = walkStep(dx / FULL_PX, dy / FULL_PX, paceRef.current)
    // The thumb cannot leave the pad, so it is clamped to the ringed radius.
    const shown = Math.min(distance, FULL_PX)
    setThumb({ x: (dx / distance) * shown, y: (dy / distance) * shown })
  }, [])

  /** Sends one step of the walk, if the stick is pushed out of the deadzone. */
  const step = useCallback(() => {
    const next = stepRef.current
    if (!next) return
    steered.current = true
    walkRef.current(next.northMetres, next.eastMetres)
    setWalked((prev) => prev + Math.hypot(next.northMetres, next.eastMetres))
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** The finger left the stick: spring back, and hand the position to the route. */
  const release = useCallback(() => {
    stopTimer()
    stepRef.current = null
    setHeld(false)
    setThumb({ x: 0, y: 0 })
    setWalked(0)
    if (steered.current) {
      steered.current = false
      onRelease()
    }
  }, [onRelease, stopTimer])

  const start = useCallback(
    (clientX: number, clientY: number) => {
      if (disabled) return
      setHeld(true)
      setWalked(0)
      tap(8)
      aim(clientX, clientY)
      // The first step lands at once, so the mock answers the touch rather than
      // waiting a tick before it moves.
      step()
    },
    [aim, disabled, step],
  )

  // A stick that goes inert mid-hold — the mock stopped — stops walking on the
  // spot. The loop and the thumb are both driven off this rather than off the
  // finger, so nothing has to be undone from inside an effect.
  const walking = held && !disabled

  // The walk itself: one step per tick for as long as the stick is walking.
  useEffect(() => {
    if (!walking) return
    timerRef.current = window.setInterval(step, WALK_TICK_MS)
    return stopTimer
  }, [step, stopTimer, walking])

  /** Arrow keys walk too, so the stick is usable without a pointer. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const metres = (pace / 3.6) * (WALK_TICK_MS / 1000)
      const vectors: Record<string, [number, number]> = {
        ArrowUp: [metres, 0],
        ArrowDown: [-metres, 0],
        ArrowLeft: [0, -metres],
        ArrowRight: [0, metres],
      }
      const vector = vectors[event.key]
      if (!vector) return
      event.preventDefault()
      const [north, east] = vector
      stepRef.current = { northMetres: north, eastMetres: east }
      setThumb({ x: (east / metres) * FULL_PX, y: (-north / metres) * FULL_PX })
      setHeld(true)
      step()
    },
    [disabled, pace, step],
  )

  const onKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!event.key.startsWith('Arrow')) return
      release()
    },
    [release],
  )

  const push = walking ? Math.min(1, Math.hypot(thumb.x, thumb.y) / FULL_PX) : 0
  const grip = walking ? thumb : { x: 0, y: 0 }

  return (
    <div className="flex flex-col items-center gap-2">
      {/* pace: the speed the mock walks while the stick is held */}
      <div className="flex w-full gap-1">
        {PACES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            onClick={() => {
              setPace(mode.defaultSpeedKmh)
              tap(5)
            }}
            aria-pressed={pace === mode.defaultSpeedKmh}
            aria-label={`Walk at ${mode.defaultSpeedKmh} km/h — ${mode.label}`}
            className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1 text-[10px] font-medium transition-all active:scale-95 ${
              pace === mode.defaultSpeedKmh
                ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                : 'bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <Icon name={mode.icon} className="h-3 w-3" />
            {mode.defaultSpeedKmh}
          </button>
        ))}
      </div>

      {/* the stick */}
      <div
        ref={padRef}
        role="application"
        tabIndex={0}
        aria-label="Walk the mock position: drag the stick, or hold an arrow key"
        aria-disabled={disabled}
        onPointerDown={(event) => {
          // Capture keeps the walk following the finger even when it leaves the
          // pad, but a pointer that is already gone cannot be captured — the
          // drag still works, it just stops at the edge.
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* no capture: the stick still walks while the pointer is over it */
          }
          start(event.clientX, event.clientY)
        }}
        onPointerMove={(event) => {
          if (!held || disabled) return
          aim(event.clientX, event.clientY)
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(event) => event.preventDefault()}
        title="Drag the stick to walk the mock position"
        className={`relative grid h-32 w-32 touch-none place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] select-none ${
          disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'
        }`}
      >
        {/* the rings: the pad's edge, and how far the stick travels when pushed */}
        <span className="pointer-events-none absolute inset-3 rounded-full border border-dashed border-[var(--border)]" />
        <span className="pointer-events-none absolute inset-[22px] rounded-full border border-[var(--border)]" />
        <span className="pointer-events-none absolute h-1 w-1 rounded-full bg-[var(--text-subtle)]" />

        {/* where the walk is heading, and how hard it is pushing */}
        <span
          className="pointer-events-none absolute inset-0 z-0 grid place-items-center"
          style={{ opacity: push > 0 ? 1 : 0 }}
        >
          <span
            className="h-0.5 origin-left rounded-full bg-[var(--accent)]/50"
            style={{
              width: `${push * FULL_PX}px`,
              transform: `rotate(${Math.atan2(grip.y, grip.x)}rad)`,
            }}
          />
        </span>

        {/* the thumb: dead centre when untouched, clamped inside the pad when pushed */}
        <span
          data-testid="joystick-thumb"
          className={`pointer-events-none absolute z-10 grid h-11 w-11 place-items-center rounded-full border shadow-md ${
            walking
              ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]'
              : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)]'
          }`}
          style={{
            transform: `translate(${grip.x}px, ${grip.y}px)`,
            transitionDuration: walking ? '75ms' : '180ms',
          }}
        >
          {/* The grip the finger goes for, and the one thing the pad needs to
              say: the numbers are on the pace row above it. */}
          {walking ? (
            <Icon name="pulse" className="h-4 w-4" />
          ) : (
            <span className="text-[10px] font-medium">drag</span>
          )}
        </span>
      </div>

      {/* How far this hold has walked, but only while it is walking: the dock is
          short, and a line that is always there would push the map aside. */}
      {walking ? (
        <p className="text-center text-[10px] leading-relaxed text-[var(--text-muted)]">
          Walking {formatDistance(walked)} at {pace} km/h
          {push < 1 ? ' — push further for the full pace' : ''}
        </p>
      ) : null}
    </div>
  )
}
