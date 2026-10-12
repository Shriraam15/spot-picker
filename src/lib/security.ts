/**
 * Security module for Spot Picker.
 *
 * Adds a lock to the app so a phone in someone else's hands can't immediately
 * use mock location or open saved spots.
 *
 * How it works (web-friendly, no native SDK needed):
 *  - On first setup the user creates a passphrase. It is derived into a key
 *    with `crypto.subtle` (PBKDF2); a probe ciphertext wrapped with that key
 *    is stored, so the passphrase itself is never persisted in plain text.
 *  - On later loads the user unlocks with the same passphrase (or a platform
 *    biometric where available). A successful unlock keeps a session token in
 *    memory only, so a reload requires the passphrase again.
 *  - Browsers without WebCrypto fall back to a salted iterated hash of the
 *    passphrase, which is weaker but still stops casual access.
 */

import {
  getFingerprintStatus,
  onNativeEvent,
  readFingerprintResult,
  requestFingerprint,
  type FingerprintStatus,
} from './native'

const KEY_PREFIX = 'spotpicker_security_v1'
/** Device credential id enrolled by the fingerprint/face unlock, base64. */
const BIOMETRIC_KEY = `${KEY_PREFIX}.biometric-credential`
const PROBE_TEXT = 'credentials'
const PBKDF2_ITERATIONS = 120_000
const HASH_ITERATIONS = 500_000

/** Persisted lock settings: passphrase salt + wrapped probe ciphertext. */
interface LockSettings {
  salt: string
  wrapped: string
  createdAt: number
}

function readKey<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(name)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeKey(name: string, value: unknown): void {
  try {
    localStorage.setItem(name, JSON.stringify(value))
  } catch {
    /* storage full or disabled — the app still works in-memory */
  }
}

function deleteKey(name: string): void {
  try {
    localStorage.removeItem(name)
  } catch {
    /* ignore */
  }
}

/** Encode bytes as base64 without spread/apply (safe for large buffers). */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Decode base64 written by `toBase64`. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The in-memory session slot. The token never touches localStorage. */
function sessionSlot(): { __spotpicker_session?: string } {
  return window as unknown as { __spotpicker_session?: string }
}

/** Salted iterated hash used when WebCrypto key derivation is unavailable. */
async function hashPassphrase(passphrase: string, salt: Uint8Array): Promise<string> {
  let deriv: Uint8Array = salt
  for (let i = 0; i < HASH_ITERATIONS; i += 1) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(passphrase + '.' + Array.from(deriv).join('')),
    )
    deriv = new Uint8Array(digest)
  }
  return Array.from(deriv)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Derive the key for `passphrase` and prove it by decrypting the stored
 * probe (iv || ciphertext). Returns null when the passphrase is wrong or
 * the stored data is malformed.
 */
async function unwrapKey(passphrase: string, saltB64: string, wrappedB64: string): Promise<CryptoKey | null> {
  try {
    const salt = fromBase64(saltB64)
    const wrapped = fromBase64(wrappedB64)
    const iv = wrapped.slice(0, 12)
    const ciphertext = wrapped.slice(12)
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    const derived = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derived, ciphertext)
    return new TextDecoder().decode(plain) === PROBE_TEXT ? derived : null
  } catch {
    // Wrong passphrase (GCM auth failure) or malformed stored data.
    return null
  }
}

let secureStore: 'webcrypto' | 'fallback' | null = null

/** Initialize the security store. Must be called once before any other call. */
async function initStore(): Promise<void> {
  if (secureStore !== null) return
  const hasWebCrypto = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
  if (!hasWebCrypto) {
    secureStore = 'fallback'
    return
  }
  // Test that AES-GCM derivation works
  try {
    void crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    secureStore = 'webcrypto'
  } catch {
    secureStore = 'fallback'
  }
}

/**
 * Create a new lock: generate a random salt, derive a key from the
 * passphrase, and store a probe ciphertext so later unlocks can verify
 * the passphrase.
 *
 * @param passphrase  The user's chosen passphrase.
 * @returns The lock settings that were persisted.
 */
export async function setupSecurity(passphrase: string): Promise<LockSettings> {
  await initStore()
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derived, new TextEncoder().encode(PROBE_TEXT)),
  )
  // Store iv || ciphertext so unwrapKey can decrypt without a separate field.
  const wrapped = new Uint8Array(iv.length + ciphertext.length)
  wrapped.set(iv, 0)
  wrapped.set(ciphertext, iv.length)
  const settings: LockSettings = {
    salt: toBase64(salt),
    wrapped: toBase64(wrapped),
    createdAt: Date.now(),
  }
  writeKey(`${KEY_PREFIX}.settings`, settings)
  return settings
}

