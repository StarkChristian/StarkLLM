plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.starkllm.app"
    // the current AndroidX libraries need 37 to compile; the app keeps the behaviour of Android 16 (targetSdk)
    compileSdk = 37

    defaultConfig {
        applicationId = "com.starkllm.app"
        minSdk = 29
        targetSdk = 36
        versionCode = 4
        versionName = "0.4.0"
    }

    // Debug builds only: one fixed test key (password "android", Android's usual debug key), so that a test build from
    // CI installs over the one before. The store version is signed with the owner's own key (Play App Signing).
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // the app has the languages of the desktop app (frontend/src/i18n)
    androidResources {
        localeFilters += listOf("en", "de", "es", "fr", "it", "tr")
    }

    // Robolectric runs the screens' tests on the JVM, with the app's resources and real drawing (screenshots)
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                test.systemProperty("robolectric.graphicsMode", "NATIVE")
                test.systemProperty("screens.out", layout.buildDirectory.dir("outputs/screens").get().asFile.absolutePath)
                test.maxHeapSize = "2g"
            }
        }
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)
    implementation(libs.biometric)
    implementation(libs.fragment.ktx)
    implementation(libs.work.runtime)
    implementation(libs.window)
    debugImplementation(libs.compose.ui.tooling)
    // the screens' tests (src/test, Robolectric): a test activity in the debug build only
    debugImplementation(libs.compose.ui.test.manifest)
    debugImplementation(libs.fragment.testing.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.core)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.junit)
}
