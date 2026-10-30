package com.telemedia.tv

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hand-off to the Stremio app.
 *
 * Stremio has no way for another app to install an addon: its stremio://
 * install links are rewritten to https:// (a local http addon can't serve
 * that) and its http intent filter only takes magnet links. The closest we
 * can get is opening Stremio directly on its Add-ons page, where the user
 * adds http://127.0.0.1:7000/manifest.json once. Stremio syncs installed
 * addons per account, so other devices on the same account need nothing.
 */
object Stremio {
    private val PACKAGES = listOf("com.stremio.one", "com.stremio.android")

    // Any /addons/... route lands on Stremio's Add-ons page.
    private const val ADDONS_PAGE =
        "stremio:///addons/other/http%3A%2F%2F127.0.0.1%3A7000%2Fmanifest.json/telemedia"

    fun installedPackage(ctx: Context): String? = PACKAGES.firstOrNull {
        ctx.packageManager.getLaunchIntentForPackage(it) != null
    }

    fun openAddonsPage(ctx: Context): Boolean {
        val pkg = installedPackage(ctx) ?: return false
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(ADDONS_PAGE))
            .setPackage(pkg)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            ctx.startActivity(view)
            true
        } catch (e: ActivityNotFoundException) {
            open(ctx)
        }
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
