import { useState, useCallback, useEffect } from 'react'
import { Button, Card, CardHeader, Icon, Input } from '@/components/ui'
import { setupSecurity, unlockSecurity, promptBiometric, isBiometricAvailable } from '@/lib/security'

type Props = {
  /** Whether the app has been initialized by the first user (setup phase). */
  isInitialized: boolean
  /** Called when the user successfully unlocks. */
  onUnlock: () => void
}

export default function LockScreen({
  isInitialized,
  onUnlock,
}: Props) {
  const [view, setView] = useState<'unlock' | 'setup'>(isInitialized ? 'unlock' : 'setup')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  // The platform-authenticator check is async: the button only appears once
  // the OS confirms a fingerprint/face/PIN is actually enrolled, so it can
  // never promise a biometric that cannot succeed.
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
      setHint('Passphrase set. Use it to unlock this app on future visits.')
      setTimeout(() => setHint(null), 4000)
      setView('unlock')
      setPassphrase('')
      setConfirm('')
      // Auto-unlock after setup
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
      if (ok) {
        onUnlock()
      } else {
        setError('Wrong passphrase. Try again, or use the reset option below.')
      }
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
      if (ok) {
        onUnlock()
      } else {
        setError("Fingerprint/face didn't match or was cancelled — use your passphrase.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to use biometric.')
    } finally {
      setLoading(false)
    }
  }, [onUnlock])

  const canSetup = passphrase.length >= 6 && passphrase === confirm
  const canUnlock = passphrase.length > 0

  // A true full-screen overlay: fixed positioning keeps the locked app (and
  // the bottom tab bar) completely hidden and unclickable underneath,
  // regardless of how the flex layout sizes its children.
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--bg)] p-4">
      {/* Backdrop with subtle gradient */}
      <div className="absolute inset-0 bg-[var(--bg)]" />

      <Card className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
        <CardHeader
          title={view === 'setup' ? 'Set up app lock' : 'Unlock app'}
          hint={
            view === 'setup'
              ? 'Protect your spots and mock location settings with a passphrase.'
              : 'Enter your passphrase to use this app.'
          }
          action={
            view === 'setup' ? null : (
              <button
                type="button"
                onClick={() => setView('setup')}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
              >
                <Icon name="lock" className="h-3.5 w-3.5 inline mr-1" />
                Set up lock
              </button>
            )
          }
        />

        <div className="px-4 pb-4">
          {hint && (
            <p className="mb-3 rounded-lg bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success)]">
              {hint}
            </p>
          )}

          {!isInitialized && view === 'setup' && (
            <p className="mb-4 text-xs text-[var(--text-muted)]">
              First time using Spot Picker? Set up a passphrase so no one can
              use your mock location without your permission.
            </p>
          )}

          {/* Biometric button */}
          {biometricAvailable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBiometric}
              disabled={loading}
              className="w-full mb-3"
            >
              <Icon name="fingerprint" className="h-3.5 w-3.5 inline mr-1" />
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
            className="w-full"
            onClick={view === 'setup' ? handleSetup : handleUnlock}
            disabled={!canSetup && !canUnlock}
          >
            <Icon name={view === 'setup' ? 'lock' : 'check'} className="h-3.5 w-3.5 inline mr-1" />
            {view === 'setup' ? 'Set passphrase' : 'Unlock app'}
          </Button>

          {view === 'unlock' && isInitialized && (
            <button
              type="button"
              className="mt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
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
    </div>
  )
}
