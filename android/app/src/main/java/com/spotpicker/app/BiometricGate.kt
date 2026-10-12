package com.spotpicker.app

import android.app.Activity
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject

/**
 * The fingerprint gate for the app.
 *
 * Why this exists in Kotlin rather than in the web code: the bundle that ships
 * inside this APK is a WebView page, and a WebView has no platform
 * authenticator. `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`
 * is permanently false there, so the web app's own WebAuthn prompt could never
 * appear — which is exactly why "fingerprint unlock" looked broken. The
 * fingerprint therefore has to be requested on the Android side, through the
 * system biometric sheet, which is the same sheet the phone uses to unlock
 * itself and the same enrolled fingerprints.
 *
 * Only the OS verdict is trusted: [authenticate] reports success when the
 * system says the enrolled biometric matched, and nothing else does.
 */
object BiometricGate {

    /**
     * The biometric class this phone can actually use.
     *
     * BIOMETRIC_STRONG is asked for first because that is the class a
     * fingerprint sensor normally belongs to, and it is what the user means by
     * "the fingerprint registered on my phone". Some sensors are classified
     * Class 2, though, and a device that reports no strong biometric would look
     * like a dead button if STRONG were the only thing offered — so WEAK is the
     * fallback, which still accepts any enrolled fingerprint.
     */
    private fun authenticators(activity: Activity): Int {
        val manager = BiometricManager.from(activity)
        val strong = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        return if (strong == BiometricManager.BIOMETRIC_SUCCESS) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
    }

    /** Human-readable reason for a refusal, in the words of the OS. */
    private fun reasonFor(code: Int): String = when (code) {
        BiometricManager.BIOMETRIC_SUCCESS -> "Fingerprint unlock is ready."
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
            "This phone has no fingerprint sensor."
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
            "The fingerprint sensor is busy or unavailable right now."
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
            "No fingerprint is registered on this phone yet."
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
            "A security update is required before fingerprints can be used."
        BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED ->
            "This phone's fingerprint support cannot be used by Spot Picker."
        BiometricManager.BIOMETRIC_STATUS_UNKNOWN ->
            "The phone could not report its fingerprint status."
        else -> "Fingerprint unlock is not available on this phone."
    }

    /**
     * What the web lock screen is told about this device.
     *
     * `available` is the only field that decides whether the app locks itself
     * behind the fingerprint, so it is deliberately strict: hardware present
     * *and* at least one fingerprint enrolled.
     */
    fun status(activity: Activity): JSONObject {
        val code = BiometricManager.from(activity).canAuthenticate(authenticators(activity))
        val supported = code != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE &&
            code != BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED
        val enrolled = code == BiometricManager.BIOMETRIC_SUCCESS
        return JSONObject().apply {
            put("supported", supported)
            put("enrolled", enrolled)
            put("available", supported && enrolled)
            put("reason", reasonFor(code))
            // Lets the web app describe the phone accurately without asking.
            put("sdk", Build.VERSION.SDK_INT)
        }
    }

    /**
     * Shows the system fingerprint sheet and reports the verdict through
     * [onResult]. Must be called on the UI thread.
     *
     * The callback always fires exactly once, including for the cases that
     * cannot open a prompt at all (no enrolled fingerprint, a destroyed
     * activity), because the web app is waiting on that answer and a promise
     * that never settles would leave the lock screen spinning forever.
     */
    fun authenticate(activity: Activity, onResult: (ok: Boolean, error: String?) -> Unit) {
        val allowed = authenticators(activity)
        val code = BiometricManager.from(activity).canAuthenticate(allowed)
        if (code != BiometricManager.BIOMETRIC_SUCCESS) {
            onResult(false, reasonFor(code))
            return
        }

        val fragmentActivity = activity as? FragmentActivity
        if (fragmentActivity == null) {
            onResult(false, "Spot Picker cannot show the fingerprint prompt right now.")
            return
        }

        try {
            val prompt = BiometricPrompt(
                fragmentActivity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        onResult(true, null)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        onResult(false, errString.toString())
                    }

                    override fun onAuthenticationFailed() {
                        // A single non-matching finger. The sheet stays open and
                        // the user can try again, so this is not a final verdict.
                    }
                },
            )
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock Spot Picker")
                    .setSubtitle("Confirm your fingerprint to open the app")
                    .setAllowedAuthenticators(allowed)
                    // Required whenever DEVICE_CREDENTIAL is not among the
                    // allowed authenticators, otherwise build() throws.
                    .setNegativeButtonText("Cancel")
                    // No extra "Confirm" tap after a match: the finger that
                    // opened the sheet is the finger that opens the app.
                    .setConfirmationRequired(false)
                    .build(),
            )
        } catch (e: Exception) {
            onResult(false, "The fingerprint prompt could not open: ${e.javaClass.simpleName}.")
        }
    }
}
