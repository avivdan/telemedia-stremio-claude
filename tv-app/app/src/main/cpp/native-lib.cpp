// JNI bridge to nodejs-mobile's libnode.
//
// node::Start() blocks for the lifetime of the Node event loop and can only
// be called once per process — NodeService runs in its own ":node" process
// so the app can restart Node by killing that process.

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

static const char *kTag = "TelemediaNode";
static int pipe_stdout[2];
static int pipe_stderr[2];

// Forward one pipe (Node's stdout or stderr) to logcat, line by line.
static void *pump(void *arg) {
    auto *spec = static_cast<std::pair<int, int> *>(arg);
    int fd = spec->first;
    int priority = spec->second;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(priority, kTag, buf);
    }
    return nullptr;
}

static void redirect_stdio_to_logcat() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipe_stdout) == -1 || pipe(pipe_stderr) == -1) return;
    dup2(pipe_stdout[1], STDOUT_FILENO);
    dup2(pipe_stderr[1], STDERR_FILENO);

    static std::pair<int, int> out_spec{pipe_stdout[0], ANDROID_LOG_INFO};
    static std::pair<int, int> err_spec{pipe_stderr[0], ANDROID_LOG_ERROR};
    pthread_t t_out, t_err;
    if (pthread_create(&t_out, nullptr, pump, &out_spec) == 0) pthread_detach(t_out);
    if (pthread_create(&t_err, nullptr, pump, &err_spec) == 0) pthread_detach(t_err);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_telemedia_tv_NodeBridge_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {
    const jsize argc = env->GetArrayLength(arguments);

    // Node requires argv strings to live in one contiguous buffer.
    std::vector<std::string> args;
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto jstr = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *chars = env->GetStringUTFChars(jstr, nullptr);
        args.emplace_back(chars);
        env->ReleaseStringUTFChars(jstr, chars);
        env->DeleteLocalRef(jstr);
        total += args.back().size() + 1;
    }

    // Intentionally never freed: Node keeps pointers into it for the
    // process lifetime.
    char *buffer = new char[total];
    std::vector<char *> argv;
    char *pos = buffer;
    for (const auto &a : args) {
        memcpy(pos, a.c_str(), a.size() + 1);
        argv.push_back(pos);
        pos += a.size() + 1;
    }

    redirect_stdio_to_logcat();
    return jint(node::Start(static_cast<int>(argv.size()), argv.data()));
}
