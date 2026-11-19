package com.sakhi.app.net

import com.sakhi.app.conversation.AnswerCollector
import com.sakhi.app.conversation.AnswerEnd
import com.sakhi.app.conversation.CollectedAnswer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

/**
 * The app's networking against a real Sakhi server (and so Sarvam): opens a conversation, streams Sakhi's
 * first line, sends a recorded answer through the live speech connection exactly as the app does, and sends
 * the turn. Skipped unless SAKHI_E2E_URL is set (e.g. http://127.0.0.1:3000), so normal builds stay offline.
 */
class ServerEndToEndTest {
    private val url = System.getenv("SAKHI_E2E_URL")

    @Test fun `a full turn against the real server`() = runBlocking {
        assumeTrue("set SAKHI_E2E_URL to run", !url.isNullOrBlank())
        val http = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()
        val api = SakhiApi(http) { url!! }
        assertTrue(api.status().ready)

        val opening = api.startSession()
        assertEquals("hi-IN", opening.say.first().lang)
        val voice = api.speak(SpeakRequest(opening.say.first().text, opening.say.first().lang, 1.0, opening.sessionId))
        val bytes = voice.use { it.body.readBytes() }
        assertTrue("got ${bytes.size} bytes of voice", bytes.size > voice.sampleRate) // over half a second of audio

        val live = LiveConnection(http) { url!! }
        val finished = CompletableDeferred<CollectedAnswer>()
        val col = AnswerCollector(System.currentTimeMillis(), autoLanguage = true, out = object : AnswerCollector.Output {
            override fun redetectLanguage() = live.configure(language = "auto")
            override fun requestFinal() = live.finish()
            override fun done(answer: CollectedAnswer) { finished.complete(answer) }
        })
        val lock = Any()
        live.onEvent = { e ->
            val t = System.currentTimeMillis()
            synchronized(lock) {
                when (e.type) {
                    "speech_start" -> col.speechStart(e.idx, t)
                    "partial" -> col.partial(e.idx, e.text.orEmpty())
                    "speech_end" -> col.speechEnd(e.idx, t)
                    "final" -> col.final(e.idx, e.text, e.language, e.languageConfidence, e.speechSec, t)
                    "dropped", "closed" -> col.failed()
                }
            }
        }
        val connected = live.connect(10_000)
        assertTrue("live connection: ${live.lastFailure}", connected)
        live.bind(opening.sessionId)
        live.configure(opening.listen!!.silenceMs, opening.listen!!.language)

        val pcm = wavPcm("answer_free_time.wav")
        val ticker = launch(Dispatchers.Default) { while (!col.finished) { synchronized(lock) { col.tick(System.currentTimeMillis()) }; delay(100) } }
        launch(Dispatchers.IO) {
            val frames = pcm.toList().chunked(320).map { it.toShortArray() } + List(150) { ShortArray(320) } // + 3 s of silence
            for (f in frames) { if (col.finished) break; live.sendPcm(f); delay(10) } // twice real time
        }
        val a = withTimeout(40_000) { finished.await() }
        ticker.cancel()
        live.close()
        println("Heard: \"${a.transcript}\" (${a.language}, ${a.speechSec} s, ${a.end})")
        assertEquals(AnswerEnd.SILENCE, a.end)
        assertTrue(a.transcript.split(" ").size >= 3)

        val next = api.turn(TurnRequest(opening.sessionId, "answer", a.transcript, a.language, a.speechSec))
        println("Sakhi: ${next.say.joinToString(" / ") { it.text }}")
        assertTrue(next.say.isNotEmpty())
        assertEquals(opening.sessionId, next.sessionId)
    }

    private fun wavPcm(name: String): ShortArray {
        val b = javaClass.classLoader!!.getResource(name)!!.readBytes()
        var i = 12
        while (i + 8 <= b.size) {
            val id = String(b, i, 4); val len = ByteBuffer.wrap(b, i + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            if (id == "data") {
                val out = ShortArray(len / 2)
                ByteBuffer.wrap(b, i + 8, len).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(out)
                return out
            }
            i += 8 + len
        }
        error("no data chunk in $name")
    }
}
