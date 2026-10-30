package com.telemedia.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the addon when the TV boots (or the app is updated), once configured. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            -> if (AppConfig.hasCredentials(context)) NodeService.start(context)
        }
    }
}
