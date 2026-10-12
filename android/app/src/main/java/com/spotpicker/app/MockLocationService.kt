package com.spotpicker.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.util.Locale

/**
 * Foreground service that keeps pushing the selected position to the system.
 *
 * It runs in the foreground with a persistent notification because Android stops
 * background work aggressively, and a mock location that silently stops would be
 * worse than useless — it would leave other apps showing a frozen position.
 *
 * Route playback lives here rather than in the web app for the same reason: the
 * point of simulating movement is to keep it running while you use the app you
 * are testing, and a WebView that is not on screen cannot be trusted to tick.
 *
 * [isRunning] is only set after the system has actually accepted the test
 * provider, and every exit path clears it and tells the web app, so the UI can
 * never be left showing a Stop button for a service that is not publishing.
 */
class MockLocationService : Service() {

    companion object {
        const val ACTION_START = "com.spotpicker.app.action.START"
        const val ACTION_STOP = "com.spotpicker.app.action.STOP"
        const val EXTRA_LAT = "extra_lat"
        const val EXTRA_LON = "extra_lon"
        const val EXTRA_ROUTE = "extra_route"
        const val EXTRA_MODE = "extra_mode"

        private const val CHANNEL_ID = "mock_location"
        private const val NOTIFICATION_ID = 4201
        private const val UPDATE_INTERVAL_MS = 1000L
        private const val PREFS = "mock_service_state"
        private const val PREF_LAT = "last_lat"
        private const val PREF_LON = "last_lon"
        private const val PREF_MODE = "mode"
        private const val PREF_ROUTE = "route"
        private const val PREF_SPEED = "speed"
        private const val PREF_TRAVELLED = "travelled"

        /** How often playback progress is written down, for a later resume. */
        private const val SAVE_INTERVAL_MS = 5000L

        /** Shortest gap between two attempts to rebuild lost providers. */
        private const val HEAL_INTERVAL_MS = 10_000L

        /** Read by the UI so it can show the correct button after a restart. */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** True between "start requested" and "providers installed". */
        @Volatile
        var isStarting: Boolean = false
            private set

        /** The last failure, so the UI can explain a start that did not take. */
        @Volatile
        var lastError: String? = null
            private set

        /** The travel mode the fixes are being dressed up as, for diagnostics. */
        @Volatile
        var mode: MotionMode = MotionMode.STATIONARY
            private set

        /** Receives lifecycle JSON events so the web UI can react. */
        @Volatile
        var listener: ((String) -> Unit)? = null

        // ---- route playback -------------------------------------------------

        /** True while a simulated route is loaded (finished routes stay true). */
        @Volatile
        var routeActive: Boolean = false
            private set

        /** True once the route has played to its end. */
        @Volatile
        var routeFinished: Boolean = false
            private set

        @Volatile
        var routeTravelledMetres: Double = 0.0
            private set

        @Volatile
        var routeTotalMetres: Double = 0.0
            private set

        @Volatile
        var routeSpeedKmh: Double = 0.0
            private set

        /** The last coordinate actually published, for the status endpoint. */
        @Volatile
        var publishedLat: Double? = null
            private set

        @Volatile
        var publishedLon: Double? = null
            private set

        private var routePoints: List<RoutePoint> = emptyList()

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, MODE_PRIVATE)

        fun start(context: Context, lat: Double, lon: Double) {
            clearRoute()
            clearManualPosition()
            mode = MotionMode.STATIONARY
            remember(context, lat, lon)
            startService(context, lat, lon, MotionMode.STATIONARY, route = false)
        }

        /**
         * Loads a route and begins publishing positions along it. Works whether
         * or not a mock is already running: the route is set before the start
         * request, so a running service simply picks it up on the next tick.
         */
        fun startRoute(context: Context, points: List<RoutePoint>, speedKmh: Double, mode: MotionMode) {
            if (points.isEmpty()) return
            Companion.mode = mode
            // A fresh journey starts from its own first point: a joystick still
            // held from the previous run must not carry its last target over.
            clearManualPosition()
            routePoints = points
            routeSpeedKmh = speedKmh
            routeTravelledMetres = 0.0
            routeTotalMetres = MockRoute.totalDistance(points)
            routeFinished = false
            routeActive = true

            // Written down before the service is asked to start, so a service the
            // system tears down and rebuilds later can pick the journey back up
            // instead of freezing on the last fix.
            remember(context, points.first().lat, points.first().lon)
            saveRoute(context, points, speedKmh, 0.0)

            startService(context, points.first().lat, points.first().lon, mode, route = true)
        }

