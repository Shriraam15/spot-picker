package com.spotpicker.app

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import kotlin.math.cos
import kotlin.math.max
import kotlin.random.Random

/**
 * Installs and removes the Android "test providers" that let a selected app push
 * a fake position to the rest of the system.
 *
 * Adding a test provider is the one operation that is genuinely allowed or
 * refused by the system, so it doubles as the authoritative test for whether the
 * user has picked this app under Developer options > "Select mock location app".
 * Everything else here only reports what actually happened, with a reason.
 */
object MockLocationController {

    /**
     * Every provider a location consumer might subscribe to.
     *
     * `gps` and `network` are the classic pair, and they are what a one-shot
     * "where am I?" read resolves against. `fused` is the platform's own
     * composite provider, and it is the one an app reaches for when it wants a
     * *continuous* stream rather than a single fix — which is exactly the
     * difference between sharing a current location and sharing a live one.
     * Mocking only gps and network lets a live reader fall through to the fused
     * provider and end up with the real position, so it is mocked too.
     *
     * The string is used rather than LocationManager.FUSED_PROVIDER because the
     * constant only exists from API 31 and the mock is meant to keep working
     * below that.
     */
    private val PROVIDERS = listOf(
        LocationManager.GPS_PROVIDER,
        LocationManager.NETWORK_PROVIDER,
        "fused",
    )

    /**
     * The providers that are currently installed, so publishing and removal stay
     * symmetric. A device that rejected one of them still works with the others.
     */
    private val active = LinkedHashSet<String>()

    /**
     * Set once the system has accepted a test provider during this process. The
     * app-op check is a heuristic that some OEM builds report inconsistently, so
     * a confirmed install outranks it.
     */
    @Volatile
    var confirmedBySystem: Boolean = false
        private set

    /** Why an install failed, in words worth showing a user. */
    enum class Failure(val message: String) {
        NOT_SELECTED(
            "Android refused the test location provider because Spot Picker is not the " +
                "selected mock location app. Open Settings > System > Developer options > " +
                "Select mock location app and choose Spot Picker.",
        ),
        NO_PERMISSION("Spot Picker still needs the location permission. Tap Grant in Setup."),
        PROVIDER_UNAVAILABLE("Android rejected the test location provider on this device."),
        UNKNOWN("Android refused to start the mock location."),
    }

    /**
     * The system's own description of the last failure. The friendly [Failure]
     * message tells a user what to do; this string is what Android actually said,
     * and it is the only way to tell two causes apart from a report sent off a
     * phone. Cleared as soon as an install succeeds.
     */
    @Volatile
    var lastFailureDetail: String? = null
        private set

    sealed interface Result {
        data object Ok : Result

        data class Failed(val reason: Failure, val detail: String) : Result
    }

    // ---- the GPS wander -----------------------------------------------------

    /**
     * The current offset from the selected point, in metres north and east. A
     * random *walk* rather than fresh noise each tick: consecutive fixes then
     * drift a little instead of teleporting around a disc, which is what a real
     * receiver looks like and what smoothing in a consumer app expects.
     */
    private var wanderNorth = 0.0
    private var wanderEast = 0.0

    /** Guards the walk. Its own lock, so wandering never waits on an install. */
    private val wanderLock = Any()

    /** Clears the accumulated wander, e.g. when a new spot is selected. */
    fun resetWander() {
        synchronized(wanderLock) {
            wanderNorth = 0.0
            wanderEast = 0.0
        }
    }

    /**
     * One step of the random walk, clamped to a disc of the mode's wander radius
     * so a long-running session cannot drift away from the selected spot.
     */
    private fun wanderStep(mode: MotionMode): Pair<Double, Double> {
        val radius = mode.wanderMetres
        if (radius <= 0.0) return 0.0 to 0.0
        synchronized(wanderLock) {
            // Two uniforms summed gives a triangular step, which is closer to the
            // bell-shaped error of a real fix than a linear one.
            val step = radius / 2.0
            wanderNorth += (Random.nextDouble() - Random.nextDouble()) * step
            wanderEast += (Random.nextDouble() - Random.nextDouble()) * step
            val distance = kotlin.math.hypot(wanderNorth, wanderEast)
            if (distance > radius) {
                // Reflect back inside the disc instead of clamping to the edge:
                // clamping would park the walk on the rim and publish a ring of
                // identical points, which is the very thing being avoided.
                wanderNorth = -wanderNorth * radius / distance
                wanderEast = -wanderEast * radius / distance
            }
            return wanderNorth to wanderEast
        }
    }