/**
 * Unlock the app with a passphrase (or, on WebCrypto-less browsers, verify
 * the salted passphrase hash stored at first run).
 *
 * @returns True once unlocked.
 */
export async function unlockSecurity(passphrase: string): Promise<boolean> {
  await initStore()
  const settings = readKey<LockSettings | null>(`${KEY_PREFIX}.settings`, null)

  if (!settings) {
    // First run on a WebCrypto-less browser: remember a salted hash so the
    // next attempt can verify the passphrase.
    if (secureStore === 'fallback') {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const hash = await hashPassphrase(passphrase, salt)
      writeKey(`${KEY_PREFIX}.settings`, {
        salt: toBase64(salt),
        wrapped: hash,
        createdAt: Date.now(),
      } satisfies LockSettings)
    }
    return false
  }

  if (!settings.wrapped) return false

  if (secureStore === 'fallback') {
    const hash = await hashPassphrase(passphrase, fromBase64(settings.salt))
    if (hash === settings.wrapped) {
      markUnlocked('fallback')
      return true
    }
    return false
  }

  const key = await unwrapKey(passphrase, settings.salt, settings.wrapped)
  if (!key) return false

  // Key verified — mint a session token in memory only (never persisted).
  const token = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: crypto.getRandomValues(new Uint8Array(12)) },
    key,
    new TextEncoder().encode('session-token'),
  )
  markUnlocked(toBase64(new Uint8Array(token)))
  return true
}

/** True once a passphrase has been set up on this device. */
export function hasSecuritySetup(): boolean {
  return readKey<LockSettings | null>(`${KEY_PREFIX}.settings`, null) !== null
}

/**
 * Check whether the device has a platform authenticator that can actually
 * verify a user (fingerprint, face, Windows Hello, device PIN).
 *
 * Async on purpose: the capability check itself is async, and a browser can
 * expose the WebAuthn API while having no enrolled biometric at all. Showing
 * a fingerprint button that can never succeed is exactly how "fingerprint is
 * not working" happens — so we only offer it when the OS says it exists.
 * Android WebView has no platform authenticator, where this resolves false
 * and the passphrase stays the only way in, which is safe everywhere.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const pk = (
    window as unknown as {
      PublicKeyCredential?: {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>
      }
    }
  ).PublicKeyCredential
  if (!pk?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  try {
    return await pk.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * Attempt a biometric prompt. Returns true only when the platform
 * authenticator confirms a real user verification (fingerprint, face, or
 * device PIN); false on cancel, missing hardware, or any WebAuthn failure —
 * the passphrase always remains a working way in.
 *
 * This is a proper two-step WebAuthn flow:
 *  - the first run *registers* a device credential, which the OS gates behind
 *    the same biometric/PIN prompt because userVerification is required;
 *  - later runs *assert* against the stored credential id.
 * (The previous implementation called `PublicKeyCredential.get`, a static
 * method that does not exist — the API is `navigator.credentials.get` — so it
 * always failed before showing a prompt. That is fixed here.)
 */
