plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release version from the environment (scripts/release.mjs passes it, e.g.
// "0.1.0"); versionCode = major*10000 + minor*100 + patch so updates always
// increase it.
val appVersionName: String = System.getenv("TELEMEDIA_VERSION")?.removePrefix("v") ?: "0.1.0"
val appVersionCode: Int = appVersionName.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

// Release signing key from the environment (scripts/release.mjs and
// deploy.mjs read it from the signing folder). Without it, builds fall back
// to the debug key, and a phone can't update between debug- and
// release-signed builds without an uninstall.
val releaseKeystore: String? = System.getenv("TELEMEDIA_KEYSTORE")

android {
    namespace = "com.telemedia.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.telemedia.phone"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName

        ndk {
            // Phones: 64-bit ARM, plus 32-bit ARM for older/cheaper models.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("TELEMEDIA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TELEMEDIA_KEY_ALIAS")
                keyPassword = System.getenv("TELEMEDIA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // Compress libnode.so in the APK (extracted at install): a much smaller
    // file to share.
    packaging {
        jniLibs.useLegacyPackaging = true
    }

    sourceSets["main"].apply {
        // nodejs-mobile prebuilt libnode.so per ABI (npm run libnode).
        jniLibs.srcDirs("libnode/bin")
        assets.srcDir(layout.buildDirectory.dir("generated/nodeAssets"))
    }
}

dependencies {
    // QR code of the LAN address, for Stremio on other devices.
    implementation("com.google.zxing:core:3.5.3")
}

// Zip the staged Node project (npm run bundle) into assets.
val nodeStage = rootProject.file("node-staging/nodejs-project")
val zipNodeProject by tasks.registering(Zip::class) {
    from(nodeStage)
    archiveFileName.set("nodejs-project.zip")
    destinationDirectory.set(layout.buildDirectory.dir("generated/nodeAssets"))
}
// Checked here, not in the Zip task: with nothing staged, that task is
// skipped as having no input and its own checks never run.
tasks.named("preBuild") {
    dependsOn(zipNodeProject)
    doFirst {
        if (!nodeStage.resolve("main.js").exists() || !nodeStage.resolve("node_modules/telegram").exists()) {
            throw GradleException("Node project not staged. Run `npm run bundle` first.")
        }
    }
}
