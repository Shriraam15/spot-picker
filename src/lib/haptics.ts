/**
 * Short haptic confirmation, used on the actions where a physical tap should
 * feel like it did something: start, stop, drop a pin.
 *
 * `navigator.vibrate` needs the app to hold android.permission.VIBRATE (declared
 * in the manifest, and granted at install). In a browser it is simply absent, so
 * every call is guarded rather than feature-detected at the call site.
 */
export function tap(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* unsupported, or blocked by the platform */
  }
}
