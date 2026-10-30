package com.telemedia.tv

import android.content.Context
import java.io.File
import java.util.zip.ZipInputStream

/**
 * Unpacks assets/nodejs-project.zip into filesDir on first run and after
 * every app update. Node can't read straight from the APK.
 */
object NodeProject {
    private const val ASSET = "nodejs-project.zip"

    fun ensureExtracted(ctx: Context): File {
        val dir = File(ctx.filesDir, "nodejs-project")
        val marker = File(ctx.filesDir, "nodejs-project.version")
        val stamp = ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime.toString()

        if (dir.resolve("main.js").exists() && marker.exists() && marker.readText() == stamp) {
            return dir
        }

        dir.deleteRecursively()
        dir.mkdirs()
        val root = dir.canonicalPath + File.separator
        ctx.assets.open(ASSET).use { input ->
            ZipInputStream(input.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val out = File(dir, entry.name)
                    // Zip-slip guard.
                    if (!out.canonicalPath.startsWith(root)) {
                        throw SecurityException("bad zip entry: ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { zip.copyTo(it) }
                    }
                }
            }
        }
        marker.writeText(stamp)
        return dir
    }
}
