package com.sakhi.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InputStream

class ServerException(message: String, val status: Int = 0) : IOException(message)

/** A streamed voice clip: raw 16-bit mono PCM at [sampleRate]. Close it when done. */
class VoiceStream(val sampleRate: Int, val cached: Boolean, val body: InputStream, private val response: Response) : AutoCloseable {
    override fun close() = response.close()
}

/** The Sakhi server's HTTP API. The server holds the Sarvam key; the app never sees it. */
class SakhiApi(private val client: OkHttpClient, private val baseUrl: () -> String) {
    private val jsonType = "application/json".toMediaType()

    suspend fun status(): ServerStatus = get("/api/config")
    suspend fun startSession(): Turn = post("/api/session", "{}")
    suspend fun turn(req: TurnRequest): Turn = post("/api/session/turn", SakhiJson.encodeToString(req))

    /** Opens Sakhi's voice for one line; the body streams while Bulbul generates it. */
    suspend fun speak(req: SpeakRequest): VoiceStream = withContext(Dispatchers.IO) {
        val res = client.newCall(request("/api/tts/stream").post(SakhiJson.encodeToString(req).toRequestBody(jsonType)).build()).execute()
        if (!res.isSuccessful) { val msg = res.body.string(); res.close(); throw ServerException("Voice failed (HTTP ${res.code}): ${msg.take(200)}", res.code) }
        VoiceStream(res.header("x-sample-rate")?.toIntOrNull() ?: 24_000, res.header("x-tts-cached") == "true", res.body.byteStream(), res)
    }

    private fun request(path: String) = Request.Builder().url(baseUrl().trimEnd('/') + path).header("x-sakhi-client", "android")

    private suspend inline fun <reified T> get(path: String): T = call(request(path).get().build())
    private suspend inline fun <reified T> post(path: String, body: String): T = call(request(path).post(body.toRequestBody(jsonType)).build())

    private suspend inline fun <reified T> call(req: Request): T = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ServerException("Server error (HTTP ${res.code}): ${text.take(200)}", res.code)
            SakhiJson.decodeFromString<T>(text)
        }
    }
}