        private fun startService(
            context: Context,
            lat: Double,
            lon: Double,
            mode: MotionMode,
            route: Boolean,
        ) {
            val intent = Intent(context, MockLocationService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_LAT, lat)
                putExtra(EXTRA_LON, lon)
                putExtra(EXTRA_MODE, mode.id)
                putExtra(EXTRA_ROUTE, route)
            }
            isStarting = true
            lastError = null
            // Foreground services must be started via startForegroundService on O+.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Advances the route by [dtSeconds] and returns where to publish, or null
         * when no route is loaded. Emits the completion event exactly once.
         */
        fun routeStep(dtSeconds: Double): RouteSample? {
            val points = routePoints
            if (!routeActive || points.isEmpty()) return null
            if (!routeFinished) {
                routeTravelledMetres += (routeSpeedKmh / 3.6) * dtSeconds.coerceAtLeast(0.0)
                if (routeTravelledMetres >= routeTotalMetres) {
                    routeTravelledMetres = routeTotalMetres
                    routeFinished = true
                    emit("""{"type":"routeFinished"}""")
                }
            }
            return MockRoute.sampleAt(points, routeTravelledMetres)
        }

        /** Records what was published last, so the status endpoint can report it. */
        fun notePublished(lat: Double, lon: Double) {
            publishedLat = lat
            publishedLon = lon
        }

        /**
         * The position the joystick is steering to, which overrides the route
         * while it is set.
         *
         * Kept in the companion because the joystick is driven from a different
         * thread than the service's own ticker: the web app hands over a target
         * roughly four times a second, and the ticker publishes whatever is
         * current. That is what makes the movement continuous instead of a
         * queue of nudges that arrive late.
         */
        @Volatile
        private var manualLat: Double? = null

        @Volatile
        private var manualLon: Double? = null

        /** True while the joystick is steering rather than the route. */
        @Volatile
        var isManual: Boolean = false
            private set

        /**
         * Takes over the published position.
         *
         * Route playback keeps advancing underneath, so releasing the joystick
         * re-joins the journey where it has got to rather than snapping back to
         * where it started — steering is a detour on the journey, not a new one.
         */
        fun setManualPosition(lat: Double, lon: Double) {
            manualLat = lat
            manualLon = lon
            isManual = true
        }

        /** Hands the position back to the route (or the stationary pin). */
        fun clearManualPosition() {
            manualLat = null
            manualLon = null
            isManual = false
        }

        /** Clears the pending-start flag when the start request itself failed. */
        fun cancelStart() {
            isStarting = false
        }

        fun clearRoute() {
            routePoints = emptyList()
            routeActive = false
            routeFinished = false
            routeTravelledMetres = 0.0
            routeTotalMetres = 0.0
            routeSpeedKmh = 0.0
        }

        fun stop(context: Context) {
            // stopService rather than an ACTION_STOP intent: startService throws
            // IllegalStateException on Android 8+ whenever the app is not in the
            // foreground, which is exactly the case when the stop comes from the
            // notification. stopService is always allowed and onDestroy already
            // removes the providers, clears isRunning and reports the new state.
            runCatching { context.stopService(Intent(context, MockLocationService::class.java)) }
            if (!isRunning) {
                // The service was never running, or was already dead. Clear any
                // leftover state anyway so the UI cannot get stuck on Stop.
                isRunning = false
                isStarting = false
                clearRoute()
                forget(context)
                runCatching { MockLocationController.uninstall(context) }
                emit("""{"type":"mockState","running":false}""")
            }
        }

        /** Lets the update probe report through the same channel as the service. */
        fun emitToWeb(payload: String) = emit(payload)

        private fun emit(payload: String) {
            listener?.invoke(payload)
        }

        // ---- what to remember between runs ---------------------------------

        private fun remember(context: Context, lat: Double, lon: Double) {
            runCatching {
                prefs(context).edit()
                    .putString(PREF_LAT, lat.toString())
                    .putString(PREF_LON, lon.toString())
                    .putString(PREF_MODE, mode.id)
                    .apply()
            }
        }

