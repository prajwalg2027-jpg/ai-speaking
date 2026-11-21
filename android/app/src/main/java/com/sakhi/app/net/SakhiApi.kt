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

/** A refused or failed request. [error] is the server's error code (e.g. "consent_required"); [missing] lists consents. */
/** [reason]: the server's sentence for the person, when it gave one. */
class ServerException(message: String, val status: Int = 0, val error: String = "", val missing: List<String> = emptyList(), val reason: String? = null) : IOException(message)

private fun refusal(code: Int, text: String, what: String): ServerException {
    val body = runCatching { SakhiJson.decodeFromString<ErrorBody>(text) }.getOrNull()
    return ServerException("$what (HTTP $code): ${body?.reason ?: body?.error ?: text.take(200)}", code, body?.error.orEmpty(), body?.missing.orEmpty(), body?.reason)
}

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

    // The signed-in customer.
    suspend fun me(): Me = get("/api/me")
    suspend fun saveConsents(list: List<Consent>): MissingConsents = post("/api/me/consents", SakhiJson.encodeToString(ConsentsRequest(list)))
    suspend fun sendEvents(events: List<AppEvent>) { call<kotlinx.serialization.json.JsonObject>(request("/api/events").post(SakhiJson.encodeToString(EventsRequest(events)).toRequestBody(jsonType)).build()) }
    /** Erase everything about this customer (their right under India's data protection law). */
    suspend fun deleteMe() { call<kotlinx.serialization.json.JsonObject>(request("/api/me").delete().build()) }

    // Payments: the learning module's subscription.
    suspend fun payStatus(): PayStatus = get("/api/pay/status")
    suspend fun startRazorpay(): CheckoutStart = post("/api/pay/razorpay/subscription", "{}")
    suspend fun verifyRazorpay(v: VerifyPayment): PayStatus = post("/api/pay/razorpay/verify", SakhiJson.encodeToString(v))
    suspend fun cancelSubscription(): PayStatus = post("/api/pay/cancel", "{}")

    /** Opens Sakhi's voice for one line; the body streams while Bulbul generates it. */
    suspend fun speak(req: SpeakRequest): VoiceStream = withContext(Dispatchers.IO) {
        val res = client.newCall(request("/api/tts/stream").post(SakhiJson.encodeToString(req).toRequestBody(jsonType)).build()).execute()
        if (!res.isSuccessful) { val msg = res.body.string(); res.close(); throw refusal(res.code, msg, "Voice failed") }
        VoiceStream(res.header("x-sample-rate")?.toIntOrNull() ?: 24_000, res.header("x-tts-cached") == "true", res.body.byteStream(), res)
    }

    private fun request(path: String) = Request.Builder().url(baseUrl().trimEnd('/') + path)
        .header("x-sakhi-client", "android").header("x-sakhi-version", com.sakhi.app.BuildConfig.VERSION_NAME)

    private suspend inline fun <reified T> get(path: String): T = call(request(path).get().build())
    private suspend inline fun <reified T> post(path: String, body: String): T = call(request(path).post(body.toRequestBody(jsonType)).build())

    private suspend inline fun <reified T> call(req: Request): T = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw refusal(res.code, text, "Server error")
            SakhiJson.decodeFromString<T>(text)
        }
    }
}
