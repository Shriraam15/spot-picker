package com.spotpicker.app

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Bridge between the bundled web app and Android.
 *
 * Only primitives cross the boundary: every method returns a JSON string, which
 * the TypeScript client parses. That avoids the marshalling surprises you get
 * when @JavascriptInterface has to convert objects. Responses are built with
 * [JSONObject] rather than string templates, because a hand-built template that
 * is missing one pair of quotes produces a payload the web app silently throws
 * away.
 */
class SpotPickerBridge(private val activity: Activity) {

    private companion object {
        /**
         * More points than this is a route nobody walks; also a payload guard.
         * It matches MAX_ROUTE_POINTS in the web app's lib/route.ts, which thins
         * a road route down to fit before sending it.
         *
         * It is generous on purpose: the route is road geometry, and every point
         * that gets dropped moves the path off the carriageway, which is exactly
         * what a map app drawing the dot would show.
         */
        const val MAX_ROUTE_POINTS = 4000
    }

    @JavascriptInterface
    fun isNative(): Boolean = true

    /**
     * Everything the lock screen needs to decide how this app may be opened:
     * whether the phone has a fingerprint sensor, whether one is enrolled, and
     * a sentence explaining a refusal. A WebView cannot answer any of this —
     * see [BiometricGate] — so the answer comes from Android itself.
     */
    @JavascriptInterface
    fun biometricStatus(): String = BiometricGate.status(activity).toString()

    /**
     * Opens the phone's own fingerprint sheet.
     *
     * Returns as soon as the request is queued: a fingerprint prompt takes as
     * long as a finger takes, so the verdict is delivered as a
     * `biometricResult` event rather than as this call's return value. The
     * callback always fires, including when no prompt could be shown, so the
     * lock screen is never left waiting forever.
     */
    @JavascriptInterface
    fun requestBiometricUnlock(): String {
        activity.runOnUiThread {
            try {
                BiometricGate.authenticate(activity) { ok, error ->
                    (activity as? MainActivity)?.emitEvent(
                        JSONObject().apply {
                            put("type", "biometricResult")
                            put("ok", ok)
                            put("error", error ?: JSONObject.NULL)
                        },
                    )
                }
            } catch (e: Exception) {
                // Reported the same way as a refused prompt, so the web app has
                // exactly one path to handle.
                (activity as? MainActivity)?.emitEvent(
                    JSONObject().apply {
                        put("type", "biometricResult")
                        put("ok", false)
                        put("error", "The fingerprint prompt could not open.")
                    },
                )
            }
        }
        return okJson()
    }

