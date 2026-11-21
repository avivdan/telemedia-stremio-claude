package com.telemedia.phone

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * config.json in the app's private files: written by the Node process
 * (node-bootstrap/main.js), read here only to decide whether to start the
 * addon at boot. SharedPreferences isn't multi-process safe, so it's a plain file.
 */
object AppConfig {
    fun file(ctx: Context): File = File(ctx.filesDir, "config.json")

    private fun read(ctx: Context): JSONObject = try {
        val f = file(ctx)
        if (f.exists()) JSONObject(f.readText()) else JSONObject()
    } catch (e: Exception) {
        JSONObject()
    }

    // "Stop Telemedia": a flag file, readable from both processes. While it
    // exists, nothing starts the addon by itself (boot, opening the app).
    private fun stopFlag(ctx: Context) = File(ctx.filesDir, "stopped")

    fun isStopped(ctx: Context): Boolean = stopFlag(ctx).exists()

    fun setStopped(ctx: Context, stopped: Boolean) {
        if (stopped) stopFlag(ctx).writeText("1") else stopFlag(ctx).delete()
    }

    /** Logged in to Telegram with the user's own key: the addon can start by itself. */
    fun isSetUp(ctx: Context): Boolean {
        val cfg = read(ctx)
        return cfg.optString("apiId").isNotBlank() && cfg.optString("session").isNotBlank()
    }
}
