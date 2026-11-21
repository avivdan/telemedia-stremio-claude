package com.telemedia.phone

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.util.Log
import java.io.File
import java.security.SecureRandom

/**
 * Foreground service that hosts Node (the addon). Runs in the ":node" process
 * (see AndroidManifest) because node::Start() can only run once per
 * process: restarting Node means killing this process.
 *
 * While a video streams (to Stremio here or on another device), it holds a
 * partial wake lock and a Wi-Fi lock, so serving goes on with the screen off.
 */
class NodeService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // "Stop" in the notification, or stopped meanwhile (e.g. a restart that
        // was under way when the user tapped Stop): stay stopped.
        if (intent?.action == ACTION_STOP || AppConfig.isStopped(this)) {
            if (intent?.action == ACTION_STOP) AppConfig.setStopped(this, true)
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        if (!started) {
            started = true
            // Node's main thread wants a bigger stack than the Java default.
            Thread(null, ::runNode, "node-main", 8L * 1024 * 1024).start()
            Thread(::watchStreams, "stream-watch").apply { isDaemon = true }.start()
        }
        return START_STICKY
    }

    private fun runNode() {
        try {
            val project = NodeProject.ensureExtracted(this)
            // A new secret for the control server at every start: only this app
            // (its own files) knows it, so other apps and web pages can't use it.
            val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
            ControlClient.tokenFile(this).writeText(token)
            // Developer tools put a short-lived token in the app's external
            // folder over adb; only from Android 11, where other apps can't
            // read or write that folder.
            val devDir = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) getExternalFilesDir(null)?.absolutePath else null
            val code = NodeBridge.startNodeWithArguments(
                arrayOf(
                    "node",
                    File(project, "main.js").absolutePath,
                    AppConfig.file(this).absolutePath,
                    token,
                    devDir ?: "",
                ),
            )
            Log.w(TAG, "node exited with code $code")
        } catch (t: Throwable) {
            Log.e(TAG, "node failed to start", t)
        }
        // Node can't be restarted in-process; let the system/UI restart us.
        Process.killProcess(Process.myPid())
    }

    // Stopped (Stop Telemedia): Node can't stop in-process, so end the ":node"
    // process. The service was stopped, not killed, so nothing restarts it.
    override fun onDestroy() {
        try {
            setAwake(false)
        } catch (e: Exception) {
            Log.w(TAG, "release locks", e)
        }
        super.onDestroy()
        Process.killProcess(Process.myPid())
    }

    // Polls the bootstrap for active video transfers (lan.js gateway). A failed
    // poll changes nothing: the locks follow the last real answer.
    private fun watchStreams() {
        while (true) {
            val status = ControlClient.status(this)
            if (status != null) {
                try {
                    setAwake(status.optInt("activeStreams") > 0)
                } catch (e: Exception) {
                    Log.w(TAG, "wake lock", e)
                }
            }
            Thread.sleep(5000)
        }
    }

    // Both locks are made once. While streaming, every poll renews the wake
    // lock's safety timeout; each lock is released on its own.
    @Suppress("DEPRECATION") // WIFI_MODE_FULL_HIGH_PERF: still the one that works with the screen off
    @Synchronized
    private fun setAwake(on: Boolean) {
        val wake = wakeLock ?: getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Telemedia:stream")
            .apply { setReferenceCounted(false) }
            .also { wakeLock = it }
        val wifi = wifiLock ?: applicationContext.getSystemService(WifiManager::class.java)
            ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Telemedia:stream")
            ?.apply { setReferenceCounted(false) }
            ?.also { wifiLock = it }
        if (on) {
            if (!wake.isHeld) Log.i(TAG, "streaming: holding wake and Wi-Fi locks")
            wake.acquire(30 * 60 * 1000L)
            if (wifi != null && !wifi.isHeld) wifi.acquire()
        } else {
            if (wake.isHeld || wifi?.isHeld == true) Log.i(TAG, "no streams: released locks")
            if (wake.isHeld) wake.release()
            if (wifi?.isHeld == true) wifi.release()
        }
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NodeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.notification_stop), stop).build())
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "NodeService"
        private const val CHANNEL = "addon"
        private const val NOTIFICATION_ID = 1
        const val CONTROL_PORT = 7001
        private const val ACTION_STOP = "com.telemedia.phone.STOP"

        // Per-process flag; only meaningful inside the ":node" process.
        @Volatile
        private var started = false

        /** Safe to call often; a start the system refuses (background limits) is logged, not a crash. */
        fun start(ctx: Context) {
            val intent = Intent(ctx, NodeService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } catch (e: IllegalStateException) {
                Log.w(TAG, "could not start the addon service now", e)
            }
        }

        /** "Stop Telemedia": stops the addon until the user starts it again. */
        fun stop(ctx: Context) {
            AppConfig.setStopped(ctx, true)
            ctx.stopService(Intent(ctx, NodeService::class.java))
        }

        /**
         * Kill the ":node" process (if any) and start a fresh one. Call off the
         * main thread. Doesn't touch the stop flag: a Stop tapped meanwhile wins.
         */
        fun restart(ctx: Context) {
            ControlClient.post(ctx, "/exit", "{}", readTimeoutMs = 2000)
            Thread.sleep(800)
            val am = ctx.getSystemService(ActivityManager::class.java)
            am.runningAppProcesses
                ?.firstOrNull { it.processName == "${ctx.packageName}:node" }
                ?.let { Process.killProcess(it.pid) }
            Thread.sleep(700)
            start(ctx)
        }
    }
}
