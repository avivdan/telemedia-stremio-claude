package com.telemedia.tv

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject

/**
 * Setup + status screen. Polls the Node control server and shows:
 * credentials form → QR login → optional 2FA password → running, then the
 * one-time "add to Stremio" step until Stremio is seen using the addon.
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var apiId: EditText
    private lateinit var apiHash: EditText
    private lateinit var qr: ImageView
    private lateinit var passwordGroup: View
    private lateinit var password: EditText
    private lateinit var stremioButton: Button
    private var shownQrUrl: String? = null
    private var stremioAction: () -> Unit = {}

    // Right after the first login, jump to Stremio's Add-ons page once,
    // after giving the user a moment to read the URL they'll need.
    private val autoOpenStremio = Runnable { Stremio.openAddonsPage(this) }

    private val poll = object : Runnable {
        override fun run() {
            Thread {
                val s = ControlClient.status()
                runOnUiThread { render(s) }
            }.start()
            handler.postDelayed(this, 1500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        status = findViewById(R.id.status)
        apiId = findViewById(R.id.api_id)
        apiHash = findViewById(R.id.api_hash)
        qr = findViewById(R.id.qr)
        passwordGroup = findViewById(R.id.password_group)
        password = findViewById(R.id.password)
        stremioButton = findViewById(R.id.open_stremio)
        stremioButton.setOnClickListener { stremioAction() }

        val cfg = AppConfig.read(this)
        apiId.setText(cfg.optString("apiId"))
        apiHash.setText(cfg.optString("apiHash"))

        findViewById<Button>(R.id.save).setOnClickListener {
            AppConfig.saveCredentials(this, apiId.text.toString().trim(), apiHash.text.toString().trim())
            restartNode("Saved. Restarting…")
        }
        findViewById<Button>(R.id.restart).setOnClickListener { restartNode("Restarting…") }
        findViewById<Button>(R.id.logout).setOnClickListener {
            AppConfig.clearSession(this)
            restartNode("Logged out. Restarting…")
        }
        findViewById<Button>(R.id.send_password).setOnClickListener {
            val pw = password.text.toString()
            password.setText("")
            Thread { ControlClient.post("/password", pw) }.start()
        }

        NodeService.start(this)
    }

    override fun onResume() {
        super.onResume()
        handler.post(poll)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(poll)
        handler.removeCallbacks(autoOpenStremio)
    }

    private fun restartNode(message: String) {
        status.text = message
        shownQrUrl = null
        Thread { NodeService.restart(applicationContext) }.start()
    }

    private fun render(s: JSONObject?) {
        val state = s?.optString("state") ?: "offline"
        qr.visibility = if (state == "qr") View.VISIBLE else View.GONE
        passwordGroup.visibility = if (state == "need_password") View.VISIBLE else View.GONE

        status.text = when (state) {
            "offline" -> "Starting addon service…"
            "starting", "logging_in" -> "Connecting to Telegram…"
            "starting_addon" -> "Starting addon…"
            "need_config" -> "Enter your Telegram API ID and hash (my.telegram.org), then Save."
            "qr" -> "Scan with Telegram on your phone:\nSettings → Devices → Link Desktop Device"
            "need_password" -> "Two-step verification password required" +
                s!!.optString("hint").let { if (it.isNotBlank()) " (hint: $it)" else "" }
            "running" -> runningText(s!!)
            "error" -> "Error: ${s!!.optString("error")}\nCheck credentials and press Restart."
            else -> state
        }
        if (state != "running") stremioButton.visibility = View.GONE

        if (state == "qr") {
            val url = s!!.optString("qrUrl")
            if (url != shownQrUrl) {
                shownQrUrl = url
                qr.setImageBitmap(qrBitmap(url, 600))
            }
        }
    }

    // Also sets up the Stremio button for the current situation.
    private fun runningText(s: JSONObject): String {
        stremioButton.visibility = View.VISIBLE
        if (Stremio.installedPackage(this) == null) {
            stremioButton.setText(R.string.get_stremio)
            stremioAction = { Stremio.openStoreListing(this) }
            return "Telemedia is running ✔\n\nInstall Stremio to watch."
        }
        if (s.optBoolean("stremioConnected")) {
            stremioButton.setText(R.string.open_stremio)
            stremioAction = { Stremio.open(this) }
            return "Telemedia is running ✔\nConnected to Stremio — nothing else to do."
        }
        stremioButton.setText(R.string.add_to_stremio)
        stremioAction = { Stremio.openAddonsPage(this) }
        if (AppConfig.setFlagOnce(this, "stremioAutoOpened")) {
            handler.postDelayed(autoOpenStremio, 8000)
        }
        return "Telemedia is running ✔\n\nLast step (once per Stremio account):\n" +
            "In Stremio → Add-ons → Add addon, enter\n" +
            "${s.optString("manifestUrl")}\nthen Install."
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(
            text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1),
        )
        val pixels = IntArray(size * size) { i ->
            if (matrix[i % size, i / size]) Color.BLACK else Color.WHITE
        }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
    }
}
