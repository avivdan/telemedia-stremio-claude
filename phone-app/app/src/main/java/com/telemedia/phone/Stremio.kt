package com.telemedia.phone

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Opening the Stremio app, or its store page when it isn't installed. */
object Stremio {
    private val PACKAGES = listOf("com.stremio.one", "com.stremio.android")

    fun installedPackage(ctx: Context): String? = PACKAGES.firstOrNull {
        ctx.packageManager.getLaunchIntentForPackage(it) != null
    }

    fun open(ctx: Context): Boolean {
        val pkg = installedPackage(ctx) ?: return false
        val launch = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
    }

    fun openStoreListing(ctx: Context) {
        val id = PACKAGES.first()
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$id"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(market)
        } catch (e: ActivityNotFoundException) {
            ctx.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$id"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}
