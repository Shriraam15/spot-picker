/**
 * The arithmetic behind the joystick.
 *
 * Keeping it out of the component is what makes the walk checkable: the stick
 * is a pointer and a thumb, but this is the part that decides how far the mock
 * moves and which way, and getting it wrong looks like the phone drifting
 * rather than like an arithmetic bug. It has no imports of its own, so the test
 * that covers it can load this file directly.
 */

/**
 * One tick of the walk, in ms.
 *
 * The service publishes the newest target it is handed, four times a second, so
 * the stick steps at that rate and the app hands over a target at that rate:
 * one tick of the walk is one publication.
 */
export const WALK_TICK_MS = 250

/**
 * The share of the stick's travel inside which it reads as centred.
 *
 * Without it a thumb resting a little off the middle would walk the mock on the
 * strength of a rounding error.
 */
export const WALK_DEADZONE = 0.15

/** One step of the walk: how far north and east the mock moves this tick. */
export type WalkStep = {
  northMetres: number
  eastMetres: number
}

/**
 * One step of the walk for a stick pushed to (`x`, `y`).
 *
 * The offsets are fractions of the stick's travel, measured from the centre:
 * +x is east (right on the screen) and +y is south (down), so a phone held
 * normally and a browser window agree on which way is which. Returns null while
 * the thumb sits inside the deadzone — a hold with nothing to walk — and when
 * the pace is zero, which has no step to take.
 *
 * The push is clamped rather than scaled: the corner of the pad walks exactly
 * as fast as the side of it, so pushing diagonally is a direction and not a
 * speed boost. The consequence the stick depends on is that a step is a
 * *distance*, so a held stick walks it again every tick and therefore travels
 * at the pace it is set to.
 */
export function walkStep(
  x: number,
  y: number,
  speedKmh: number,
  tickMs = WALK_TICK_MS,
): WalkStep | null {
  const push = Math.hypot(x, y)
  if (!Number.isFinite(push) || !Number.isFinite(speedKmh) || push < WALK_DEADZONE) return null
  if (x === 0 && y === 0) return null
  const metres = (Math.max(0, speedKmh) / 3.6) * (Math.max(0, tickMs) / 1000) * Math.min(1, push)
  if (metres === 0) return null
  return { northMetres: (-y / push) * metres, eastMetres: (x / push) * metres }
}
