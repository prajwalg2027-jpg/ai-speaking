package com.sakhi.app.diag

import android.content.SharedPreferences
import android.os.Build
import androidx.core.content.edit
import com.sakhi.app.net.SakhiApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.security.SecureRandom
import java.util.UUID

/**
 * Sends [Diag]'s events to the server (POST /api/diag/logs) every few seconds, on a phone the server says may
 * (GET /api/diag/status: team numbers). The phone's diagnostics code ([code]) names its log: anyone with the
 * code can read it at [link], for two weeks.
 *
 * Events not sent yet are saved to [spill] when the app crashes, and sent on the next start.
 */
class DiagUploader(
    private val api: () -> SakhiApi?,
    private val scope: CoroutineScope,
    private val signedIn: () -> Boolean,
    private val prefs: SharedPreferences,
    private val spill: File,
    private val baseUrl: () -> String,
    private val device: Map<String, String> = defaultDevice(),
) {
    /** This phone's diagnostics code: 32 hex characters, made once. */
    val code: String = prefs.getString(CODE, null) ?: newCode().also { c -> prefs.edit { putString(CODE, c) } }
    /** Where the log can be read (no login: the code is the key). */
    val link: String get() = baseUrl().trimEnd('/') + "/api/diag/logs/" + code
    /** One id each time the app starts: splits a log into runs. */
    private val run = UUID.randomUUID().toString().take(8)
    private val sending = Mutex()
    private var checkedAt = 0L

    init {
        Diag.enabled = prefs.getBoolean(ENABLED, false) // last known, until the server answers
        if (Diag.enabled) Diag.logcat = true
    }

    fun start() {
        restoreSpill()
        Diag.log("app", "start", "run" to run, "model" to device["model"], "android" to device["android"], "app" to device["app"])
        scope.launch {
            while (true) {
                runCatching { tick() }.onFailure { if (it is CancellationException) throw it }
                delay(if (Diag.enabled) 8_000 else 30_000)
            }
        }
    }

    /** Send now (the app is going to the background). */
    fun flushSoon() { scope.launch { runCatching { flush() } } }

    private suspend fun tick() {
        if (!signedIn()) return
        val now = System.currentTimeMillis()
        if (checkedAt == 0L || now - checkedAt > 10 * 60_000) {
            val api = api() ?: return
            val on = try { api.diagStatus().enabled } catch (e: CancellationException) { throw e } catch (e: Exception) { return }
            checkedAt = now
            if (on != Diag.enabled) prefs.edit { putBoolean(ENABLED, on) }
            Diag.enabled = on
            if (on) { Diag.logcat = true; Diag.log("diag", "on", "code" to code.take(6) + "…") }
        }
        if (Diag.enabled) flush() else if (checkedAt != 0L) Diag.clear()
    }

    suspend fun flush() = sending.withLock {
        if (!Diag.enabled || !signedIn()) return@withLock
        val api = api() ?: return@withLock
        while (Diag.size() > 0) {
            val batch = Diag.take(BATCH)
            if (batch.isEmpty()) break
            val body = buildJsonObject {
                put("diagId", code)
                put("device", JsonObject(device.mapValues { kotlinx.serialization.json.JsonPrimitive(it.value) } + ("run" to kotlinx.serialization.json.JsonPrimitive(run))))
                put("events", JsonArray(batch))
            }
            try { api.sendDiag(body.toString()) } catch (e: Exception) { Diag.putBack(batch); if (e is CancellationException) throw e; return@withLock }
        }
    }

    /** The app is crashing or leaving: keep what hasn't been sent (only on a phone that sends diagnostics). */
    @Synchronized fun saveSpill() {
        if (!Diag.enabled) return
        runCatching {
            val events = Diag.take(Diag.MAX_PENDING)
            if (events.isEmpty()) return
            spill.appendText(events.joinToString("\n", postfix = "\n") { it.toString() })
        }
    }

    private fun restoreSpill() = runCatching {
        if (!spill.exists()) return@runCatching
        val lines = spill.readLines().filter { it.isNotBlank() }.takeLast(Diag.MAX_PENDING)
        spill.delete()
        val events = lines.mapNotNull { runCatching { com.sakhi.app.net.SakhiJson.parseToJsonElement(it) as JsonObject }.getOrNull() }
        Diag.putBack(events)
    }

    /** Crashes: the error goes into the log, which is saved before the app dies. */
    fun catchCrashes() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            Diag.error("app", "crash", e, "thread" to t.name)
            saveSpill()
            previous?.uncaughtException(t, e)
        }
    }

    companion object {
        private const val CODE = "diagCode"
        private const val ENABLED = "diagEnabled"
        private const val BATCH = 400

        fun newCode(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

        fun defaultDevice(): Map<String, String> = mapOf(
            "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "android" to "${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})",
            "app" to "${com.sakhi.app.BuildConfig.VERSION_NAME} (${com.sakhi.app.BuildConfig.VERSION_CODE})${if (com.sakhi.app.BuildConfig.DEBUG) " debug" else ""}",
        )
    }
}