        private fun saveRoute(context: Context, points: List<RoutePoint>, speedKmh: Double, travelled: Double) {
            runCatching {
                val encoded = points.joinToString(";") { "${it.lat},${it.lon}" }
                prefs(context).edit()
                    .putString(PREF_ROUTE, encoded)
                    .putString(PREF_SPEED, speedKmh.toString())
                    .putString(PREF_TRAVELLED, travelled.toString())
                    .apply()
            }
        }

        /** Drops the saved target, so a stop is not undone by a later restart. */
        private fun forget(context: Context) {
            runCatching {
                prefs(context).edit()
                    .remove(PREF_LAT)
                    .remove(PREF_LON)
                    .remove(PREF_ROUTE)
                    .remove(PREF_SPEED)
                    .remove(PREF_TRAVELLED)
                    .apply()
            }
        }

        /** `lat,lon;lat,lon` back into route points; empty when malformed. */
        private fun decodeRoute(raw: String?): List<RoutePoint> {
            if (raw.isNullOrBlank()) return emptyList()
            val out = mutableListOf<RoutePoint>()
            for (chunk in raw.split(';')) {
                val parts = chunk.split(',')
                if (parts.size != 2) continue
                val lat = parts[0].trim().toDoubleOrNull() ?: continue
                val lon = parts[1].trim().toDoubleOrNull() ?: continue
                if (lat.isNaN() || lon.isNaN()) continue
                if (kotlin.math.abs(lat) > 90.0 || kotlin.math.abs(lon) > 180.0) continue
                out += RoutePoint(lat, lon)
            }
            return out
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var lat = 0.0
    private var lon = 0.0
    private var mode = MotionMode.STATIONARY

    /** Clock of the previous tick, so route progress uses real elapsed time. */
    private var lastTickMs = 0L

    /** When playback progress was last written to [PREF_TRAVELLED]. */
    private var lastSaveMs = 0L

    /** When the providers were last rebuilt after being dropped. */
    private var lastHealMs = 0L

    /** Last speed/heading reported while the joystick was steering. */
    private var manualSpeedMps = 0f

    private var manualBearing = 0f

    private val tick = object : Runnable {
        override fun run() {
            if (!isRunning) return
            val now = SystemClock.elapsedRealtime()
            val dtSeconds = if (lastTickMs == 0L) 0.0 else (now - lastTickMs) / 1000.0
            lastTickMs = now

            val sample = routeStep(dtSeconds)
            if (sample != null) {
                lat = sample.point.lat
                lon = sample.point.lon
            }

            // The joystick takes over while it is held. The route above keeps
            // advancing underneath, so releasing it re-joins the journey where
            // it has actually got to.
            val steerLat = manualLat
            val steerLon = manualLon
            val speedMps: Float
            val bearing: Float
            if (steerLat != null && steerLon != null) {
                val previous = RoutePoint(lat, lon)
                lat = steerLat
                lon = steerLon
                val moved = MockRoute.distanceMetres(previous, RoutePoint(lat, lon))
                // Report the speed and heading of the movement being made, so
                // the fix reads as a person walking rather than a position that
                // quietly teleports every tick.
                if (dtSeconds > 0.0 && moved > 0.05) {
                    manualSpeedMps = (moved / dtSeconds).toFloat()
                    manualBearing = MockRoute.bearingDegrees(previous, RoutePoint(lat, lon))
                }
                speedMps = if (moved > 0.05) manualSpeedMps else 0f
                bearing = manualBearing
            } else if (sample != null) {
                // A finished route is standing still at its last point, whatever
                // speed it was travelling at when it got there.
                speedMps = if (routeFinished) 0f else (routeSpeedKmh / 3.6).toFloat()
                bearing = sample.bearingDegrees.toFloat()
            } else {
                speedMps = 0f
                bearing = 0f
            }

            if (!publishFix(speedMps, bearing)) return
            if (routeActive && now - lastSaveMs >= SAVE_INTERVAL_MS) {
                lastSaveMs = now
                saveRoute(this@MockLocationService, routePoints, routeSpeedKmh, routeTravelledMetres)
            }
            updateNotification()
            handler.postDelayed(this, UPDATE_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything("stop-requested")
                return START_NOT_STICKY
            }

            ACTION_START -> {
                lat = intent.getDoubleExtra(EXTRA_LAT, lat)
                lon = intent.getDoubleExtra(EXTRA_LON, lon)
                // Absent only on an intent from an older build; keep the current
                // mode rather than silently downgrading a simulation to a pin.
                intent.getStringExtra(EXTRA_MODE)?.let { mode = MotionMode.from(it) }
                Companion.mode = mode
                if (!intent.getBooleanExtra(EXTRA_ROUTE, false)) clearRoute()
                remember(this, lat, lon)
            }

            // A null intent means the system restarted us after a low-memory
            // kill or a reboot. Resume what was running rather than dropping the
            // mock silently — this is the difference between reopening the app
            // and finding it still working, and finding it quietly dead.
            null -> if (!resumeRemembered()) {
                lastError = "Service restarted by the system with no saved state to resume."
                stopEverything("nothing-to-resume")
                return START_NOT_STICKY
            }
        }

        createChannel()
        // startForeground must happen within a few seconds of every
        // startForegroundService call — including one that arrives while the
        // service is already running — or the system kills the app with
        // ForegroundServiceDidNotStartInTimeException. It also refreshes the
        // notification, so this is not wasted work on the retarget path.
        val foregroundError = runCatching { startForegroundCompat(buildNotification()) }
            .exceptionOrNull()
        if (foregroundError != null) {
            fail(
                "Android would not let Spot Picker keep running in the background " +
                    "(${foregroundError.javaClass.simpleName}). Open app settings, allow " +
                    "notifications for Spot Picker, then try again.",
                "foreground-refused",
            )
            return START_NOT_STICKY
        }

        // Already publishing? Retarget instead of tearing the providers down and
        // building them again: a nudge or a route should not interrupt the fix
        // that other apps are already reading.
        if (isRunning && MockLocationController.activeProviders().isNotEmpty()) {
            if (!publishFix(0f, 0f)) return START_NOT_STICKY
            isStarting = false
            updateNotification()
            return START_STICKY
        }

        when (val result = MockLocationController.install(this, lat, lon, mode)) {
            is MockLocationController.Result.Ok -> {
                isRunning = true
                isStarting = false
                lastError = null
                notePublished(lat, lon)
                lastTickMs = 0L
                handler.removeCallbacks(tick)
                handler.post(tick)
                emit("""{"type":"mockState","running":true}""")
            }

            is MockLocationController.Result.Failed -> {
                fail(result.reason.message, result.reason.name, result.detail)
            }
        }
        // Restart with a null intent if the system kills us, so the service
        // keeps the mock location alive rather than silently reverting.
        return START_STICKY
    }

    override fun onDestroy() {
        val wasRunning = isRunning
        handler.removeCallbacks(tick)
        lastTickMs = 0L
        isRunning = false
        isStarting = false
        runCatching { MockLocationController.uninstall(this) }
        clearRoute()
        if (wasRunning) emit("""{"type":"mockState","running":false}""")
        super.onDestroy()
    }

    // ---- publishing ---------------------------------------------------------

    /**
     * Publishes the current fix, rebuilding the providers if the system has
     * quietly dropped them.
     *
     * Toggling Location off and on, a reboot, or an aggressive OEM power saver
     * all remove test providers without telling anyone. [MockLocationController]
     * only knows what it installed, not what survived, so the failure to publish
     * is the only reliable signal that they are gone — and rebuilding them is
     * both the check and the cure. A mock that dies here would leave the user
     * with an app that says it is publishing while the phone quietly reports the
     * real position, which is precisely the kind of failure that is impossible
     * to diagnose from the outside.
     *
     * Returns false when the mock had to give up, in which case the failure has
     * already been reported and the caller must stop ticking.
     */
    private fun publishFix(speedMps: Float, bearing: Float): Boolean {
        return try {
            MockLocationController.publish(this, lat, lon, mode, speedMps, bearing)
            notePublished(lat, lon)
            true
        } catch (e: Exception) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastHealMs < HEAL_INTERVAL_MS) {
                fail(
                    "Mock location stopped: ${e.javaClass.simpleName}. " +
                        "Check that Spot Picker is still selected under Developer options.",
                    "publish-failed",
                    "$e",
                )
                return false
            }
            lastHealMs = now
            when (val result = MockLocationController.install(this, lat, lon, mode)) {
                is MockLocationController.Result.Ok -> {
                    // install() publishes the first fix itself, so the position
                    // other apps see is already correct; just carry on ticking.
                    lastError = null
                    true
                }

                is MockLocationController.Result.Failed -> {
                    fail(result.reason.message, result.reason.name, result.detail)
                    false
                }
            }
        }
    }

    /**
     * Restores the target, mode and journey saved before a restart. Returns false
     * when there is nothing worth resuming, which is the only case where the
     * service is allowed to give up on a null intent.
     */
    private fun resumeRemembered(): Boolean {
        val saved = runCatching { prefs(this) }.getOrNull() ?: return false
        lat = saved.getString(PREF_LAT, null)?.toDoubleOrNull() ?: return false
        lon = saved.getString(PREF_LON, null)?.toDoubleOrNull() ?: return false
        mode = MotionMode.from(saved.getString(PREF_MODE, null))
        Companion.mode = mode

        val points = decodeRoute(saved.getString(PREF_ROUTE, null))
        if (points.size >= 2) {
            routePoints = points
            routeSpeedKmh = saved.getString(PREF_SPEED, null)?.toDoubleOrNull() ?: 5.0
            routeTotalMetres = MockRoute.totalDistance(points)
            routeTravelledMetres =
                (saved.getString(PREF_TRAVELLED, null)?.toDoubleOrNull() ?: 0.0)
                    .coerceIn(0.0, routeTotalMetres)
            routeFinished = routeTravelledMetres >= routeTotalMetres
            routeActive = true
        }
        return true
    }

    // ---- teardown and reporting --------------------------------------------

    /**
     * Reports a failure and tears everything down, leaving the UI consistent.
     * [detail] is Android's own wording, which the web app adds to the
     * troubleshooting report — the friendly message alone cannot distinguish
     * "not selected" from "this OEM build said no".
     */
    private fun fail(message: String, reason: String, detail: String? = null) {
        lastError = message
        val detailJson = if (detail == null) "null" else quote(detail)
        emit(
            """{"type":"error","message":${quote(message)},"reason":"$reason",""" +
                """"detail":$detailJson}""",
        )
        stopEverything(reason)
    }

    private fun stopEverything(reason: String) {
        handler.removeCallbacks(tick)
        lastTickMs = 0L
        isRunning = false
        isStarting = false
        clearManualPosition()
        runCatching { MockLocationController.uninstall(this) }
        clearRoute()
        forget(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        } else {
            @Suppress("DEPRECATION")
            runCatching { stopForeground(true) }
        }
        // stopSelf triggers onDestroy, which also removes the providers. Emitting
        // here as well is harmless: the web app only ever re-reads the state.
        emit("""{"type":"mockState","running":false}""")
        stopSelf()
    }

    private fun emit(payload: String) = Companion.emit(payload)

    private fun quote(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\""

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // A broadcast rather than a service intent: delivering a service intent
        // to a service that is no longer running would hit the background-start
        // restrictions and throw, leaving the mock location running with no way
        // to stop it.
        val stop = PendingIntent.getBroadcast(
            this,
            1,
            Intent(this, StopReceiver::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(notificationText())
            .setSmallIcon(R.drawable.ic_stat_location)
            .setOngoing(true)
            .setContentIntent(openApp)
            .addAction(Notification.Action.Builder(null, getString(R.string.notification_stop), stop).build())
            .build()
    }

    /** Coordinates while stationary; progress while a route is playing. */
    private fun notificationText(): String {
        if (!routeActive) return String.format(Locale.US, "%s · %.6f, %.6f", mode.id, lat, lon)
        if (routeFinished) return "Route finished — holding the last position"
        val travelledKm = routeTravelledMetres / 1000.0
        val totalKm = routeTotalMetres / 1000.0
        return String.format(
            Locale.US,
            "%s · route %.2f / %.2f km at %.0f km/h",
            mode.id,
            travelledKm,
            totalKm,
            routeSpeedKmh,
        )
    }

    /** Refreshes the coordinate text without rebuilding the channel. */
    private fun updateNotification() {
        runCatching {
            getSystemService(NotificationManager::class.java)
                ?.notify(NOTIFICATION_ID, buildNotification())
        }
    }
}
