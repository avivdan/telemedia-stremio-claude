package com.telemedia.tv

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import java.io.File

/**
 * Foreground service that hosts Node. Runs in the ":node" process
 * (see AndroidManifest) because node::Start() can only run once per
 * process — restarting Node means killing this process.
 */
class NodeService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        if (!started) {
            started = true
            // Node's main thread wants a bigger stack than the Java default.
            Thread(null, ::runNode, "node-main", 8L * 1024 * 1024).start()
        }
        return START_STICKY
    }

    private fun runNode() {
        try {
            val project = NodeProject.ensureExtracted(this)
            val code = NodeBridge.startNodeWithArguments(
                arrayOf(
                    "node",
                    File(project, "main.js").absolutePath,
                    AppConfig.file(this).absolutePath,
                ),
            )
            Log.w(TAG, "node exited with code $code")
        } catch (t: Throwable) {
            Log.e(TAG, "node failed to start", t)
        }
        // Node can't be restarted in-process; let the system/UI restart us.
        Process.killProcess(Process.myPid())
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Telemedia addon", NotificationManager.IMPORTANCE_LOW),
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
        val notification = builder
            .setContentTitle("Telemedia addon running")
            .setContentText("http://127.0.0.1:$ADDON_PORT/manifest.json")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
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
        const val ADDON_PORT = 7000
        const val CONTROL_PORT = 7001

        // Per-process flag; only meaningful inside the ":node" process.
        @Volatile
        private var started = false

        fun start(ctx: Context) {
            val intent = Intent(ctx, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        /** Kill the ":node" process (if any) and start a fresh one. Call off the main thread. */
        fun restart(ctx: Context) {
            ControlClient.post("/exit", "")
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
