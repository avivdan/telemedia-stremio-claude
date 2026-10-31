package com.telemedia.tv

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * config.json shared by the UI process and the Node process
 * (node-bootstrap/main.js reads it and writes `session` after QR login).
 * SharedPreferences isn't multi-process safe, so we use a plain file.
 */
object AppConfig {
    fun file(ctx: Context): File = File(ctx.filesDir, "config.json")

    fun read(ctx: Context): JSONObject {
        val f = file(ctx)
        return try {
            if (f.exists()) JSONObject(f.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
    }

    fun write(ctx: Context, cfg: JSONObject) {
        val f = file(ctx)
        val tmp = File(f.parentFile, "config.json.tmp")
        tmp.writeText(cfg.toString(2))
        tmp.renameTo(f)
    }

    fun hasCredentials(ctx: Context): Boolean {
        val cfg = read(ctx)
        return cfg.optString("apiId").isNotBlank() && cfg.optString("apiHash").isNotBlank()
    }

    fun saveCredentials(ctx: Context, apiId: String, apiHash: String) {
        val cfg = read(ctx)
        val changed = cfg.optString("apiId") != apiId || cfg.optString("apiHash") != apiHash
        cfg.put("apiId", apiId)
        cfg.put("apiHash", apiHash)
        // A session belongs to the api id that created it.
        if (changed) cfg.remove("session")
        write(ctx, cfg)
    }

    fun clearSession(ctx: Context) {
        val cfg = read(ctx)
        cfg.remove("session")
        write(ctx, cfg)
    }
}
