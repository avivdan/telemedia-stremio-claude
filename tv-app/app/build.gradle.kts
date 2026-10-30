plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.telemedia.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.telemedia.tv"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

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

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideload build: sign with the debug key unless you set up your own.
            signingConfig = signingConfigs.getByName("debug")
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
