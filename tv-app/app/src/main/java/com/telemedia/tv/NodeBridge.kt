package com.telemedia.tv

/** JNI entry into nodejs-mobile. See src/main/cpp/native-lib.cpp. */
object NodeBridge {
    init {
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
    }

    /** Blocks until the Node event loop ends. Callable once per process. */
    external fun startNodeWithArguments(arguments: Array<String>): Int
}
