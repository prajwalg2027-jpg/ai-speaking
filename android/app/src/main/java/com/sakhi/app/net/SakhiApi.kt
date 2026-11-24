package com.sakhi.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    private companion object { const val NDJSON = "application/x-ndjson" }

    suspend fun status(): ServerStatus = get("/api/config")
    suspend fun startSession(): Turn = post("/api/session", "{}")
    /**
     * Sends the learner's turn and returns Sakhi's.
     *
     * The app asks for the turn in parts. A server that can send Sakhi's reaction before the rest of her turn is
     * written does so, and [onReply] is called with those lines at once, so they can be spoken while the rest is
     * still being worked out. The turn returned at the end is whole: its lines begin with the ones given to
     * [onReply]. A server that answers in one piece (an older one, or a turn with nothing to send early) just
     * returns the turn, and [onReply] is never called.
     */
    suspend fun turn(req: TurnRequest, onReply: (List<Line>) -> Unit = {}): Turn = withContext(Dispatchers.IO) {
        val request = request("/api/session/turn").header("Accept", "$NDJSON, application/json")
            .post(SakhiJson.encodeToString(req).toRequestBody(jsonType)).build()
        client.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw refusal(res.code, res.body.string(), "Server error")
            if (res.header("Content-Type")?.startsWith(NDJSON) != true) return@use SakhiJson.decodeFromString<Turn>(res.body.string())
            // One JSON object a line: {"part":"reply","say":[..]} (not always), then {"part":"turn", ..the turn..}.
            val source = res.body.source()
            var turn: Turn? = null
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.isBlank()) continue
                val part = SakhiJson.parseToJsonElement(line).jsonObject
                when (part["part"]?.jsonPrimitive?.content) {
                    "reply" -> onReply(SakhiJson.decodeFromJsonElement<TurnReply>(part).say)
                    "error" -> throw refusal(part["status"]?.jsonPrimitive?.intOrNull ?: 500, line, "Server error")
                    else -> turn = SakhiJson.decodeFromJsonElement<Turn>(part)
                }
            }
            turn ?: throw IOException("The server's answer ended before Sakhi's turn was complete")
        }
    }

    // The signed-in customer.
    suspend fun me(): Me = get("/api/me")
    suspend fun saveConsents(list: List<Consent>): MissingConsents = post("/api/me/consents", SakhiJson.encodeToString(ConsentsRequest(list)))
    suspend fun sendEvents(events: List<AppEvent>) { call<kotlinx.serialization.json.JsonObject>(request("/api/events").post(SakhiJson.encodeToString(EventsRequest(events)).toRequestBody(jsonType)).build()) }
    /** Erase everything about this customer (their right under India's data protection law). */
    suspend fun deleteMe() { call<kotlinx.serialization.json.JsonObject>(request("/api/me").delete().build()) }

    // Payments: the learning module's subscription.
    suspend fun payStatus(): PayStatus = get("/api/pay/status")
    suspend fun startRazorpay(playExternalToken: String? = null): CheckoutStart =
        post("/api/pay/razorpay/subscription", SakhiJson.encodeToString(RazorpayStart(playExternalToken)))
    suspend fun verifyPlay(purchaseToken: String): PayStatus = post("/api/pay/play/verify", SakhiJson.encodeToString(PlayPurchase(purchaseToken)))
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