    /**
     * Opens the Android screen where fingerprints are enrolled, for the case
     * where the phone has a sensor but no registered fingerprint — the only
     * situation in which this app cannot be opened by a fingerprint.
     */
    @JavascriptInterface
    fun openBiometricSettings() {
        activity.runOnUiThread {
            val candidates = mutableListOf<Intent>()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                candidates.add(Intent(Settings.ACTION_BIOMETRIC_ENROLL))
            }
            candidates.add(Intent(Settings.ACTION_SECURITY_SETTINGS))
            candidates.add(Intent(Settings.ACTION_SETTINGS))
            launchFirst(*candidates.toTypedArray())
        }
    }

    /**
     * Reports everything the setup checklist and action bar need.
     *
     * A small UX upgrade for the new review panel: expose whether Developer
     * options are even reachable, and keep the same error ordering the web app
     * already expects.
     */
    @JavascriptInterface
    fun getStatus(): String {
        val selected = MockLocationController.isMockAppSelected(activity)
        val developerOptions = MockLocationController.developerOptionsEnabled(activity)
        val permission = hasLocationPermission()
        val running = MockLocationService.isRunning
        val error = when {
            MockLocationService.lastError != null -> MockLocationService.lastError
            running && !selected ->
                "Choose Spot Picker under Developer options > Select mock location app."
            !permission -> "Location permission has not been granted yet."
            else -> null
        }
        return JSONObject().apply {
            put("available", true)
            put("appSelected", selected)
            put("developerOptions", developerOptions)
            put("running", running)
            put("starting", MockLocationService.isStarting)
            put("hasPermission", permission)
            put("error", error ?: JSONObject.NULL)
        }.toString()
    }

    /**
     * Returns {"ok":true} once the request has been handed to the service, or
     * {"ok":false,"error":"…"} when the request itself was refused. The service
     * verifies the providers and reports the real outcome through an event, so
     * the web app polls [getStatus] as well as listening.
     */
    @JavascriptInterface
    fun startMock(lat: Double, lon: Double): String {
        if (!hasLocationPermission()) {
            return errorJson("Location permission has not been granted yet. Tap Grant in Setup.")
        }
        return try {
            // Deliberately not gated on the mock-app selection check: that check
            // is a heuristic, and a false negative would block a start the system
            // would happily have allowed. Installing the test provider is the real
            // test, and the service reports the failure with the system's own words.
            MockLocationService.start(activity, lat, lon)
            okJson()
        } catch (e: Exception) {
            MockLocationService.cancelStart()
            errorJson(startFailureMessage(e))
        }
    }

    /**
     * Starts, or replaces, a simulated route. [waypointsJson] is the
     * `[[lat,lon], …]` array the web app builds from its route editor.
     *
     * The service plays the route itself, so movement continues while the phone
     * is showing another app — which is the entire point of faking a position.
     */
    @JavascriptInterface
    fun startRoute(waypointsJson: String, speedKmh: Double, mode: String): String {
        if (!hasLocationPermission()) {
            return errorJson("Location permission has not been granted yet. Tap Grant in Setup.")
        }
        val points = MockRoute.parse(waypointsJson)
        if (points.size < 2) return errorJson("A route needs at least two points on the map.")
        if (points.size > MAX_ROUTE_POINTS) {
            return errorJson("A route can have at most $MAX_ROUTE_POINTS points.")
        }
        if (speedKmh < 0.5 || speedKmh > 200.0) {
            return errorJson("Choose a speed between 0.5 and 200 km/h.")
        }
        return try {
            MockLocationService.startRoute(activity, points, speedKmh, MotionMode.from(mode))
            okJson()
        } catch (e: Exception) {
            MockLocationService.cancelStart()
            errorJson(startFailureMessage(e))
        }
    }

    /**
     * Subscribes to the mocked providers for [seconds] and reports how many
     * fixes actually arrive.
     *
     * This is the only way to tell apart the two reasons a mock can look like it
     * works: publishing a position is enough for a one-shot "where am I?" read,
     * while anything that watches the position continuously — live location —
     * needs the subscription path to be delivering too. The answer arrives as a
     * `probeResult` event, so the request itself returns immediately.
     */
    @JavascriptInterface
    fun startLiveUpdateTest(seconds: Double): String {
        return try {
            LocationUpdateProbe.start(activity, seconds).toString()
        } catch (e: Exception) {
            errorJson("Could not run the live-update test: ${e.javaClass.simpleName}.")
        }
    }

    /** Progress of the loaded route, for the simulator. */
    @JavascriptInterface
    fun getRoute(): String {
        val lat = MockLocationService.publishedLat
        val lon = MockLocationService.publishedLon
        return JSONObject().apply {
            put("active", MockLocationService.routeActive)
            put("finished", MockLocationService.routeFinished)
            put("running", MockLocationService.isRunning)
            if (lat == null) put("lat", JSONObject.NULL) else put("lat", lat)
            if (lon == null) put("lon", JSONObject.NULL) else put("lon", lon)
            put("travelledMetres", MockLocationService.routeTravelledMetres)
            put("totalMetres", MockLocationService.routeTotalMetres)
            put("speedKmh", MockLocationService.routeSpeedKmh)
        }.toString()
    }

    /**
     * Hands the service a position to publish, while the joystick is held.
     *
     * This is what makes steering continuous: the web app sends a target a few
     * times a second and the service publishes whatever is current, so the
     * phone's position follows the thumb rather than jumping between nudges.
     * Route playback keeps advancing underneath, which is what lets go of the
     * joystick re-join the journey instead of restarting it.
     */
    @JavascriptInterface
    fun setManualPosition(lat: Double, lon: Double): String {
        if (!MockLocationService.isRunning) {
            return errorJson("Start a mock location before steering it.")
        }
        if (!lat.isFinite() || !lon.isFinite() || lat !in -90.0..90.0 || lon !in -180.0..180.0) {
            return errorJson("That is not a position Android could publish.")
        }
        return try {
            MockLocationService.setManualPosition(lat, lon)
            okJson()
        } catch (e: Exception) {
            errorJson("Could not move the position: ${e.javaClass.simpleName}.")
        }
    }

    /**
     * Lets go of the joystick: the position goes back to the route (or the
     * stationary pin), wherever that journey has actually got to by now.
     */
    @JavascriptInterface
    fun clearManualPosition(): String {
        return try {
            MockLocationService.clearManualPosition()
            okJson()
        } catch (e: Exception) {
            errorJson("Could not hand the position back: ${e.javaClass.simpleName}.")
        }
    }

    @JavascriptInterface
    fun stopMock(): String {
        return try {
            // Idempotent: clearing the state is a success even when nothing was
            // running, because that is exactly the state the user asked for.
            MockLocationService.stop(activity)
            okJson()
        } catch (e: Exception) {
            errorJson(e.message ?: "Could not stop mock location.")
        }
    }

    /**
     * A plain-text report of everything that decides whether mock location can
     * run, so a failure can be diagnosed from the phone without a cable.
     *
     * UX upgrade: the web-side review panel now reads a compact snapshot too, so
     * this report is the detailed companion to that snapshot rather than the only
     * window into the problem.
     */
    @JavascriptInterface
    fun getDiagnostics(): String {
        val notificationPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            ) "granted" else "denied"
        } else {
            "not required"
        }
        val selectionReachable = MockLocationController.developerOptionsEnabled(activity)
        val biometric = BiometricGate.status(activity)
        val lines = listOf(
            "Spot Picker diagnostics",
            "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) on ${Build.MANUFACTURER} ${Build.MODEL}",
            "package: ${activity.packageName}",
            "fingerprint gate available: ${biometric.optBoolean("available")} (${biometric.optString("reason")})",
            "location permission: ${if (hasLocationPermission()) "granted" else "DENIED"}",
            "notification permission: $notificationPermission",
            "developer options enabled: $selectionReachable",
            "mock app selected (app-op): ${MockLocationController.isMockAppSelected(activity)}",
            "mock app app-op mode: ${MockLocationController.mockAppOpMode(activity)}",
            "selection reachable from settings: $selectionReachable",
            "confirmed by system: ${MockLocationController.confirmedBySystem}",
            "installed providers: ${MockLocationController.activeProviders().ifEmpty { listOf("none") }}",
            "providers the device refused: ${MockLocationController.rejections.ifEmpty { listOf("none") }}",
            "service running: ${MockLocationService.isRunning}",
            "service starting: ${MockLocationService.isStarting}",
            "motion mode: ${MockLocationService.mode.id}",
            "route active: ${MockLocationService.routeActive}",
            "last error: ${MockLocationService.lastError ?: "none"}",
            "last system error: ${MockLocationController.lastFailureDetail ?: "none"}",
        )
        return lines.joinToString("\n")
    }

    /** Must run on the UI thread; the activity posts it. */
    @JavascriptInterface
    fun requestPermissions() {
        activity.runOnUiThread {
            (activity as? MainActivity)?.requestLocationPermissions()
        }
    }

    /**
     * Opens the screen where the mock location app is chosen.
     *
     * "Select mock location app" lives inside Developer options, which is hidden
     * entirely until the user unlocks it by tapping Build number seven times. The
     * single most common reason a start is refused is that the picker was never
     * reachable, so when Developer options are still locked this deliberately
     * lands on About phone instead of a screen that cannot help.
     */
    @JavascriptInterface
    fun openDeveloperOptions() {
        activity.runOnUiThread {
            if (!MockLocationController.developerOptionsEnabled(activity)) {
                launchFirst(
                    Intent(Settings.ACTION_DEVICE_INFO_SETTINGS),
                    Intent(Settings.ACTION_SETTINGS),
                )
                return@runOnUiThread
            }
            // The public action is preferred; the reflective component covers
            // OEM builds that do not export it, and app settings is the last
            // resort so the tap is never a no-op.
            launchFirst(
                Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
                Intent().setComponent(
                    ComponentName(
                        "com.android.settings",
                        "com.android.settings.DevelopmentSettings",
                    ),
                ),
            )
        }
    }

    /** About phone, where Developer options are unlocked. */
    @JavascriptInterface
    fun openAboutPhone() {
        activity.runOnUiThread {
            launchFirst(
                Intent(Settings.ACTION_DEVICE_INFO_SETTINGS),
                Intent(Settings.ACTION_SETTINGS),
            )
        }
    }

    /** Starts the first of [candidates] that resolves, else app settings. */
    private fun launchFirst(vararg candidates: Intent) {
        for (intent in candidates) {
            val ok = runCatching {
                if (intent.resolveActivity(activity.packageManager) != null) {
                    activity.startActivity(intent)
                    true
                } else {
                    false
                }
            }.getOrDefault(false)
            if (ok) return
        }
        openAppSettings()
    }

    /**
     * Opens an https link outside the app — currently the chosen journey in
     * Google Maps, so it can be compared against the simulated movement.
     *
     * Only https is allowed through. The page is our own bundle, but the bridge
     * is a general-purpose door out of the WebView, and a door that accepts
     * `intent://` or `javascript:` URLs is a door worth keeping shut.
     */
    @JavascriptInterface
    fun openExternalUrl(url: String): String {
        if (!url.startsWith("https://")) {
            return errorJson("Only https links can be opened.")
        }
        activity.runOnUiThread {
            try {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (e: Exception) {
                // No browser and no Maps app: nothing to do, and nothing worth
                // interrupting the user over.
            }
        }
        return okJson()
    }

    @JavascriptInterface
    fun openAppSettings() {
        activity.runOnUiThread {
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.packageName, null),
                    )
                )
            } catch (e: Exception) {
                // Nothing sensible to do if even app settings cannot open.
            }
        }
    }

    private fun hasLocationPermission(): Boolean =
        activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Turns a start failure into something worth reading on a phone screen. */
    private fun startFailureMessage(e: Exception): String = when (e) {
        is SecurityException ->
            "Android refused to start: ${e.message ?: "permission denied"}. " +
                "Check that Spot Picker is selected under Developer options."
        else -> "Android would not start the service: ${e.javaClass.simpleName}. " +
            "Close and reopen Spot Picker, then try again."
    }

    private fun okJson(): String = JSONObject().apply {
        put("ok", true)
        put("error", JSONObject.NULL)
    }.toString()

    private fun errorJson(message: String): String = JSONObject().apply {
        put("ok", false)
        put("error", message)
    }.toString()
}
