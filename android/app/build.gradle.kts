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
val debugServer = setting("sakhi.serverUrl", "SAKHI_DEBUG_SERVER_URL") ?: "http://10.0.2.2:3000" // emulator → host machine
val releaseServer = setting("sakhi.releaseServerUrl", "SAKHI_SERVER_URL") ?: "https://sakhi.example.invalid"

android {
    namespace = "com.sakhi.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.sakhi.app"
        minSdk = 26
        targetSdk = 36
        versionCode = (findProperty("sakhi.versionCode") as String?)?.toInt() ?: 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
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
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "SERVER_URL", "\"$releaseServer\"")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures { compose = true; buildConfig = true }

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
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
}
