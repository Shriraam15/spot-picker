import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, CardHeader, Icon, Input } from '@/components/ui'
import {
  setupSecurity,
  unlockSecurity,
  promptBiometric,
  isBiometricAvailable,
  fingerprintStatus,
  unlockWithFingerprint,
} from '@/lib/security'
import { isNative, openFingerprintSettings, type FingerprintStatus } from '@/lib/native'

type Props = {
  /** True once a passphrase has been set up on this device (web fallback only). */
  isInitialized: boolean
  /** Called when the user successfully unlocks. */
  onUnlock: () => void
}

/** How long to wait after mount before the phone's fingerprint sheet is shown. */
const AUTO_PROMPT_DELAY_MS = 700

/**
 * The gate that keeps Spot Picker shut.
 *
 * On the Android app the only way in is the fingerprint registered on the
 * phone: the bundle asks the wrapper to open the system biometric sheet, and
 * only the OS can answer yes. There is deliberately no passphrase box in that
 * flow, because a typed secret is exactly what the user asked to stop using.
 *
 * Two honest edge cases keep the app from becoming a brick:
 *  - the phone has a sensor but nothing enrolled: the screen says so and offers
 *    to open Android's fingerprint settings;
 *  - a browser preview has no access to a phone's biometrics at all: there the
 *    WebAuthn prompt is offered when the platform supports it, and the
 *    passphrase stays as the last resort.
 */
export default function LockScreen({ isInitialized, onUnlock }: Props) {
  // Read the phone's fingerprint state during the first render rather than in
  // an effect: it is a plain synchronous bridge call, and deciding late would
  // flash the wrong lock screen for a frame.
  const [fingerprint, setFingerprint] = useState<FingerprintStatus>(() => fingerprintStatus())
  // "Native" and "can use a fingerprint" are two different questions: the app
  // is the Android app either way, while the fingerprint gate also needs one
  // enrolled on the phone.
  const isNativeApp = isNative()
  const fingerprintOnly = fingerprint.available

  const recheck = useCallback(() => setFingerprint(fingerprintStatus()), [])

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--bg)] p-4">
      <div className="absolute inset-0 bg-[var(--bg)]" />

      {fingerprintOnly ? (
        <FingerprintGate onUnlock={onUnlock} />
      ) : isNativeApp ? (
        <EnrolmentGate
          status={fingerprint}
          onRecheck={recheck}
          onUnlock={onUnlock}
          hasPassphrase={isInitialized}
        />
      ) : (
        <WebGate isInitialized={isInitialized} onUnlock={onUnlock} />
      )}
    </div>
  )
}

/**
 * The normal path on the phone: one big fingerprint button, backed by the
 * system biometric sheet. Nothing here can be typed, which is the point.
 */
function FingerprintGate({ onUnlock }: { onUnlock: () => void }) {
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /**
   * True while a fingerprint sheet is up. The sensor is a shared, one-at-a-time
   * resource: a second request while the first is open would either be dropped
   * by Android or stack two sheets, so taps are refused rather than queued.
   */
  const askingRef = useRef(false)
  // Held in a ref so `scan` can stay identity-stable: a changing callback would
  // cancel the automatic prompt below on every re-render.
  const onUnlockRef = useRef(onUnlock)
  useEffect(() => {
    onUnlockRef.current = onUnlock
  }, [onUnlock])

  const scan = useCallback(async () => {
    if (askingRef.current) return
    askingRef.current = true
    setScanning(true)
    setMessage(null)
    const result = await unlockWithFingerprint()
    askingRef.current = false
    setScanning(false)
    if (result.ok) {
      onUnlockRef.current()
      return
    }
    setMessage(result.error ?? 'The fingerprint did not match. Touch the sensor to try again.')
  }, [])

  // Ask for the fingerprint as soon as the lock appears (including when the app
  // re-locks itself after a trip to another app), so opening Spot Picker feels
  // like opening the phone. The timer is armed inside the effect rather than
  // guarded by a "already prompted" flag: React mounts effects twice in
  // development, and a flag set on the first run would swallow the second —
  // which is how an automatic prompt silently never appears.
  useEffect(() => {
    const timer = setTimeout(() => void scan(), AUTO_PROMPT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [scan])

  return (
    <Card className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
      <div className="flex flex-col items-center gap-4 px-5 py-7 text-center">
        <span className="relative grid h-20 w-20 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
          {scanning ? (
            <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)]/25" />
          ) : null}
          <Icon name="fingerprint" className="relative h-10 w-10" />
        </span>

        <div className="space-y-1.5">
          <h2 className="text-base font-semibold tracking-tight text-[var(--text)]">
            Unlock with fingerprint
          </h2>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            Spot Picker opens only with the fingerprint registered on this phone.
            There is no passphrase to type.
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => void scan()}
          disabled={scanning}
        >
          <Icon name="fingerprint" className="mr-1 inline h-3.5 w-3.5" />
          {scanning ? 'Waiting for your fingerprint…' : 'Touch the sensor'}
        </Button>

        {message ? (
          <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            {message}
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-subtle)]">
            The sheet that opens is Android&rsquo;s own fingerprint prompt — the same one
            that unlocks your phone.
          </p>
        )}
      </div>
    </Card>
  )
}

/**
 * The phone has a sensor but no fingerprint registered, so no fingerprint can
 * ever open the app. The screen says exactly that and hands the user the
 * Android screen that fixes it, instead of showing a button that cannot work.
 */