    private fun locationManager(context: Context): LocationManager =
        context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    private fun hasFineLocation(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * True when the user has selected this app as the device's mock location app.
     * Checked through the mock-location app-op rather than the permission, because
     * Android grants the app-op at selection time. This is only a hint for the
     * setup checklist: [install] is what actually proves it.
     */
    fun isMockAppSelected(context: Context): Boolean {
        if (confirmedBySystem) return true
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            ?: return false
        val uid = Process.myUid()
        val pkg = context.packageName
        return try {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, uid, pkg)
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, uid, pkg)
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (e: Exception) {
            false
        }
    }

    /** The raw mock-location app-op mode, reported in the diagnostics block. */
    fun mockAppOpMode(context: Context): String {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            ?: return "unavailable"
        val uid = Process.myUid()
        val pkg = context.packageName
        return try {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, uid, pkg)
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, uid, pkg)
            }
            when (mode) {
                AppOpsManager.MODE_ALLOWED -> "$mode (allowed)"
                AppOpsManager.MODE_DEFAULT -> "$mode (default = use permission)"
                else -> "$mode"
            }
        } catch (e: Exception) {
            "error: ${e.javaClass.simpleName}"
        }
    }

    /** Provider names that are installed right now. */
    fun activeProviders(): List<String> = synchronized(active) { active.toList() }

    /**
     * True once the user has unlocked Developer options at all. "Select mock
     * location app" is unreachable until they have, so the difference between
     * "not unlocked yet" and "unlocked but not selected" is the difference
     * between two completely different sets of instructions.
     */
    fun developerOptionsEnabled(context: Context): Boolean = try {
        Settings.Global.getInt(
            context.contentResolver,
            Settings.Global.DEVELOPMENT_SETTINGS_ENABLED,
            0,
        ) == 1
    } catch (e: Exception) {
        false
    }

    /**
     * Adds the test providers, switches them on, and publishes the first fix.
     * Returns the reason for any failure rather than throwing, so the caller can
     * always report something specific.
     */
    fun install(context: Context, lat: Double, lon: Double, mode: MotionMode): Result {
        if (!hasFineLocation(context)) return Result.Failed(Failure.NO_PERMISSION, "no ACCESS_FINE_LOCATION")
        val lm = locationManager(context)

        // Re-adding an existing provider throws, so clear any leftovers first.
        uninstall(context)
        resetWander()

        val installed = mutableListOf<String>()
        val rejected = mutableListOf<String>()
        var lastDetail = ""
        for (provider in PROVIDERS) {
            try {
                // The ProviderProperties overload of this method (API 31+) is not
                // usable here: ProviderProperties has a package-private constructor
                // and is final, so apps cannot build one. The 10-argument overload
                // is the one third-party apps are expected to call.
                @Suppress("DEPRECATION")
                lm.addTestProvider(
                    provider,
                    false,  // requiresNetwork
                    false,  // requiresSatellite
                    false,  // requiresCell
                    false,  // hasMonetaryCost
                    true,   // supportsAltitude
                    true,   // supportsSpeed
                    true,   // supportsBearing
                    // Criteria is deprecated but there is no replacement that the
                    // 10-argument addTestProvider overload accepts.
                    android.location.Criteria.POWER_LOW,
                    android.location.Criteria.ACCURACY_FINE,
                )
                lm.setTestProviderEnabled(provider, true)
                installed += provider
                // The first provider to be accepted proves the app-op is granted.
                confirmedBySystem = true
            } catch (e: SecurityException) {
                // The one failure that is never survivable: the app is not the
                // selected mock location app.
                removeAll(lm, installed)
                return failed(Failure.NOT_SELECTED, describe(e))
            } catch (e: Exception) {
                // A device with no GPS hardware, or an OEM build that dislikes one
                // of the providers, fails for that provider only.
                rejected += provider
                lastDetail = describe(e)
            }
        }

        if (installed.isEmpty()) return failed(Failure.PROVIDER_UNAVAILABLE, lastDetail)
        rejections = rejected
        synchronized(active) {
            active.clear()
            active.addAll(installed)
        }

        // Publish once immediately so the first fix lands without waiting a second.
        return try {
            publish(context, lat, lon, mode)
            lastFailureDetail = null
            Result.Ok
        } catch (e: SecurityException) {
            removeAll(lm, installed)
            synchronized(active) { active.clear() }
            failed(Failure.NOT_SELECTED, describe(e))
        } catch (e: Exception) {
            removeAll(lm, installed)
            synchronized(active) { active.clear() }
            failed(Failure.UNKNOWN, describe(e))
        }
    }

    /**
     * Providers the last install could not register. Reported in diagnostics
     * because a device that refuses `fused`, for instance, is fine for one-shot
     * reads and useless for a live stream — a distinction worth being able to
     * see without a cable.
     */
    @Volatile
    var rejections: List<String> = emptyList()
        private set

    private fun failed(reason: Failure, detail: String): Result.Failed {
        lastFailureDetail = detail
        return Result.Failed(reason, detail)
    }

    /** Removes the test providers and restores the real ones. */
    fun uninstall(context: Context) {
        val lm = runCatching { locationManager(context) }.getOrNull() ?: return
        removeAll(lm, activeProviders())
        // Belt and braces: clear the built-in provider names too, in case a crash
        // in an earlier version left one of them installed.
        removeAll(lm, PROVIDERS)
        synchronized(active) { active.clear() }
    }

    /** Every provider the mock knows how to install, for the diagnostics block. */
    fun knownProviders(): List<String> = PROVIDERS

    /**
     * Pushes one position to every installed test provider.
     *
     * The fix is deliberately not a bare coordinate. [mode] supplies a plausible
     * accuracy and adds the wander of a real receiver, and the accuracy fields
     * that a consumer validates before accepting a fix as "live" are filled in:
     * an update with no timestamps is dropped, an update with no movement can be
     * deduplicated, and an update claiming zero error looks synthetic.
     */
    fun publish(
        context: Context,
        lat: Double,
        lon: Double,
        mode: MotionMode,
        speedMps: Float = 0f,
        bearingDegrees: Float = 0f,
    ) {
        val providers = activeProviders()
        if (providers.isEmpty()) throw IllegalStateException("No test provider is installed.")
        val lm = locationManager(context)

        val (offsetNorth, offsetEast) = wanderStep(mode)
        val accuracy = (mode.accuracyMetres * (0.8 + Random.nextDouble() * 0.6)).toFloat()
        // Longitude degrees shrink towards the poles, so scale the offset.
        val lonScale = max(cos(Math.toRadians(lat)), 0.0001)
        val time = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtimeNanos()

        for (provider in providers) {
            val location = Location(provider).apply {
                latitude = lat + offsetNorth / 111_320.0
                longitude = lon + offsetEast / (111_320.0 * lonScale)
                this.accuracy = accuracy
                altitude = 0.0
                verticalAccuracyMeters = accuracy * 1.5f
                // A route in progress supplies real speed and heading, so other
                // apps see believable movement instead of a teleporting dot.
                speed = speedMps
                speedAccuracyMetersPerSecond = SPEED_ACCURACY_MPS
                bearing = bearingDegrees
                bearingAccuracyDegrees = BEARING_ACCURACY_DEGREES
                this.time = time
                // Some apps validate this field, so it must be set explicitly.
                // Both providers must agree on it, so it is sampled once outside
                // this loop: the same instant, not a microsecond apart.
                elapsedRealtimeNanos = elapsed
            }
            lm.setTestProviderLocation(provider, location)
        }
    }

    /** Removes the providers a device refused, so the next install retries them. */
    private fun removeAll(lm: LocationManager, providers: List<String>) {
        for (provider in providers) {
            runCatching {
                lm.setTestProviderEnabled(provider, false)
                lm.removeTestProvider(provider)
            }
        }
    }

    private fun describe(e: Throwable): String =
        "${e.javaClass.simpleName}: ${e.message ?: "no message"}"

    /** How wrong a speed or heading reading is allowed to look. */
    private const val SPEED_ACCURACY_MPS = 0.6f
    private const val BEARING_ACCURACY_DEGREES = 8f
}