export async function promptBiometric(): Promise<boolean> {
  await initStore()
  if (typeof window === 'undefined') return false
  const cp = window.navigator?.credentials
  if (!cp?.get || !cp.create) return false
  if (!(await isBiometricAvailable())) return false

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const rpId = location.hostname
  const storedId = readKey<string | null>(BIOMETRIC_KEY, null)

  // 1. Assert against the credential enrolled on a previous visit.
  if (storedId) {
    try {
      const assertion = await cp.get({
        publicKey: {
          challenge,
          rpId,
          timeout: 30_000,
          userVerification: 'required',
          allowCredentials: [{ id: fromBase64(storedId), type: 'public-key' }],
        },
      })
      if (assertion) return true
    } catch {
      // Stale or revoked credential (InvalidStateError), or a cancelled
      // prompt — fall through to re-enrol instead of locking the user out.
    }
  }

  // 2. First run (or re-enrol): creating a platform credential with
  //    userVerification: 'required' forces the OS biometric/PIN sheet, so a
  //    success here is a genuine user verification we can trust.
  try {
    const credential = await cp.create({
      publicKey: {
        challenge,
        rp: { id: rpId, name: 'Spot Picker' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'spotpicker-owner',
          displayName: 'This device',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 30_000,
        attestation: 'none',
      },
    })
    if (!(credential instanceof PublicKeyCredential)) return false
    writeKey(BIOMETRIC_KEY, toBase64(new Uint8Array(credential.rawId)))
    return true
  } catch {
    // NotAllowedError = cancelled or no platform authenticator in this
    // context. Either way the passphrase path still works.
    return false
  }
}

/**
 * Check if the user is currently unlocked. The session token lives in
 * memory for the lifetime of the page only.
 */
export function isUnlocked(): boolean {
  return Boolean(sessionSlot().__spotpicker_session)
}

/**
 * Records a successful unlock. The token lives in memory only, so a reload —
 * or the app being sent to the background and re-locked by the native side —
 * asks for the fingerprint again.
 */
function markUnlocked(method: string): void {
  sessionSlot().__spotpicker_session = `${method}-${Math.random().toString(36).slice(2)}`
}

/**
 * What this phone's fingerprint sensor can do, as answered by the Android
 * wrapper. On the web this reports unavailable, because a browser page cannot
 * reach the device's biometric sheet.
 */
export function fingerprintStatus(): FingerprintStatus {
  return getFingerprintStatus()
}

/**
 * Waits for the verdict the Android side sends after the system fingerprint
 * sheet closes. Resolves with a failure rather than hanging if the phone never
 * answers, so the lock screen can always show something.
 */
function waitForFingerprintVerdict(
  timeoutMs: number,
): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onNativeEvent((event) => {
      if (event.type !== 'biometricResult') return
      finish(readFingerprintResult(event))
    })
    function finish(verdict: { ok: boolean; error: string | null }) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      off()
      resolve(verdict)
    }
    timer = setTimeout(
      () => finish({ ok: false, error: 'The fingerprint prompt did not answer. Touch the sensor to try again.' }),
      timeoutMs,
    )
  })
}

/**
 * Opens the app with the fingerprint registered on this phone.
 *
 * On the Android app this goes through the wrapper's bridge to Android's own
 * biometric sheet: the system verifies the enrolled fingerprint and reports the
 * verdict back as an event. A WebView cannot do this itself — its WebAuthn
 * implementation has no platform authenticator, which is why the fingerprint
 * button never worked from the web code alone.
 *
 * In a browser the platform WebAuthn prompt is used instead, so the preview
 * still has a biometric path where one exists.
 */
export async function unlockWithFingerprint(
  timeoutMs = 60_000,
): Promise<{ ok: boolean; error: string | null }> {
  if (!getFingerprintStatus().available) {
    // Not the Android app (or nothing enrolled): ask the browser instead.
    const ok = await promptBiometric()
    return ok
      ? { ok: true, error: null }
      : { ok: false, error: 'No fingerprint is available here. Use the passphrase on the browser preview.' }
  }

  const started = requestFingerprint()
  if (!started.ok) {
    return { ok: false, error: started.error ?? 'The fingerprint prompt could not open.' }
  }

  const verdict = await waitForFingerprintVerdict(timeoutMs)
  if (verdict.ok) markUnlocked('fingerprint')
  return verdict
}

/**
 * Lock the app: clear the in-memory session token.
 */
export function lockSecurity(): void {
  const slot = sessionSlot()
  if (slot.__spotpicker_session) {
    delete slot.__spotpicker_session
  }
}

/**
 * Check if the app is locked and needs the unlock screen.
 * Returns true if the lock screen should be shown.
 */
export function checkSecurityState(): { needsUnlock: boolean; locked: boolean } {
  // If the app is unlocked, no lock screen
  if (isUnlocked()) {
    return { needsUnlock: false, locked: false }
  }
  // If locked, show unlock screen
  return { needsUnlock: true, locked: true }
}

/**
 * Clear all security data (reset the lock). This requires the current
 * passphrase to prevent accidental reset by someone else.
 */
export async function resetSecurity(passphrase: string): Promise<boolean> {
  await initStore()
  const settings = readKey<LockSettings | null>(`${KEY_PREFIX}.settings`, null)
  if (!settings) return true // Nothing to reset

  // Verify the passphrase
  const success = await unlockSecurity(passphrase)
  if (success) {
    deleteKey(`${KEY_PREFIX}.settings`)
    return true
  }
  return false
}
