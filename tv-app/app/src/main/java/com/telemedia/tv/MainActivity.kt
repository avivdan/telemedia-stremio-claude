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
 * credentials form → Telegram QR login (+ optional 2FA password) and, in
 * parallel, the Stremio pairing QR that adds the addon to the user's Stremio
 * account → running.
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var apiId: EditText
    private lateinit var apiHash: EditText
    private lateinit var telegramGroup: View
    private lateinit var qr: ImageView
    private lateinit var stremioGroup: View
    private lateinit var stremioQr: ImageView
    private lateinit var passwordGroup: View
    private lateinit var password: EditText
    private lateinit var stremioButton: Button
    private var shownQrUrl: String? = null
    private var shownStremioLink: String? = null
    private var stremioAction: () -> Unit = {}

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
        telegramGroup = findViewById(R.id.telegram_group)
        qr = findViewById(R.id.qr)
        stremioGroup = findViewById(R.id.stremio_group)
        stremioQr = findViewById(R.id.stremio_qr)
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
    }

    private fun restartNode(message: String) {
        status.text = message
        shownQrUrl = null
        shownStremioLink = null
        Thread { NodeService.restart(applicationContext) }.start()
    }

    private fun render(s: JSONObject?) {
        val state = s?.optString("state") ?: "offline"
        passwordGroup.visibility = if (state == "need_password") View.VISIBLE else View.GONE

        // Telegram QR
        telegramGroup.visibility = if (state == "qr") View.VISIBLE else View.GONE
        if (state == "qr") {
            val url = s!!.optString("qrUrl")
            if (url != shownQrUrl) {
                shownQrUrl = url
                qr.setImageBitmap(qrBitmap(url, 480))
            }
        }

        // Stremio pairing QR — shown whenever pairing waits, also during Telegram login.
        val stremio = s?.optJSONObject("stremio")
        val stremioState = stremio?.optString("state") ?: "idle"
        val pairing = stremioState == "waiting" && s?.optBoolean("stremioConnected") != true &&
            Stremio.installedPackage(this) != null
        stremioGroup.visibility = if (pairing) View.VISIBLE else View.GONE
        if (pairing) {
            val link = stremio!!.optString("link")
            if (link != shownStremioLink) {
                shownStremioLink = link
                stremioQr.setImageBitmap(qrBitmap(link, 480))
            }
        }

        status.text = when (state) {
            "offline" -> "Starting addon service…"
            "starting", "logging_in" -> "Connecting to Telegram…"
            "starting_addon" -> "Starting addon…"
            "need_config" -> "Enter your Telegram API ID and hash (my.telegram.org), then Save."
            "qr" -> if (pairing) "Scan both codes with your phone:" else "Scan with Telegram on your phone:"
            "need_password" -> "Two-step verification password required" +
                s!!.optString("hint").let { if (it.isNotBlank()) " (hint: $it)" else "" }
            "running" -> runningText(s!!, stremioState, stremio?.optString("error"))
            "error" -> "Error: ${s!!.optString("error")}\nCheck credentials and press Restart."
            else -> state
        }
        if (state != "running") stremioButton.visibility = View.GONE
    }

    // Also sets up the Stremio button for the current situation.
    private fun runningText(s: JSONObject, stremioState: String, stremioError: String?): String {
        stremioButton.visibility = View.VISIBLE
        if (Stremio.installedPackage(this) == null) {
            stremioButton.setText(R.string.get_stremio)
            stremioAction = { Stremio.openStoreListing(this) }
            return "Telemedia is running ✔\n\nInstall Stremio to watch."
        }
        if (s.optBoolean("stremioConnected") || stremioState == "done") {
            stremioButton.setText(R.string.open_stremio)
            stremioAction = { Stremio.open(this) }
            return "Telemedia is running ✔\nAdded to Stremio — nothing else to do."
        }
        // Manual fallback stays available next to the QR code.
        stremioButton.setText(R.string.add_to_stremio)
        stremioAction = { Stremio.openAddonsPage(this) }
        val manual = "Or in Stremio → Add-ons → Add addon, enter\n${s.optString("manifestUrl")}"
        return when (stremioState) {
            "installing" -> "Telemedia is running ✔\n\nAdding Telemedia to your Stremio account…"
            "error" -> "Telemedia is running ✔\n\nCouldn't add to Stremio automatically" +
                (stremioError?.let { ": $it" } ?: "") + "\n$manual"
            else -> "Telemedia is running ✔\n\nLast step: scan the Stremio code with your phone camera " +
                "and confirm.\n$manual"
        }
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
