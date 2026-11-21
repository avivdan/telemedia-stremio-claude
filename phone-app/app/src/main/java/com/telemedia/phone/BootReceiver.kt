package com.telemedia.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the addon when the phone boots (or the app is updated), once set up and unless stopped. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            -> if (AppConfig.isSetUp(context) && !AppConfig.isStopped(context)) NodeService.start(context)
        }
    }
}
