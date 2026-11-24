package com.sakhi.app.net

import com.sakhi.app.diag.Diag
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The live speech-to-text connection: our server's /api/live relay to Sarvam Realtime (server/live.js).
 * Sends 16 kHz PCM16 frames and small JSON commands; receives utterance events. Events arrive on OkHttp's
 * thread; [onEvent] must hand them over to the conversation's thread.
 */
class LiveConnection(private val client: OkHttpClient, private val baseUrl: () -> String) {
    @Volatile var onEvent: (LiveEvent) -> Unit = {}
    @Volatile var alive = false
        private set
    var lastFailure: String? = null
        private set
    private var ws: WebSocket? = null
    private var sessionId: String? = null

    /** Open the relay; true once Sarvam's session is ready. */
    suspend fun connect(timeoutMs: Long = 6_000): Boolean {
        close()
        val ready = CompletableDeferred<Boolean>()
        val url = baseUrl().trimEnd('/').replaceFirst(Regex("^http"), "ws") + "/api/live"
        val t0 = System.nanoTime()
        val ms = { (System.nanoTime() - t0) / 1_000_000 }
        Diag.log("live", "connect")
        val socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== ws) return
                val e = runCatching { SakhiJson.decodeFromString<LiveEvent>(text) }.getOrNull() ?: return
                when (e.type) {
                    "ready" -> { Diag.log("live", "ready", "ms" to ms()); alive = true; sessionId?.let { bind(it) }; ready.complete(true) }
                    "unavailable" -> { Diag.log("live", "unavailable", "reason" to e.reason, "ms" to ms()); lastFailure = e.reason; ready.complete(false) }
                    "log" -> Diag.log("live", "server_log", "message" to e.message, "code" to e.code)
                    else -> onEvent(e)
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, "closed ($code)")
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Diag.log("live", "socket_failure", "error" to "${t.javaClass.simpleName}: ${t.message}", "http" to response?.code, "current" to (webSocket === ws))
                dropped(webSocket, t.message ?: "connection failed")
            }
            private fun dropped(webSocket: WebSocket, why: String) {
                if (webSocket !== ws) return
                Diag.log("live", "dropped", "why" to why, "wasAlive" to alive, "ms" to ms())
                val wasAlive = alive
                alive = false; lastFailure = why
                ready.complete(false)
                if (wasAlive) onEvent(LiveEvent(type = "dropped", reason = why))
            }
        })
        ws = socket
        val ok = withTimeoutOrNull(timeoutMs) { ready.await() } ?: false
        if (!ok) Diag.log("live", "connect_failed", "why" to (lastFailure ?: "timeout ${timeoutMs} ms"), "ms" to ms())
        if (!ok) { lastFailure = lastFailure ?: "no session from Sarvam within ${timeoutMs / 1000} s"; close() }
        return ok
    }

    suspend fun ensureConnected(): Boolean = alive || connect()

    /** Tell the relay which conversation this audio belongs to (for its cost). */
    fun bind(id: String) { sessionId = id; sendJson(buildJsonObject { put("type", "bind"); put("sessionId", id) }.toString()) }

    fun configure(silenceMs: Int? = null, language: String) {
        Diag.log("live", "configure", "silenceMs" to silenceMs, "language" to language)
        sendJson(buildJsonObject { put("type", "config"); silenceMs?.let { put("silenceMs", it) }; put("language", language) }.toString())
    }

    /** Push silence so Sarvam closes the open utterance now. */
    fun finish() { Diag.log("live", "finish"); sendJson("""{"type":"finish"}""") }

    fun sendPcm(pcm: ShortArray) {
        val buf = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        buf.asShortBuffer().put(pcm)
        ws?.send(buf.array().toByteString())
    }

    private fun sendJson(s: String) { ws?.send(s) }

    fun close() {
        val w = ws; ws = null; alive = false
        if (w != null) Diag.log("live", "close")
        w?.close(1000, null)
    }

}
