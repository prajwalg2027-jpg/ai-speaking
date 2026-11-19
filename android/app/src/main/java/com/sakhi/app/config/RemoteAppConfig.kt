package com.sakhi.app.config

import androidx.core.content.edit
import com.sakhi.app.net.SakhiJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** adamspeaks.in/app-config.json */
@Serializable
data class AppConfig(val version: Int = 1, val serverUrl: String? = null, val minVersionCode: Int = 0)

/**
 * Reads adamspeaks.in/app-config.json when the app starts: the server's address (so the server can move without
 * an app update) and the oldest app version still supported. The last good copy is remembered, so start-up
 * never waits for it and it works offline; until the first fetch, the built-in address is used.
 */
class RemoteAppConfig(
    private val server: ServerConfig,
    private val versionCode: Int,
    private val url: String,
    private val prefs: android.content.SharedPreferences,
    // Its own plain client: this request must never carry the login token.
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build(),
) {
    private val _updateRequired = MutableStateFlow(versionCode < prefs.getInt(MIN_VERSION, 0))
    /** True when this app is older than the minimum version: the learner is asked to update. */
    val updateRequired: StateFlow<Boolean> = _updateRequired.asStateFlow()

    /** Fetch the config and apply it. Failures keep the last good one. → what was applied, or null */
    suspend fun refresh(): AppConfig? = withContext(Dispatchers.IO) {
        val cfg = runCatching {
            http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                if (!res.isSuccessful) null else SakhiJson.decodeFromString<AppConfig>(res.body.string())
            }
        }.getOrNull() ?: return@withContext null
        apply(cfg)
        cfg
    }

    fun apply(cfg: AppConfig) {
        cfg.serverUrl?.trim()?.trimEnd('/')?.let { if (acceptable(it)) server.published = it }
        prefs.edit { putInt(MIN_VERSION, cfg.minVersionCode) }
        _updateRequired.value = versionCode < cfg.minVersionCode
    }

    companion object {
        private const val MIN_VERSION = "minVersionCode"

        /**
         * Only secure addresses on our domain or Google Cloud Run are accepted, so even a tampered website
         * couldn't send the app (and its login tokens) to someone else's server.
         */
        fun acceptable(address: String): Boolean {
            val u = address.toHttpUrlOrNull() ?: return false
            if (u.scheme != "https") return false
            val h = u.host
            return h == "adamspeaks.in" || h.endsWith(".adamspeaks.in") || h.endsWith(".run.app")
        }
    }
}
