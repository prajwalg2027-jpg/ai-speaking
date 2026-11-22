import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Where the app finds the Sakhi server. Debug: local.properties `sakhi.serverUrl` (e.g. your Mac on Wi-Fi).
// Release: the Gradle property / env SAKHI_SERVER_URL (the production HTTPS address).
val localProps = Properties().apply { rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
fun setting(name: String, env: String): String? = (findProperty(name) as String?) ?: System.getenv(env) ?: localProps.getProperty(name)
val debugServer = setting("sakhi.serverUrl", "SAKHI_DEBUG_SERVER_URL") ?: "https://adam-nfgw4g4xwa-el.a.run.app" // the live server; your Mac: local.properties
val releaseServer = setting("sakhi.releaseServerUrl", "SAKHI_SERVER_URL") ?: "https://adam-nfgw4g4xwa-el.a.run.app" // later: https://api.adamspeaks.in

// Truecaller one-tap sign-in: each build has its own client id from Truecaller's developer console (package name
// + signing SHA-1). Not secret. Empty = no Truecaller button (the SMS code only).
val truecallerDebug = setting("truecaller.clientIdDebug", "TRUECALLER_CLIENT_ID_DEBUG").orEmpty()
val truecallerRelease = setting("truecaller.clientId", "TRUECALLER_CLIENT_ID").orEmpty()

// Phone login: the app asks the Adam server for an OTP, and the server sends it with MSG91 (server/login.js).
// Nothing about the SMS provider is in the app.

android {
    namespace = "com.sakhi.app"
    compileSdk = 37

    defaultConfig {
        // The published app ID (permanent once on Google Play). The code package (namespace) stays
        // com.sakhi.app: it is internal, users never see it, and `in` is a reserved word in Kotlin.
        applicationId = "in.adamspeaks.app"
        minSdk = 26
        targetSdk = 36
        versionCode = (findProperty("sakhi.versionCode") as String?)?.toInt() ?: 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The published settings (server address, minimum version): see website/README.md.
        buildConfigField("String", "APP_CONFIG_URL", "\"https://adamspeaks.in/app-config.json\"")
    }

    signingConfigs {
        // Test builds share one signing key (app/debug.keystore, test builds only), so their fingerprint is
        // the same on every machine and in CI (installs update each other).
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // Release signing comes from the environment (CI secrets), never from the repository.
        val store = System.getenv("SAKHI_KEYSTORE_FILE")
        if (store != null) create("release") {
            storeFile = file(store)
            storePassword = System.getenv("SAKHI_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("SAKHI_KEY_ALIAS")
            keyPassword = System.getenv("SAKHI_KEY_PASSWORD")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            buildConfigField("String", "SERVER_URL", "\"$debugServer\"")
            buildConfigField("String", "TRUECALLER_CLIENT_ID", "\"$truecallerDebug\"")
            resValue("string", "truecaller_client_id", truecallerDebug)
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "SERVER_URL", "\"$releaseServer\"")
            buildConfigField("String", "TRUECALLER_CLIENT_ID", "\"$truecallerRelease\"")
            resValue("string", "truecaller_client_id", truecallerRelease)
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures { compose = true; buildConfig = true; resValues = true }

    testOptions { unitTests { isIncludeAndroidResources = true; isReturnDefaultValues = true } }

    lint {
        warningsAsErrors = false
        abortOnError = true
        checkDependencies = true
        disable += setOf("ObsoleteSdkInt", "GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }

    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.truecaller.sdk)
    implementation(libs.androidx.fragment)
    implementation(libs.play.services.auth)
    implementation(libs.razorpay.checkout)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
}
