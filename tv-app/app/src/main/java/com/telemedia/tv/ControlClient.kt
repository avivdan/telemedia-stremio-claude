package com.telemedia.tv

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Talks to node-bootstrap/main.js's control server on 127.0.0.1:7001. Blocking — call off the main thread. */
object ControlClient {
    private val base = "http://127.0.0.1:${NodeService.CONTROL_PORT}"

    /** Returns null when Node isn't up yet. */
    fun status(): JSONObject? = try {
        val conn = URL("$base/status").openConnection() as HttpURLConnection
        conn.connectTimeout = 1000
        conn.readTimeout = 1000
        conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    } catch (e: Exception) {
        null
    }

    fun post(path: String, body: String): Boolean = try {
        val conn = URL("$base$path").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 1000
        conn.readTimeout = 2000
        conn.outputStream.use { it.write(body.toByteArray()) }
        conn.responseCode in 200..299
    } catch (e: Exception) {
        false
    }
}
