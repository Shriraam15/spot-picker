package com.spotpicker.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build

/**
 * Receives the location fixes the system delivers for the update probe.
 *
 * The probe subscribes with the `PendingIntent` form of requestLocationUpdates
 * and this receiver is where those fixes land. It is unexported, so the only
 * thing that can reach it is the system's own location service completing a
 * PendingIntent we created — no other app can inject a fix through it.
 */
class ProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != LocationUpdateProbe.ACTION_UPDATE) return
        val location = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(LocationManager.KEY_LOCATION_CHANGED, Location::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Location>(LocationManager.KEY_LOCATION_CHANGED)
        }
        location?.let { LocationUpdateProbe.onUpdate(it) }
    }
}
