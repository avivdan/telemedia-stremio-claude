package com.telemedia.phone

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Talks to node-bootstrap/main.js's control server on 127.0.0.1:7001, with
 * the secret NodeService makes at every start (only this app can read it), so
 * other apps and web pages on the phone can't use it. Blocking: call off the
 * main thread.
 */
object ControlClient {
    private val base = "http://127.0.0.1:${NodeService.CONTROL_PORT}"

    /** An action's answer: ok, or the error message to show. */
    class Reply(val ok: Boolean, val body: JSONObject, val error: String)

    fun tokenFile(ctx: Context): File = File(ctx.filesDir, "control.token")

    private fun token(ctx: Context): String = try {
        tokenFile(ctx).readText().trim()
    } catch (e: Exception) {
        ""
    }

    /** Returns null when Node isn't up yet. */
    fun status(ctx: Context): JSONObject? = try {
        val conn = URL("$base/status").openConnection() as HttpURLConnection
        conn.connectTimeout = 1000
        conn.readTimeout = 1500
        conn.setRequestProperty("X-Telemedia-Token", token(ctx))
        if (conn.responseCode == 200) conn.inputStream.bufferedReader().use { JSONObject(it.readText()) } else null
    } catch (e: Exception) {
        null
    }

    /** POST a JSON body. Some actions talk to Telegram or Stremio, so allow up to a minute. */
    fun post(ctx: Context, path: String, body: String, readTimeoutMs: Int = 60_000): Reply = try {
        val conn = URL("$base$path").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 2000
        conn.readTimeout = readTimeoutMs
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("X-Telemedia-Token", token(ctx))
        conn.outputStream.use { it.write(body.toByteArray()) }
        val ok = conn.responseCode in 200..299
        val text = (if (ok) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
        Reply(ok, json, json.optString("error").ifBlank { "Something went wrong (${conn.responseCode})" })
    } catch (e: java.net.SocketTimeoutException) {
        Reply(false, JSONObject(), "Still working on it: check again in a moment.")
    } catch (e: Exception) {
        Reply(false, JSONObject(), "Telemedia isn't responding. Tap Restart.")
    }
}
