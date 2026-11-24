package com.sakhi.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * The learning module's HTTP API (/api/learn, server/learning/api.js): practice conversations with corrections,
 * lessons, progress. Same login and headers as [SakhiApi]. A 402 ([ServerException.status]) means the learner
 * needs a subscription first (the paywall).
 */
class LearnApi(private val client: OkHttpClient, private val version: String = "", private val baseUrl: () -> String) {
    private val jsonType = "application/json".toMediaType()

    suspend fun profile(): LearnProfile = get("/api/learn/profile")
    suspend fun setPreferences(p: LearnPreferences) {
        call<kotlinx.serialization.json.JsonObject>(request("/api/learn/preferences").patch(SakhiJson.encodeToString(p).toRequestBody(jsonType)).build())
    }
    suspend fun progress(): LearnProgress = get("/api/learn/progress")

    suspend fun conversations(): List<ConversationInfo> = get<ConversationList>("/api/learn/conversations").conversations
    /** A new free-practice conversation; it opens with Sakhi's greeting. */
    suspend fun newConversation(title: String? = null): ConversationWithMessages = post("/api/learn/conversations", SakhiJson.encodeToString(NewConversation(title)))
    suspend fun conversation(id: String): ConversationWithMessages = get("/api/learn/conversations/$id")

    /**
     * Sends the learner's message. Sakhi's reply comes first ([onReply], as soon as she has answered); the checked
     * corrections follow ([onCorrections]); the whole result is returned at the end. Safe to retry with the same
     * [SendMessage.clientMessageId]: the server returns the stored answer.
     */
    suspend fun send(
        conversationId: String,
        msg: SendMessage,
        onReply: (EarlyReply) -> Unit = {},
        onCorrections: (List<Correction>) -> Unit = {},
    ): MessageResult = withContext(Dispatchers.IO) {
        val req = request("/api/learn/conversations/$conversationId/messages").header("Accept", "$SSE, application/json")
            .post(SakhiJson.encodeToString(msg).toRequestBody(jsonType)).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw refusal(res.code, res.body.string(), "Practice failed")
            if (res.header("Content-Type")?.startsWith(SSE) != true) {
                return@use SakhiJson.decodeFromString<MessageResult>(res.body.string()).also { onReply(it.early()); onCorrections(it.corrections) }
            }
            // Server-sent events: "event: <name>" and "data: <json>" lines, a blank line after each event.
            val source = res.body.source()
            var event = ""
            val data = StringBuilder()
            var result: MessageResult? = null
            var replied = false
            fun dispatch() {
                val d = data.toString()
                when (event) {
                    "reply" -> { replied = true; onReply(SakhiJson.decodeFromString<EarlyReply>(d)) }
                    "corrections" -> onCorrections(SakhiJson.decodeFromString<CorrectionsEvent>(d).corrections)
                    "done" -> result = SakhiJson.decodeFromString<MessageResult>(d)
                    "error" -> {
                        val o = SakhiJson.parseToJsonElement(d).jsonObject
                        throw refusal(o["status"]?.jsonPrimitive?.intOrNull ?: 500, d, "Practice failed")
                    }
                }
                event = ""; data.clear()
            }
            while (true) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> if (data.isNotEmpty()) dispatch()
                    line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.removePrefix("data:").trimStart()) }
                }
            }
            if (data.isNotEmpty()) dispatch()
            val r = result ?: throw IOException("The server's answer ended before Sakhi's reply was complete")
            if (!replied) onReply(r.early())
            r
        }
    }

    suspend fun lessons(): List<Lesson> = get<LessonList>("/api/learn/lessons").lessons
    /** Starts a lesson, or carries on with the one in progress. */
    suspend fun startLesson(lessonId: String): LessonState = post("/api/learn/lessons/$lessonId/start", "{}")
    suspend fun lessonState(sessionId: String): LessonState = get("/api/learn/lesson-sessions/$sessionId")
    suspend fun answer(sessionId: String, a: AttemptRequest): AttemptResult = post("/api/learn/lesson-sessions/$sessionId/attempts", SakhiJson.encodeToString(a))

    /** A spoken message: 16 kHz mono 16-bit WAV, 30 s at most. */
    suspend fun transcribe(wav: ByteArray): Transcript =
        call(request("/api/learn/voice/transcribe").post(wav.toRequestBody("audio/wav".toMediaType())).build())

    /** Sakhi's voice for one of her own messages; the body streams while it's generated. */
    suspend fun speech(messageId: String): VoiceStream = withContext(Dispatchers.IO) {
        val res = client.newCall(request("/api/learn/messages/$messageId/speech").post("{}".toRequestBody(jsonType)).build()).execute()
        if (!res.isSuccessful) { val msg = res.body.string(); res.close(); throw refusal(res.code, msg, "Voice failed") }
        VoiceStream(res.header("x-sample-rate")?.toIntOrNull() ?: 24_000, res.header("x-tts-cached") == "true", res.body.byteStream(), res)
    }

    private fun MessageResult.early() = EarlyReply(reply.text, reply.encouragement, reply.followUpQuestion)

    private fun request(path: String) = Request.Builder().url(baseUrl().trimEnd('/') + path)
        .header("x-sakhi-client", "android").header("x-sakhi-version", version)

    private suspend inline fun <reified T> get(path: String): T = call(request(path).get().build())
    private suspend inline fun <reified T> post(path: String, body: String): T = call(request(path).post(body.toRequestBody(jsonType)).build())

    private suspend inline fun <reified T> call(req: Request): T = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw refusal(res.code, text, "Server error")
            SakhiJson.decodeFromString<T>(text)
        }
    }

    private companion object { const val SSE = "text/event-stream" }
}
