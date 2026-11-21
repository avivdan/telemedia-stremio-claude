package com.telemedia.phone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.telephony.PhoneNumberUtils
import android.telephony.TelephonyManager
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat

/**
 * The whole app on one screen. Polls the Node control server
 * (node-bootstrap/main.js) and shows the card for the current step:
 * Telegram login → (automatic own-key setup) → head-start groups →
 * Add to Stremio → done, plus "Use from another device" (the LAN address).
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("ui", Context.MODE_PRIVATE) }

    private lateinit var status: TextView
    private lateinit var loginCard: View
    private lateinit var phone: EditText
    private lateinit var sendPhone: Button
    private lateinit var codeGroup: View
    private lateinit var codeText: TextView
    private lateinit var code: EditText
    private lateinit var sendCode: Button
    private lateinit var loginError: TextView
    private lateinit var passwordCard: View
    private lateinit var passwordText: TextView
    private lateinit var password: EditText
    private lateinit var sendPassword: Button
    private lateinit var passwordError: TextView
    private lateinit var configCard: View
    private lateinit var configPhone: EditText
    private lateinit var configSendPhone: Button
    private lateinit var configCodeGroup: View
    private lateinit var configCode: EditText
    private lateinit var configSendCode: Button
    private lateinit var configManualGroup: View
    private lateinit var apiId: EditText
    private lateinit var apiHash: EditText
    private lateinit var saveKeys: Button
    private lateinit var configError: TextView
    private lateinit var groupsCard: View
    private lateinit var groupsList: LinearLayout
    private lateinit var groupsJoin: Button
    private lateinit var groupsSkip: Button
    private lateinit var groupsError: TextView
    private lateinit var stremioCard: View
    private lateinit var stremioAdd: Button
    private lateinit var stremioNote: TextView
    private lateinit var stremioGet: Button
    private lateinit var stremioOpen: Button
    private lateinit var stremioError: TextView
    private lateinit var doneCard: View
    private lateinit var doneText: TextView
    private lateinit var openStremio: Button
    private lateinit var showGroups: Button
    private lateinit var lanCard: View
    private lateinit var lanQr: ImageView
    private lateinit var lanUrl: TextView
    private lateinit var lanAdd: Button
    // Connected Stremio accounts as last shown, each with its own Remove button.
    private var lanAccountsNow = JSONArray()
    private lateinit var lanNote: TextView
    private lateinit var lanError: TextView
    private lateinit var lanQrCaption: TextView
    private lateinit var lanAccountsTitle: TextView
    private lateinit var lanAccounts: LinearLayout
    private lateinit var batteryCard: View
    private lateinit var stoppedCard: View
    private lateinit var footer: View
    private lateinit var accountRow: View
    private lateinit var accountText: TextView
    private lateinit var accountLogout: Button

    private var stremioOpened = false
    private var lanOpened = false
    private var shownLanUrl: String? = null
    private var shownLanQr: String? = null
    private var shownAccounts: String? = null
    // Accounts being removed right now: their buttons say "Please wait…".
    private val removing = mutableSetOf<String>()
    // A removal that failed: its message, shown in that account's box.
    private val removeErrors = mutableMapOf<String, String>()
    private var manualKeys = false
    private var configCodeShown = false
    private var shownGroups: String? = null
    private val groupChecks = mutableMapOf<String, Boolean>()
    private var restartingUntil = 0L
    // Since when nothing has answered: Restart only after a while, so it can't
    // interrupt the first unpacking after an install or update.
    private var silentSince = 0L
    // Errors from the last action, shown until the next action on that card.
    private val actionErrors = mutableMapOf<TextView, String>()
    // Buttons whose request is still running: the poll must not re-enable them.
    private val inFlight = mutableSetOf<Button>()

    private val poll = object : Runnable {
        override fun run() {
            Thread {
                val s = ControlClient.status(applicationContext)
                runOnUiThread { if (!isFinishing) render(s) }
            }.start()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        setUpActions()
        askNotificationsOnce()
        if (!AppConfig.isStopped(this)) NodeService.start(this)
    }

    override fun onResume() {
        super.onResume()
        // Also cancels a pending restart delay if Android killed the service.
        if (!AppConfig.isStopped(this)) NodeService.start(this)
        handler.post(poll)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(poll)
    }

    private fun bindViews() {
        status = findViewById(R.id.status)
        loginCard = findViewById(R.id.login_card)
        phone = findViewById(R.id.phone)
        sendPhone = findViewById(R.id.send_phone)
        codeGroup = findViewById(R.id.code_group)
        codeText = findViewById(R.id.code_text)
        code = findViewById(R.id.code)
        sendCode = findViewById(R.id.send_code)
        loginError = findViewById(R.id.login_error)
        passwordCard = findViewById(R.id.password_card)
        passwordText = findViewById(R.id.password_text)
        password = findViewById(R.id.password)
        sendPassword = findViewById(R.id.send_password)
        passwordError = findViewById(R.id.password_error)
        configCard = findViewById(R.id.config_card)
        configPhone = findViewById(R.id.config_phone)
        configSendPhone = findViewById(R.id.config_send_phone)
        configCodeGroup = findViewById(R.id.config_code_group)
        configCode = findViewById(R.id.config_code)
        configSendCode = findViewById(R.id.config_send_code)
        configManualGroup = findViewById(R.id.config_manual_group)
        apiId = findViewById(R.id.api_id)
        apiHash = findViewById(R.id.api_hash)
        saveKeys = findViewById(R.id.save_keys)
        configError = findViewById(R.id.config_error)
        groupsCard = findViewById(R.id.groups_card)
        groupsList = findViewById(R.id.groups_list)
        groupsJoin = findViewById(R.id.groups_join)
        groupsSkip = findViewById(R.id.groups_skip)
        groupsError = findViewById(R.id.groups_error)
        stremioCard = findViewById(R.id.stremio_card)
        stremioAdd = findViewById(R.id.stremio_add)
        stremioNote = findViewById(R.id.stremio_note)
        stremioGet = findViewById(R.id.stremio_get)
        stremioOpen = findViewById(R.id.stremio_open)
        stremioError = findViewById(R.id.stremio_error)
        doneCard = findViewById(R.id.done_card)
        doneText = findViewById(R.id.done_text)
        openStremio = findViewById(R.id.open_stremio)
        showGroups = findViewById(R.id.show_groups)
        lanCard = findViewById(R.id.lan_card)
        lanQr = findViewById(R.id.lan_qr)
        lanUrl = findViewById(R.id.lan_url)
        lanAdd = findViewById(R.id.lan_add)
        lanNote = findViewById(R.id.lan_note)
        lanError = findViewById(R.id.lan_error)
        lanQrCaption = findViewById(R.id.lan_qr_caption)
        lanAccountsTitle = findViewById(R.id.lan_accounts_title)
        lanAccounts = findViewById(R.id.lan_accounts)
        batteryCard = findViewById(R.id.battery_card)
        stoppedCard = findViewById(R.id.stopped_card)
        footer = findViewById(R.id.footer)
        accountRow = findViewById(R.id.account_row)
        accountText = findViewById(R.id.account_text)
        accountLogout = findViewById(R.id.account_logout)
    }

    private fun setUpActions() {
        // Telegram login: phone number, then the code Telegram sends to the Telegram app.
        sendPhone.setOnClickListener {
            val number = toInternational(phone.text.toString())
            action("/login/phone", JSONObject().put("phone", number), sendPhone, loginError) {
                code.setText("")
                codeGroup.visibility = View.VISIBLE
                focus(code)
            }
        }
        sendCode.setOnClickListener {
            action("/login/code", JSONObject().put("code", code.text.toString()), sendCode, loginError)
        }
        sendPassword.setOnClickListener {
            action("/password", JSONObject().put("password", password.text.toString()), sendPassword, passwordError) {
                password.setText("")
            }
        }
        onDone(phone, sendPhone)
        onDone(code, sendCode)
        onDone(password, sendPassword)

        // Own API key by hand.
        configSendPhone.setOnClickListener {
            val number = toInternational(configPhone.text.toString())
            action("/config/phone", JSONObject().put("phone", number), configSendPhone, configError) {
                configCodeShown = true
                configCodeGroup.visibility = View.VISIBLE
                focus(configCode)
            }
        }
        configSendCode.setOnClickListener {
            action("/config/code", JSONObject().put("code", configCode.text.toString()), configSendCode, configError)
        }
        findViewById<Button>(R.id.config_manual_toggle).setOnClickListener {
            manualKeys = !manualKeys
            configManualGroup.visibility = if (manualKeys) View.VISIBLE else View.GONE
            if (manualKeys) focus(apiId)
        }
        saveKeys.setOnClickListener {
            val body = JSONObject().put("apiId", apiId.text.toString()).put("apiHash", apiHash.text.toString())
            action("/config/keys", body, saveKeys, configError)
        }

        // Head-start groups.
        groupsJoin.setOnClickListener {
            val links = JSONArray(groupChecks.filterValues { it }.keys.toList())
            action("/groups/join", JSONObject().put("links", links), groupsJoin, groupsError)
        }
        groupsSkip.setOnClickListener { action("/groups/skip", JSONObject(), groupsSkip, groupsError) }
        showGroups.setOnClickListener {
            shownGroups = null
            action("/groups/show", JSONObject(), showGroups, null)
        }

        // Stremio.
        stremioAdd.setOnClickListener {
            action("/stremio/link", JSONObject(), stremioAdd, stremioError) { reply ->
                if (openLink(reply.getString("link"))) stremioOpened = true
                else showError(stremioError, getString(R.string.no_browser))
            }
        }
        stremioGet.setOnClickListener { Stremio.openStoreListing(this) }
        stremioOpen.setOnClickListener { Stremio.open(this) }
        openStremio.setOnClickListener { if (!Stremio.open(this)) Stremio.openStoreListing(this) }

        // Other devices: the main button connects a TV's Stremio account (link
        // login), "Connect a user" and then "Connect another user". Removing is
        // right under each account in the list (renderLanAccounts).
        lanAdd.setOnClickListener { connectTv(lanAdd) }
        findViewById<Button>(R.id.lan_copy).setOnClickListener {
            val url = shownLanUrl ?: return@setOnClickListener
            val clip = ClipData.newPlainText(getString(R.string.app_name), url)
            // The address holds the key: Android 13+ hides it from the clipboard preview.
            if (Build.VERSION.SDK_INT >= 33) {
                clip.description.extras = android.os.PersistableBundle().apply {
                    putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }
            getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
            Toast.makeText(this, R.string.lan_copied, Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.battery_allow).setOnClickListener { requestBatteryExemption() }
        findViewById<Button>(R.id.restart).setOnClickListener {
            AppConfig.setStopped(this, false)
            restartNode()
        }
        findViewById<Button>(R.id.stop).setOnClickListener {
            AlertDialog.Builder(this)
                .setMessage(R.string.stop_confirm)
                .setPositiveButton(R.string.stop) { _, _ ->
                    restartingUntil = 0
                    AppConfig.setStopped(this, true)
                    render(null)
                    Thread { NodeService.stop(applicationContext) }.start()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
        findViewById<Button>(R.id.start).setOnClickListener {
            AppConfig.setStopped(this, false)
            NodeService.start(this)
            render(null)
        }
        accountLogout.setOnClickListener {
            AlertDialog.Builder(this)
                .setMessage(R.string.logout_confirm)
                .setPositiveButton(R.string.logout) { _, _ ->
                    action("/logout", JSONObject(), accountLogout, null) { restartNode() }
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    // ------------------------------------------------------------------------
    // Rendering the polled state.
    // ------------------------------------------------------------------------
    private fun render(polled: JSONObject?) {
        val s = if (System.currentTimeMillis() < restartingUntil) null else polled
        val state = when {
            AppConfig.isStopped(this) -> "stopped"
            s == null -> "offline"
            else -> s.optString("state")
        }
        val cards = listOf(loginCard, passwordCard, configCard, groupsCard, stremioCard, doneCard, lanCard, batteryCard, stoppedCard)
        var visible = setOf<View>()
        val text: String? = when (state) {
            "stopped" -> {
                visible = setOf(stoppedCard)
                null
            }
            "offline", "starting" -> getString(R.string.starting)
            "logging_in" -> getString(R.string.logging_in)
            "starting_addon" -> getString(R.string.starting_addon)
            "waiting_network" -> getString(R.string.waiting_network)
            "need_login" -> {
                visible = setOf(loginCard)
                renderLogin(s!!.optJSONObject("login") ?: JSONObject())
                null
            }
            "need_password" -> {
                visible = setOf(passwordCard)
                renderPassword(s!!)
                null
            }
            "auto_setup" -> getString(
                if (s!!.optString("setupStep") == "switching") R.string.auto_setup_switching
                else R.string.auto_setup_working,
            )
            "need_config" -> {
                visible = setOf(configCard)
                renderConfig(s!!)
            }
            "running" -> {
                visible = renderRunning(s!!)
                runningText(s)
            }
            "error" -> "Something went wrong.\n${s!!.optString("error")}\n\nTap Restart below.\n" +
                "Still not working? Log out and log in again."
            else -> state
        }
        for (card in cards) card.visibility = if (card in visible) View.VISIBLE else View.GONE
        status.text = text ?: ""
        status.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
        // Restart fixes most hiccups; while nothing answers yet it appears only
        // after 30 s (the first start after an install unpacks for a while).
        // Stop is there in every state.
        val silent = state == "offline" || state == "starting"
        if (!silent) silentSince = 0L else if (silentSince == 0L) silentSince = System.currentTimeMillis()
        val restartVisible = !silent || System.currentTimeMillis() - silentSince > 30_000
        footer.visibility = if (state == "stopped") View.GONE else View.VISIBLE
        findViewById<Button>(R.id.restart).visibility = if (restartVisible) View.VISIBLE else View.GONE
        // Who is logged in, and Log out next to it: at the top, easy to find.
        val loggedIn = state == "running" || state == "error"
        accountRow.visibility = if (loggedIn) View.VISIBLE else View.GONE
        if (loggedIn) {
            val name = s?.optStr("ownerName").orEmpty()
            accountText.text = if (name.isNotEmpty()) getString(R.string.account_logged_in, name)
            else getString(R.string.account_logged_in_plain)
        }
        findViewById<Button>(R.id.stop).visibility = View.VISIBLE
    }

    private fun renderLogin(view: JSONObject) {
        codeGroup.visibility = if (view.optStr("step") == "code") View.VISIBLE else View.GONE
        codeText.setText(if (view.optStr("codeVia") == "sms") R.string.code_sent_sms else R.string.code_sent_app)
        setError(loginError, view.optStr("error"))
    }

    private fun renderPassword(s: JSONObject) {
        val hint = s.optStr("hint")
        passwordText.text = getString(R.string.password_intro) + if (hint.isNotBlank()) "\nHint: $hint" else ""
        setError(passwordError, if (s.optBoolean("wrong")) getString(R.string.password_wrong) else "")
    }

    private fun renderConfig(s: JSONObject): String? {
        val step = s.optStr("setupStep")
        if (step == "code_sent") configCodeShown = true
        configCodeGroup.visibility = if (configCodeShown) View.VISIBLE else View.GONE
        configManualGroup.visibility = if (manualKeys) View.VISIBLE else View.GONE
        setError(configError, if (step == "error") s.optStr("setupError") else "")
        return if (step == "reading" || step == "creating") getString(R.string.config_working) else null
    }

    private fun runningText(s: JSONObject): String {
        val results = s.optJSONObject("groups")?.optJSONObject("results")
        val joined = results?.keys()?.asSequence()?.count { results.optJSONObject(it)?.optStr("result") == "joined" } ?: 0
        return "Telemedia is running ✔" + if (joined > 0) "\nJoined $joined group${if (joined > 1) "s" else ""} ✔" else ""
    }

    // Next step after login: groups (if offered), then Stremio, then done.
    private fun renderRunning(s: JSONObject): Set<View> {
        val visible = mutableSetOf<View>()
        val groups = s.optJSONObject("groups") ?: JSONObject()
        val groupsState = groups.optStr("state")
        when {
            groupsState in setOf("loading", "offer", "joining") -> {
                visible += groupsCard
                renderGroups(groups)
            }
            !s.optBoolean("stremioConnected") -> {
                visible += stremioCard
                renderStremio(s.optJSONObject("stremio") ?: JSONObject(), s.optBoolean("stremioAdded"))
            }
            else -> {
                visible += doneCard
                val installed = Stremio.installedPackage(this) != null
                doneText.setText(if (installed) R.string.done_text else R.string.done_no_stremio)
                openStremio.setText(if (installed) R.string.open_stremio else R.string.get_stremio)
                showGroups.visibility = if (s.optInt("groupsCount") > 0) View.VISIBLE else View.GONE
            }
        }
        if (groupsCard !in visible) {
            visible += lanCard
            renderLan(s.optJSONObject("lan") ?: JSONObject())
        }
        if (!ignoringBatteryOptimizations()) {
            visible += batteryCard
            askBatteryOnce()
        }
        return visible
    }

    private fun renderGroups(groups: JSONObject) {
        val state = groups.optStr("state")
        val items = groups.optJSONArray("items") ?: JSONArray()
        val results = groups.optJSONObject("results") ?: JSONObject()
        groupsJoin.isEnabled = state == "offer" && groupsJoin !in inFlight
        if (groupsJoin !in inFlight) groupsJoin.setText(if (state == "joining") R.string.groups_joining else R.string.groups_join)
        groupsSkip.visibility = if (state == "offer") View.VISIBLE else View.GONE
        setError(groupsError, groups.optStr("error"))

        val key = state + items + results
        if (key == shownGroups) return
        shownGroups = key
        groupsList.removeAllViews()
        if (state == "loading") {
            groupsList.addView(TextView(this).apply {
                setText(R.string.groups_loading)
                setTextColor(getColor(R.color.muted))
                textSize = 15f
                setPadding(0, dp(8), 0, dp(8))
            })
            return
        }
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val link = item.getString("link")
            val error = item.optStr("error")
            val joined = item.optBoolean("joined")
            val usable = !joined && error.isEmpty()
            val checked = groupChecks.getOrPut(link) { usable }
            val result = results.optJSONObject(link)
            val outcome = when {
                joined -> "✓ Already a member"
                result?.optStr("result") == "joined" -> "✓ Joined"
                result?.optStr("result") == "already" -> "✓ Already a member"
                result?.optStr("result") == "requested" -> "Request sent. An admin must approve it."
                result != null && result.optStr("error").isNotEmpty() -> "✗ " + result.optStr("error")
                error.isNotEmpty() -> "✗ " + error.replaceFirstChar { it.uppercase() }
                item.optBoolean("approval") -> "An admin must approve new members."
                else -> ""
            }
            groupsList.addView(CheckBox(this).apply {
                text = groupLabel(item, outcome)
                setTextColor(getColor(R.color.fg))
                textSize = 16f
                minHeight = dp(52)
                setPadding(dp(8), dp(10), 0, dp(10))
                buttonTintList = ColorStateList.valueOf(getColor(R.color.accent))
                isChecked = joined || (usable && checked)
                isEnabled = usable && state == "offer"
                setOnCheckedChangeListener { _, on -> groupChecks[link] = on }
            })
        }
    }

    // "Title" in bold, then "12,345 members · Channel · note" and the outcome, smaller.
    private fun groupLabel(item: JSONObject, outcome: String): CharSequence {
        val out = SpannableStringBuilder()
        val title = item.optStr("title").ifEmpty { item.getString("link") }
        out.append(title, StyleSpan(Typeface.BOLD), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        val details = listOfNotNull(
            item.optInt("members").takeIf { it > 0 }?.let { NumberFormat.getIntegerInstance().format(it) + " members" },
            if (item.has("title")) (if (item.optBoolean("channel")) "Channel" else "Group") else null,
            item.optStr("note").ifEmpty { null },
        ).joinToString(" · ")
        for (line in listOf(details, outcome).filter { it.isNotEmpty() }) {
            val start = out.length
            out.append("\n").append(line)
            out.setSpan(RelativeSizeSpan(0.85f), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(ForegroundColorSpan(getColor(R.color.muted)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    private fun renderLan(lan: JSONObject) {
        val url = lan.optStr("url")
        val pairing = lan.optJSONObject("pairing") ?: JSONObject()
        val state = pairing.optStr("state")
        // While connecting: the Stremio link, for the TV owner's own phone.
        val link = if (state == "waiting") pairing.optStr("link") else ""
        val qr = link.ifEmpty { url }
        shownLanUrl = url.ifEmpty { null }
        if (qr != shownLanQr) {
            shownLanQr = qr
            if (qr.isNotEmpty()) lanQr.setImageBitmap(qrBitmap(qr, 600))
        }
        val shown = if (qr.isNotEmpty()) View.VISIBLE else View.GONE
        lanQr.visibility = shown
        lanQrCaption.visibility = shown
        lanUrl.visibility = shown
        lanQrCaption.setText(if (link.isNotEmpty()) R.string.lan_scan_caption else R.string.lan_address_caption)
        lanUrl.text = qr
        val onWifi = url.isNotEmpty()
        val accounts = lan.optJSONArray("accounts") ?: JSONArray()
        lanAccountsNow = accounts
        val connected = accounts.length() > 0
        // Connecting needs the phone's Wi-Fi address (removing works without).
        lanAdd.isEnabled = onWifi && state != "installing" && lanAdd !in inFlight
        if (lanAdd !in inFlight) lanAdd.setText(if (connected) R.string.lan_add_another else R.string.lan_add)
        val doneUser = pairing.optStr("user")
        val stillConnected = (0 until accounts.length()).any { accounts.getJSONObject(it).optStr("user") == doneUser }
        // Problems first; "Connected to …" only while that account is still listed.
        val note = when {
            !onWifi -> getString(R.string.lan_no_wifi)
            state == "installing" -> getString(R.string.stremio_installing)
            state == "waiting" && lanOpened -> getString(R.string.stremio_waiting)
            (0 until accounts.length()).any { accounts.getJSONObject(it).optBoolean("broken") } -> getString(R.string.lan_reconnect)
            !lan.optBoolean("secure") && lan.optJSONObject("tls")?.optStr("state") == "blocked" -> getString(R.string.lan_tls_blocked)
            !lan.optBoolean("secure") -> getString(R.string.lan_tls_waiting)
            state == "done" && stillConnected -> getString(R.string.lan_connected, doneUser.ifEmpty { "the account" })
            else -> ""
        }
        lanNote.text = note
        lanNote.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
        setError(lanError, if (state == "error") "Couldn't connect.\n" + pairing.optStr("error") else "")
        renderLanAccounts(accounts)
    }

    private fun connectTv(button: Button) {
        action("/lan/link", JSONObject(), button, lanError) { reply ->
            if (openLink(reply.getString("link"))) lanOpened = true
            else showError(lanError, getString(R.string.no_browser))
        }
    }

    // One box per connected Stremio account (tagged with its id):
    // "✓ name@gmail.com", right below it that account's own "Remove from
    // Stremio account" button, and its error if a removal failed. Boxes are
    // updated in place, so a background change (a new mark, a new key) never
    // swaps out a button while it is being tapped.
    private fun renderLanAccounts(accounts: JSONArray) {
        val list = (0 until accounts.length()).map { accounts.getJSONObject(it) }
        val ids = list.map { it.optStr("id") }
        removeErrors.keys.retainAll(ids.toSet())
        val key = accounts.toString() + removing.sorted() + removeErrors.toSortedMap()
        if (key == shownAccounts) return
        shownAccounts = key
        lanAccountsTitle.visibility = if (list.isNotEmpty()) View.VISIBLE else View.GONE
        for (i in lanAccounts.childCount - 1 downTo 0) {
            if ((lanAccounts.getChildAt(i).tag as? String) !in ids) lanAccounts.removeViewAt(i)
        }
        for (account in list) {
            val id = account.optStr("id")
            val user = account.optStr("user")
            val mark = when {
                account.optBoolean("broken") -> "⚠"
                account.optBoolean("ok") -> "✓"
                else -> "…"
            }
            val box = lanAccounts.findViewWithTag<View>(id)
                ?: layoutInflater.inflate(R.layout.lan_account_row, lanAccounts, false).also {
                    it.tag = id
                    // Fitted again whenever its width changes: the first layout,
                    // split screen, a resized window. (Not during that layout
                    // pass: a new text size asks for another one.)
                    it.findViewById<TextView>(R.id.lan_account_user)
                        .addOnLayoutChangeListener { v, left, _, right, _, oldLeft, _, oldRight, _ ->
                            if (right > left && right - left != oldRight - oldLeft) v.post { fitOneLine(v as TextView) }
                        }
                    lanAccounts.addView(it)
                }
            // The whole email, kept with its mark; split before the "@" only
            // if it's too long even in small text.
            val name = mark + NO_BREAK_SPACE + user.replace("@", BREAK_HERE + "@")
            box.findViewById<TextView>(R.id.lan_account_user).apply {
                if (text.toString() != name) {
                    text = name
                    fitOneLine(this)
                }
            }
            val busy = id in removing
            val label = getString(if (busy) R.string.please_wait else R.string.lan_remove_main)
            box.findViewById<Button>(R.id.lan_account_remove).apply {
                text = label
                isEnabled = !busy
                contentDescription = "$label: $user"
                setOnClickListener { confirmRemove(id, user) }
            }
            val error = removeErrors[id].orEmpty()
            box.findViewById<TextView>(R.id.lan_account_error).apply {
                text = error
                visibility = if (error.isEmpty()) View.GONE else View.VISIBLE
            }
        }
    }

    /**
     * Shrinks [view]'s text from 16sp (down to 12sp) until it fits on one line.
     * Before its first layout (no width yet) the box's layout listener does it.
     */
    private fun fitOneLine(view: TextView) {
        val room = view.width - view.totalPaddingLeft - view.totalPaddingRight
        if (room <= 0) return
        var sp = 16f
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        while (sp > 12f && view.paint.measureText(view.text, 0, view.text.length) > room) {
            sp -= 0.5f
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        }
    }

    private fun confirmRemove(id: String, user: String) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.lan_remove_confirm, user))
            .setPositiveButton(R.string.lan_remove) { _, _ -> removeAccount(id) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // Takes Telemedia out of that account (/lan/remove). Its button says
    // "Please wait…" until the phone answers; then the box goes away, or says
    // what went wrong.
    private fun removeAccount(id: String) {
        if (!removing.add(id)) return
        removeErrors.remove(id)
        renderLanAccounts(lanAccountsNow)
        Thread {
            val reply = ControlClient.post(applicationContext, "/lan/remove", JSONObject().put("id", id).toString())
            runOnUiThread {
                removing -= id
                if (reply.ok) {
                    // Off the list now; the next status no longer has it either.
                    lanAccountsNow = JSONArray(
                        (0 until lanAccountsNow.length()).map { lanAccountsNow.getJSONObject(it) }
                            .filter { it.optStr("id") != id },
                    )
                    val problem = reply.body.optStr("problem")
                    when {
                        problem.isEmpty() -> Toast.makeText(this, R.string.lan_removed, Toast.LENGTH_LONG).show()
                        // A toast shows only 2 lines (Android 12+): the whole note.
                        !isFinishing && !isDestroyed -> AlertDialog.Builder(this)
                            .setMessage(problem)
                            .setPositiveButton(android.R.string.ok, null)
                            .show()
                        else -> Toast.makeText(applicationContext, problem, Toast.LENGTH_LONG).show()
                    }
                } else {
                    removeErrors[id] = reply.error
                }
                renderLanAccounts(lanAccountsNow)
            }
        }.start()
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
        val pixels = IntArray(size * size) { i -> if (matrix[i % size, i / size]) Color.BLACK else Color.WHITE }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
    }

    // added: Telemedia is in the account confirmed on the web page, but Stremio
    // on this phone hasn't asked for it yet (maybe it uses another account).
    private fun renderStremio(stremio: JSONObject, added: Boolean) {
        val installed = Stremio.installedPackage(this) != null
        val note = when (stremio.optStr("state")) {
            "installing" -> getString(R.string.stremio_installing)
            "waiting" -> if (stremioOpened) getString(R.string.stremio_waiting) else ""
            "error" -> "Couldn't add it yet.\n" + stremio.optStr("error")
            else -> if (added) getString(R.string.stremio_added) else ""
        }
        stremioNote.text = note
        stremioNote.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
        if (stremioAdd !in inFlight) stremioAdd.setText(if (added) R.string.stremio_add_again else R.string.stremio_add)
        stremioOpen.visibility = if (added && installed) View.VISIBLE else View.GONE
        stremioGet.visibility = if (!installed) View.VISIBLE else View.GONE
        setError(stremioError, "")
    }

    // ------------------------------------------------------------------------
    // Helpers.
    // ------------------------------------------------------------------------

    /** POST an action; the button shows "Please wait…" meanwhile, errors go to [error]. */
    private fun action(
        path: String,
        body: JSONObject,
        button: Button?,
        error: TextView?,
        onOk: (JSONObject) -> Unit = {},
    ) {
        error?.let { actionErrors.remove(it); it.visibility = View.GONE }
        if (button != null && button in inFlight) return
        val label = button?.text
        button?.let { inFlight += it }
        button?.isEnabled = false
        button?.setText(R.string.please_wait)
        Thread {
            val reply = ControlClient.post(applicationContext, path, body.toString())
            runOnUiThread {
                button?.let { inFlight -= it }
                button?.isEnabled = true
                button?.text = label
                if (reply.ok) onOk(reply.body) else error?.let { showError(it, reply.error) }
            }
        }.start()
    }

    private fun showError(view: TextView, message: String) {
        actionErrors[view] = message
        setError(view, message)
    }

    /** Shows the last action's error if there is one, else the polled [message]. */
    private fun setError(view: TextView, message: String) {
        val text = actionErrors[view] ?: message
        view.text = text
        view.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun openLink(url: String): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        true
    } catch (e: ActivityNotFoundException) {
        false
    }

    /** "050-123-4567" → "+972501234567" using the SIM's country; numbers with + stay as typed. */
    private fun toInternational(raw: String): String {
        val number = raw.trim()
        if (number.isEmpty() || number.startsWith("+") || number.startsWith("00")) return number
        val tm = getSystemService(TelephonyManager::class.java) ?: return number
        val country = tm.simCountryIso.orEmpty().ifEmpty { tm.networkCountryIso.orEmpty() }.uppercase()
        if (country.isEmpty()) return number
        return PhoneNumberUtils.formatNumberToE164(number, country) ?: number
    }

    private fun focus(field: EditText) {
        field.requestFocus()
        field.post {
            getSystemService(InputMethodManager::class.java)?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun onDone(field: EditText, button: Button) {
        field.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_SEND) {
                if (button.isEnabled) button.performClick()
                true
            } else {
                false
            }
        }
    }

    private fun restartNode() {
        restartingUntil = System.currentTimeMillis() + 3000
        render(null)
        shownGroups = null
        Thread { NodeService.restart(applicationContext) }.start()
    }

    private fun ignoringBatteryOptimizations(): Boolean =
        getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) ?: true

    // Once, when Telemedia first runs: streaming must not stop in the background.
    private fun askBatteryOnce() {
        if (prefs.getBoolean("askedBattery", false)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        requestBatteryExemption()
    }

    private fun requestBatteryExemption() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            )
        } catch (e: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (ignored: ActivityNotFoundException) {
            }
        }
    }

    // Android 13+: the "Telemedia is running" notification needs permission.
    private fun askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33 || prefs.getBoolean("askedNotifications", false)) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** optString without org.json's "null" for JSON null. */
    private fun JSONObject.optStr(name: String): String = if (isNull(name)) "" else optString(name)
}

// Keeps the mark and the email on one line / a place the email may wrap.
private val NO_BREAK_SPACE = Char(0x00A0).toString()
private val BREAK_HERE = Char(0x200B).toString()
