package com.sakhi.app.config

import android.content.Context
import androidx.core.content.edit
import com.sakhi.app.BuildConfig

/**
 * Where the Sakhi server is. The build sets the default (release: production; debug: from local.properties
 * `sakhi.serverUrl`, e.g. your Mac on Wi-Fi). Debug builds can override it in the app (long-press the logo).
 */
class ServerConfig(context: Context) {
    private val prefs = context.getSharedPreferences("sakhi.server", Context.MODE_PRIVATE)

    val default: String = BuildConfig.SERVER_URL
    val canOverride: Boolean = BuildConfig.DEBUG

    var baseUrl: String
        get() = (if (canOverride) prefs.getString(KEY, null) else null) ?: default
        set(value) { prefs.edit { putString(KEY, value.trim().trimEnd('/').ifEmpty { null }) } }

    private companion object { const val KEY = "baseUrl" }
}
