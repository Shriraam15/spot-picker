package com.spotpicker.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.Locale
import org.json.JSONObject

/**
 * Answers the one question the rest of the app cannot answer from the inside:
 * *is Android actually delivering our mock to apps that subscribe to location
 * updates?*
 *
 * Publishing a test location and having it delivered are two different things.
 * A one-shot read ("where am I?") resolves against the last known fix of a
 * provider, so it succeeds even when the subscription path is broken — which is
 * exactly how a mock can be visible in WhatsApp's "send current location" and
 * invisible in "share live location". Live location subscribes; a broken
 * subscription path is invisible until something subscribes.
 *
 * So the probe subscribes to the same providers the mock installs and counts
 * what arrives. It uses the `PendingIntent` form of `requestLocationUpdates`
 * rather than a `LocationListener`, because that is the delivery path a
 * foreground background-service consumer uses and it needs no Looper of its own.
 */
object LocationUpdateProbe {

    const val ACTION_UPDATE = "com.spotpicker.app.action.PROBE_UPDATE"

    /** Longest test the UI can ask for, so a stuck probe cannot run forever. */
    private const val MAX_SECONDS = 20.0

    private val handler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var running = false

    private var subscribed: List<String> = emptyList()
    private val gaps = mutableListOf<Long>()
    private var count = 0
    private var movedMetres = 0.0
    private var lastLocation: Location? = null
    private var lastArrivalMs = 0L
    private var mockFlagged = false
    private var request: PendingIntent? = null

    /** True while a test is in flight, so the UI can disable the button. */
    val isRunning: Boolean get() = running

    /**
     * Subscribes for [seconds] and reports through a `probeResult` event, which
     * the web app renders next to the troubleshooting report.
     *
     * Returns a ready-to-send JSON envelope, so a probe that could not even start
     * is reported the same way as one that started and heard nothing.
     */
    fun start(context: Context, seconds: Double): JSONObject {
        val appContext = context.applicationContext
        val providers = MockLocationController.activeProviders()
        if (providers.isEmpty()) {
            return envelope(
                false,
                "Turn the mock location on first — there is nothing to listen for until " +
                    "Spot Picker has installed its providers.",
            )
        }
        if (running) {
            return envelope(false, "A live-update test is already running.")
        }

        val lm = appContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return envelope(false, "This device has no location service.")

        val window = seconds.coerceIn(3.0, MAX_SECONDS)
        val pending = buildPendingIntent(appContext)

        synchronized(lock) {
            subscribed = emptyList()
            gaps.clear()
            count = 0
            movedMetres = 0.0
            lastLocation = null
            lastArrivalMs = 0L
            mockFlagged = false
        }

        val accepted = mutableListOf<String>()
        for (provider in providers) {
            val ok = runCatching {
                // minTime 0 asks for every fix the provider produces, which for a
                // test provider is every one we publish. A minimum distance would
                // hide the very thing being measured.
                lm.requestLocationUpdates(provider, 0L, 0f, pending)
                true
            }.getOrDefault(false)
            if (ok) accepted += provider
        }

        if (accepted.isEmpty()) {
            return envelope(
                false,
                "Android refused every location subscription (${providers.joinToString(", ")}). " +
                    "Reinstall or update the app, then try again.",
            )
        }

        synchronized(lock) {
            subscribed = accepted
            running = true
        }
        request = pending

        handler.postDelayed({ finish(lm, window) }, (window * 1000.0).toLong())
        return envelope(true, null)
    }

    /** Called by [ProbeReceiver] for each broadcast the system delivers. */
    fun onUpdate(location: Location) {
        synchronized(lock) {
            if (!running) return
            val now = SystemClock.elapsedRealtime()
            if (lastArrivalMs != 0L) gaps += now - lastArrivalMs
            lastArrivalMs = now
            count += 1
            val previous = lastLocation
            if (previous != null) {
                val moved = previous.distanceTo(location).toDouble()
                if (moved > movedMetres) movedMetres = moved
            }
            lastLocation = location
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                mockFlagged = mockFlagged || location.isMock
            } else {
                @Suppress("DEPRECATION")
                mockFlagged = mockFlagged || location.isFromMockProvider
            }
        }
    }

    /**
     * Drops the subscription without reporting. Used when the activity is torn
     * down: there is no page left to render a result, and leaving a registration
     * behind would let a dead test keep waking the process up.
     */
    fun abort(context: Context) {
        val lm = context.applicationContext
            .getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        finish(lm, 0.0, report = false)
    }

    private fun finish(lm: LocationManager, window: Double, report: Boolean = true) {
        val pending = request
        if (pending != null) runCatching { lm.removeUpdates(pending) }
        request = null

        val updates: Int
        val providers: List<String>
        val moved: Double
        val worstGap: Long
        val flagged: Boolean
        synchronized(lock) {
            if (!running) return
            running = false
            updates = count
            providers = subscribed
            moved = movedMetres
            worstGap = gaps.maxOrNull() ?: 0L
            flagged = mockFlagged
        }

        if (!report) return

        val text = if (updates == 0) {
            "No location updates arrived in ${window.toInt()} s even though the mock is running. " +
                "Android is not delivering Spot Picker's position to apps that listen for " +
                "continuous updates, which is what WhatsApp's live location does. Check that " +
                "Location is switched on and set to high accuracy, and that Google location " +
                "accuracy (Wi-Fi and Bluetooth scanning) has not replaced Spot Picker as the " +
                "mock location app."
        } else {
            val movement = if (moved > 0.5) {
                String.format(Locale.US, "the position moved %.1f m between fixes", moved)
            } else {
                "the position did not move between fixes"
            }
            val timing = if (worstGap > 0) "longest gap ${worstGap} ms" else "first fix immediately"
            "$updates update(s) in ${window.toInt()} s from ${providers.joinToString(", ")}; " +
                "$movement; $timing" +
                if (flagged) "." else " (not flagged as a mock fix)."
        }

        val payload = JSONObject().apply {
            put("type", "probeResult")
            put("ok", updates > 0)
            put("seconds", window)
            put("updates", updates)
            put("providers", providers.joinToString(", "))
            put("movedMetres", moved)
            put("worstGapMs", worstGap)
            put("mockFlagged", flagged)
            put("message", text)
        }
        MockLocationService.emitToWeb(payload.toString())
    }

    private fun buildPendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, ProbeReceiver::class.java).setAction(ACTION_UPDATE)
        // Mutable is required: the location service attaches the fix as an extra
        // on its way out, and an immutable PendingIntent cannot be filled in.
        // The receiver is unexported, so nothing outside the system can send it.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }

    private fun envelope(ok: Boolean, error: String?): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("error", error ?: JSONObject.NULL)
    }
}