function EnrolmentGate({
  status,
  onRecheck,
  onUnlock,
  hasPassphrase,
}: {
  status: FingerprintStatus
  onRecheck: () => void
  onUnlock: () => void
  hasPassphrase: boolean
}) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassphrase, setShowPassphrase] = useState(false)

  const handlePassphrase = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const ok = await unlockSecurity(passphrase)
      if (ok) onUnlock()
      else setError('Wrong passphrase.')
    } finally {
      setBusy(false)
    }
  }, [passphrase, onUnlock])

  return (
    <Card className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
      <CardHeader
        title="Set up a fingerprint first"
        hint="Spot Picker is opened by your fingerprint, so it needs one registered on this phone."
      />
      <div className="space-y-3 px-4 pb-4">
        <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {status.reason}
        </p>

        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => openFingerprintSettings()}
        >
          <Icon name="fingerprint" className="mr-1 inline h-3.5 w-3.5" />
          Open fingerprint settings
        </Button>

        <Button variant="secondary" size="sm" className="w-full" onClick={onRecheck}>
          <Icon name="clock" className="mr-1 inline h-3.5 w-3.5" />
          I have added one — check again
        </Button>

        {hasPassphrase ? (
          showPassphrase ? (
            <div className="space-y-2 pt-1">
              <Input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Emergency passphrase"
                autoFocus
                maxLength={64}
                className="h-11"
                aria-label="Emergency passphrase"
              />
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => void handlePassphrase()}
                disabled={busy || passphrase.length === 0}
              >
                {busy ? 'Checking…' : 'Unlock with passphrase'}
              </Button>
              {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
              onClick={() => setShowPassphrase(true)}
            >
              Emergency: use the old passphrase instead
            </button>
          )
        ) : null}
      </div>
    </Card>
  )
}

/**
 * A browser preview has no access to the phone's biometric sheet at all, so the
 * platform WebAuthn prompt is offered when the browser supports it and the
 * passphrase remains (the browser is where this app was developed, not where it
 * is used).
 */
function WebGate({ isInitialized, onUnlock }: { isInitialized: boolean; onUnlock: () => void }) {
  const [view, setView] = useState<'unlock' | 'setup'>(isInitialized ? 'unlock' : 'setup')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [biometricAvailable, setBiometricAvailable] = useState(false)

  useEffect(() => {
    let alive = true
    void isBiometricAvailable().then((ok) => {
      if (alive) setBiometricAvailable(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  const handleSetup = useCallback(async () => {
    if (passphrase.length < 6) {
      setError('Passphrase must be at least 6 characters.')
      return
    }
    if (passphrase !== confirm) {
      setError('Passphrases do not match.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await setupSecurity(passphrase)
      setView('unlock')
      setConfirm('')
      await unlockSecurity(passphrase)
      onUnlock()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up security.')
    } finally {
      setLoading(false)
    }
  }, [passphrase, confirm, onUnlock])

  const handleUnlock = useCallback(async () => {
    if (passphrase.length < 6) {
      setError('Please enter your passphrase.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const ok = await unlockSecurity(passphrase)
      if (ok) onUnlock()
      else setError('Wrong passphrase. Try again, or use the reset option below.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock.')
    } finally {
      setLoading(false)
    }
  }, [passphrase, onUnlock])

  const handleBiometric = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const ok = await promptBiometric()
      if (ok) onUnlock()
      else setError("Fingerprint/face didn't match or was cancelled — use your passphrase.")
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to use biometric.')
    } finally {
      setLoading(false)
    }
  }, [onUnlock])

  const canSetup = passphrase.length >= 6 && passphrase === confirm
  const canUnlock = passphrase.length > 0

  return (
    <Card className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
      <CardHeader
        title={view === 'setup' ? 'Set up app lock' : 'Unlock app'}
        hint={
          view === 'setup'
            ? 'Browser preview: set a passphrase to protect this session.'
            : 'Browser preview: this is not the phone. The Android app opens with your fingerprint.'
        }
      />

      <div className="px-4 pb-4">
        {biometricAvailable && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleBiometric()}
            disabled={loading}
            className="mb-3 w-full"
          >
            <Icon name="fingerprint" className="mr-1 inline h-3.5 w-3.5" />
            {loading ? 'Verifying…' : 'Use fingerprint / face'}
          </Button>
        )}

        <div className="space-y-2">
          <Input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={view === 'setup' ? 'Choose a passphrase (min 6 characters)' : 'Enter your passphrase'}
            autoFocus
            maxLength={64}
            className="h-11"
            aria-label={view === 'setup' ? 'Passphrase' : 'Passphrase input'}
          />
          {view === 'setup' && (
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm passphrase"
              maxLength={64}
              className="h-11"
              aria-label="Confirm passphrase"
            />
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}

        <Button
          variant="primary"
          size="sm"
          className="mt-3 w-full"
          onClick={() => void (view === 'setup' ? handleSetup() : handleUnlock())}
          disabled={view === 'setup' ? !canSetup : !canUnlock}
        >
          <Icon name={view === 'setup' ? 'lock' : 'check'} className="mr-1 inline h-3.5 w-3.5" />
          {view === 'setup' ? 'Set passphrase' : 'Unlock app'}
        </Button>

        {view === 'unlock' && isInitialized && (
          <button
            type="button"
            className="mt-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            onClick={() => {
              setPassphrase('')
              setConfirm('')
              setError(null)
              setView('setup')
            }}
          >
            I need to set a new passphrase
          </button>
        )}
      </div>
    </Card>
  )
}
