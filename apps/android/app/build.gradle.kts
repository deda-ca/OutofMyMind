plugins {
    id("com.android.application")
}

android {
    namespace = "dev.jarvis.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.jarvis.phone"
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
        // Every current phone is 64-bit ARM; leaving out the other ABIs keeps ONNX Runtime's native code small.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    androidResources {
        // The voice detection model is read straight from the APK.
        noCompress += "onnx"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // The WebSocket to the Jarvis server (Android has no WebSocket client of its own).
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    // Silero voice detection on the phone (the same model as the web client), so only speech is sent.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.31.0")
}
