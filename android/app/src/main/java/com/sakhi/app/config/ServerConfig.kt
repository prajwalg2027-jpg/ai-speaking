package com.sakhi.app.config

import android.content.Context
import androidx.core.content.edit
import com.sakhi.app.BuildConfig

/**
 * Where the Adam server is. In order of precedence:
 *  1. a debug build's manual override (long-press the logo),
 *  2. the address published in adamspeaks.in/app-config.json (see [RemoteAppConfig]), so the server can
 *     move without an app update,
 *  3. the address built into the app.
 */
class ServerConfig(context: Context) {
    private val prefs = context.getSharedPreferences("sakhi.server", Context.MODE_PRIVATE)

    val default: String = BuildConfig.SERVER_URL
    val canOverride: Boolean = BuildConfig.DEBUG

    /** The address from app-config.json (remembered between starts). */
    var published: String?
        get() = prefs.getString(PUBLISHED, null)
        set(value) { prefs.edit { putString(PUBLISHED, value) } }

    var baseUrl: String
        get() = (if (canOverride) prefs.getString(KEY, null) else null) ?: published ?: default
        set(value) { prefs.edit { putString(KEY, value.trim().trimEnd('/').ifEmpty { null }) } }

    /** Forget the manual override (back to the published or built-in address). */
    fun clearOverride() = prefs.edit { remove(KEY) }

    private companion object {
        const val KEY = "baseUrl"
        const val PUBLISHED = "publishedUrl"
    }
}
