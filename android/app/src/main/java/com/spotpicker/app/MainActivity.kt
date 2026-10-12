package com.spotpicker.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.spotpicker.app.databinding.ActivityMainBinding
import org.json.JSONObject

/**
 * Hosts the bundled web app in a WebView.
 *
 * The bundle is served from https://appassets.androidplatform.net rather than
 * file://, because Android WebView treats file:// as an opaque origin and
 * localStorage — which stores the saved spots — is unavailable there.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    /**
     * When the app was last sent to the background, in the clock that keeps
     * counting while the phone sleeps. Zero means "still in the foreground".
     */
    private var stoppedAt = 0L

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            // The web app re-reads the status after the dialog closes.
            dispatchEvent("""{"type":"mockState","running":${MockLocationService.isRunning}}""")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 15 draws every app edge-to-edge whether it asks to or not, and
        // this app targets it. Left alone, the WebView then runs underneath the
        // status and navigation bars — and the page's bottom tab bar ends up
        // *behind* the phone's navigation bar, where a tap lands on the system
        // instead of the app. That is what a "bottom navigation that does not
        // work" looks like from the outside. Going edge-to-edge deliberately
        // and handing the content the system bars as padding fixes it the same
        // way on every Android version.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // Paints the window the same colour as the web app on first load, so
        // there is no white flash before the bundle renders. The web app owns
        // the real theme from then on.
        val systemDark = resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        val windowBackground = if (systemDark) R.color.dark_background else R.color.background
        window.setBackgroundDrawableResource(windowBackground)
        // The padded strips that the insets listener adds sit behind the system
        // bars, so they carry the same colour rather than showing a light band
        // above a dark app.
        binding.root.setBackgroundColor(
            androidx.core.content.ContextCompat.getColor(this, windowBackground),
        )

        MockLocationService.listener = ::dispatchEvent

        configureWebView()
        loadApp()

        requestLocationPermissions()
    }

    private fun configureWebView() = with(binding.webView) {
        settings.apply {
            javaScriptEnabled = true
            // Required for the saved-spots store.
            domStorageEnabled = true
            // Everything is bundled locally; nothing should be read off disk.
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = true
        }
        setBackgroundColor(0xFF151518.toInt())

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
            .build()

        webViewClient = object : androidx.webkit.WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: android.webkit.WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        // Exposes window.SpotPicker to the bundled app.
        addJavascriptInterface(SpotPickerBridge(this@MainActivity), "SpotPicker")

        // Creates window.SpotPickerEvents before any page script runs, so the web
        // app can subscribe to service events without racing the load.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                this,
                "window.SpotPickerEvents = window.SpotPickerEvents || {};",
                setOf("https://appassets.androidplatform.net"),
            )
        }
    }

    private fun loadApp() {
        binding.webView.loadUrl("$APP_ORIGIN/assets/index.html")
    }

    /**
     * Hands a JSON payload to the bundled web app. Public so the bridge can
     * report a fingerprint verdict, which arrives long after the JavaScript
     * call that asked for it has returned.
     */
    fun emitEvent(payload: JSONObject) = dispatchEvent(payload.toString())

    /** Forwards a native event to the web app. */
    private fun dispatchEvent(payload: String) {        runOnUiThread {
            val script = "window.SpotPickerEvents && window.SpotPickerEvents.onEvent && " +
                "window.SpotPickerEvents.onEvent(${jsonStringLiteral(payload)});"
            binding.webView.evaluateJavascript(script, null)
        }
    }

    /** Wraps a JSON payload in quotes and escapes it for direct embedding in JS. */
    private fun jsonStringLiteral(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\""

    fun requestLocationPermissions() {
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
    }

    override fun onStart() {
        super.onStart()
        // Spot Picker is meant to be opened by the fingerprint that guards the
        // phone, so coming back to it after a real absence re-arms the lock. The
        // grace period covers the system screens this app opens itself
        // (permission dialog, Developer options, Maps), which stop the activity
        // for a few seconds and should not demand a second fingerprint.
        val away = stoppedAt
        stoppedAt = 0L
        if (away != 0L && SystemClock.elapsedRealtime() - away > LOCK_GRACE_MS) {
            emitEvent(JSONObject().put("type", "relock"))
        }
    }

    override fun onStop() {
        stoppedAt = SystemClock.elapsedRealtime()
        super.onStop()
    }

    override fun onDestroy() {        MockLocationService.listener = null
        // Nothing is left to render a probe result, and a live location
        // registration pointing at a destroyed page would only wake the process.
        runCatching { LocationUpdateProbe.abort(this) }
        binding.webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val APP_ORIGIN = "https://appassets.androidplatform.net"

        /** How long the app may be in the background before it re-locks itself. */
        const val LOCK_GRACE_MS = 20_000L
    }
}