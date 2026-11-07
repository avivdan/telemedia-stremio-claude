package com.telemedia.tv

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import java.net.Inet4Address

/**
 * Setup + status screen. Polls the Node control server and shows:
 * credentials form → Telegram QR login (+ optional 2FA password) and, in
 * parallel, the Stremio pairing QR that adds the addon to the user's Stremio
 * account → running.
 */
private const val MY_TELEGRAM_URL = "https://my.telegram.org/apps"
private const val SETUP_PORT = 7002 // node-bootstrap/setup-server.js

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
    private lateinit var stremioManual: TextView
    private lateinit var setupGroup: View
    private lateinit var setupQr: ImageView
    private lateinit var restartButton: Button
    private lateinit var logoutButton: Button
    private lateinit var saveButton: Button
    private var phoneSetup = false
    private var wasSetup = false
    private var lastState: String? = null
    private var shownQrUrl: String? = null
    private var shownStremioLink: String? = null
    private var setupFocused = false
    private var stremioAction: () -> Unit = {}
    // A message (e.g. a validation error) shown over the polled status for a while.
    private var notice: String? = null
    private var noticeUntil = 0L

    private fun showNotice(message: String, millis: Long = 8000) {
        notice = message
        noticeUntil = System.currentTimeMillis() + millis
        status.text = message
    }

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
        stremioManual = findViewById(R.id.stremio_manual)
        setupGroup = findViewById(R.id.setup_group)
        setupQr = findViewById(R.id.setup_qr)
        // Setup runs from the phone (page served by the TV, see setup-server.js).
        // Without a LAN address, fall back to my.telegram.org + typing on the TV.
        val setupUrl = lanAddress()?.let { "http://$it:$SETUP_PORT/" }
        phoneSetup = setupUrl != null
        setupQr.setImageBitmap(qrBitmap(setupUrl ?: MY_TELEGRAM_URL, 480))
        findViewById<TextView>(R.id.setup_caption).setText(
            if (phoneSetup) R.string.setup_phone_caption else R.string.setup_qr_caption,
        )
        saveButton = findViewById(R.id.save)
        loadCredentials()

        saveButton.setOnClickListener {
            val id = apiId.text.toString().trim()
            val hash = apiHash.text.toString().trim()
            when {
                !id.matches(Regex("\\d{3,12}")) ->
                    showNotice("The api_id is a number (from my.telegram.org → API development tools).")
                !hash.matches(Regex("[0-9a-fA-F]{32}")) ->
                    showNotice("The api_hash is 32 letters and digits — check for typos.")
                else -> {
                    AppConfig.saveCredentials(this, id, hash.lowercase())
                    restartNode("Saved. Starting…")
                }
            }
        }
        restartButton = findViewById(R.id.restart)
        logoutButton = findViewById(R.id.logout)
        restartButton.setOnClickListener { restartNode("Restarting…") }
        logoutButton.setOnClickListener {
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

    private fun loadCredentials() {
        val cfg = AppConfig.read(this)
        apiId.setText(cfg.optString("apiId"))
        apiHash.setText(cfg.optString("apiHash"))
        // Visible while typing it the first time; masked once saved.
        if (cfg.optString("apiHash").isNotBlank()) {
            apiHash.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
    }

    // The TV's own Wi-Fi/Ethernet IPv4 address, for the phone setup page.
    private fun lanAddress(): String? {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return null
        val props = cm.getLinkProperties(cm.activeNetwork) ?: return null
        return props.linkAddresses.map { it.address }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }?.hostAddress
    }

    private fun restartNode(message: String) {
        showNotice(message, 3000)
        shownQrUrl = null
        shownStremioLink = null
        Thread { NodeService.restart(applicationContext) }.start()
    }

    private fun render(s: JSONObject?) {
        val state = s?.optString("state") ?: "offline"
        passwordGroup.visibility = if (state == "need_password") View.VISIBLE else View.GONE

        // First-run setup: link to my.telegram.org, cursor in the api_id field
        // (keyboard stays closed so it doesn't cover the QR code).
        val setup = state == "need_config"
        setupGroup.visibility = if (setup) View.VISIBLE else View.GONE
        restartButton.visibility = if (setup) View.GONE else View.VISIBLE
        logoutButton.visibility = if (setup) View.GONE else View.VISIBLE
        // The key fields are only for typing keys on the TV (no phone setup)
        // and for fixing keys Telegram rejected; setup fills them in otherwise.
        val manualForm = if ((setup && !phoneSetup) || state == "error") View.VISIBLE else View.GONE
        apiId.visibility = manualForm
        apiHash.visibility = manualForm
        saveButton.visibility = manualForm
        if (setup && !phoneSetup && !setupFocused) {
            setupFocused = true
            apiId.requestFocus()
        }
        // Keys arrived from the phone: show them in the (now visible) form.
        if (wasSetup && !setup && state != "offline") loadCredentials()
        if (state == "error" && lastState != "error") loadCredentials()
        wasSetup = setup
        lastState = state

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
        // Not during first-run setup: one step at a time.
        val pairing = stremioState == "waiting" && s?.optBoolean("stremioConnected") != true &&
            state != "need_config" && Stremio.installedPackage(this) != null
        stremioGroup.visibility = if (pairing) View.VISIBLE else View.GONE
        if (pairing) {
            val link = stremio!!.optString("link")
            if (link != shownStremioLink) {
                shownStremioLink = link
                stremioQr.setImageBitmap(qrBitmap(link, 480))
            }
        }

        val text = when (state) {
            "offline" -> "Starting addon service…"
            "starting", "logging_in" -> "Connecting to Telegram…"
            "starting_addon" -> "Starting addon…"
            "need_config" -> if (phoneSetup) setupText(s!!) else getString(R.string.setup_instructions)
            "auto_setup" -> getString(
                if (s!!.optString("setupStep") == "switching") R.string.auto_setup_switching
                else R.string.auto_setup_working,
            )
            "qr" -> if (pairing) "Scan both codes with your phone:" else "Scan with Telegram on your phone:"
            "need_password" -> "Two-step verification password required" +
                s!!.optString("hint").let { if (it.isNotBlank()) " (hint: $it)" else "" }
            "running" -> runningText(s!!, stremioState, stremio?.optString("error"))
            "error" -> errorText(s!!.optString("error"))
            else -> state
        }
        status.text = if (notice != null && System.currentTimeMillis() < noticeUntil) notice else text
        if (state != "running") {
            stremioButton.visibility = View.GONE
            stremioManual.visibility = View.GONE
        }
    }

    // Also sets up the Stremio button for the current situation.
    private fun runningText(s: JSONObject, stremioState: String, stremioError: String?): String {
        stremioButton.visibility = View.VISIBLE
        stremioManual.visibility = View.GONE
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
        // Manual fallback stays available on the right, next to the QR code.
        stremioButton.setText(R.string.add_to_stremio)
        stremioAction = { Stremio.openAddonsPage(this) }
        stremioManual.text = "Or in Stremio → Add-ons → Add addon, enter\n${s.optString("manifestUrl")}"
        stremioManual.visibility = View.VISIBLE
        // Kept short so the Stremio code below it fits on screen.
        return when (stremioState) {
            "installing" -> "Telemedia is running ✔\nAdding Telemedia to your Stremio account…"
            "error" -> "Telemedia is running ✔\nCouldn't add to Stremio automatically" +
                (stremioError?.let { ": $it" } ?: "")
            else -> "Telemedia is running ✔\nLast step: scan the Stremio code with your phone camera and confirm."
        }
    }

    private fun setupText(s: JSONObject): String {
        val step = when (s.optString("setupStep")) {
            "code_sent" -> getString(R.string.setup_code_sent)
            "reading", "creating" -> getString(R.string.setup_working)
            "error" -> "Setup problem: " + s.optString("setupError") + "\nTry again on your phone."
            else -> null
        }
        val intro = getString(R.string.setup_instructions_phone)
        return if (step != null) "$intro\n\n$step" else intro
    }

    private fun errorText(error: String): String = when {
        error.contains("API_ID_INVALID") ->
            "Telegram rejected the api_id / api_hash. Fix them on the right and Save and start."
        error.contains("API_ID_PUBLISHED_FLOOD") ->
            "Telegram blocked this api_id. Create a new app on my.telegram.org and enter its values."
        else -> "Error: $error\nCheck your api_id / api_hash and press Restart."
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
