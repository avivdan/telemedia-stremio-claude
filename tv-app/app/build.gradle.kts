plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release version from the environment (CI passes the git tag, e.g. "0.3.0");
// versionCode = major*10000 + minor*100 + patch so updates always increase it.
val appVersionName: String = System.getenv("TELEMEDIA_VERSION")?.removePrefix("v") ?: "0.3.0"
val appVersionCode: Int = appVersionName.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

// Release signing key from the environment (CI secrets). Without it, release
// builds fall back to the debug key — fine for local testing, but a device
// can't update between debug- and release-signed builds.
val releaseKeystore: String? = System.getenv("TELEMEDIA_KEYSTORE")

android {
    namespace = "com.telemedia.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.telemedia.tv"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName

        ndk {
            // Many TV boxes are still 32-bit ARM. x86_64 = emulator.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
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

    sourceSets["main"].apply {
        // nodejs-mobile prebuilt libnode.so per ABI (fetched by npm run tv:libnode).
        jniLibs.srcDirs("libnode/bin")
        assets.srcDir(layout.buildDirectory.dir("generated/nodeAssets"))
    }
}

dependencies {
    implementation("com.google.zxing:core:3.5.3")
}

// Zip the staged Node project (npm run tv:bundle) into assets.
val nodeStage = rootProject.file("node-staging/nodejs-project")
val zipNodeProject by tasks.registering(Zip::class) {
    doFirst {
        if (!nodeStage.resolve("main.js").exists()) {
            throw GradleException(
                "Node project not staged. Run `npm run tv:bundle` in the repo root first.",
            )
        }
    }
    from(nodeStage)
    archiveFileName.set("nodejs-project.zip")
    destinationDirectory.set(layout.buildDirectory.dir("generated/nodeAssets"))
}
tasks.named("preBuild") { dependsOn(zipNodeProject) }
