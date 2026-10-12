package com.spotpicker.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the notification's Stop action.
 *
 * The action cannot be delivered straight to the service: a service intent aimed
 * at a service that is no longer running trips Android's background-start
 * restrictions, so a broadcast is used instead. It always arrives, and
 * [MockLocationService.stop] is safe to call whether or not the service is alive.
 */
class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        MockLocationService.stop(context.applicationContext)
    }
}
