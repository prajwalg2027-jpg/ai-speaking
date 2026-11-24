package com.sakhi.app.net

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Headers.Companion.headersOf
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SakhiApiTest {
    private val server = MockWebServer()
    private lateinit var api: SakhiApi

    @Before fun setUp() { server.start(); api = SakhiApi(OkHttpClient()) { server.url("/").toString() } }
    @After fun tearDown() { server.close() }

    @Test fun `a turn posts the answer and reads the reply`() = runTest {
        server.enqueue(MockResponse.Builder().body(javaClass.classLoader!!.getResource("turn_followup.json")!!.readText()).build())
        val t = api.turn(TurnRequest("s", "answer", "I play cricket", "en-IN", 2.0, Timing(2.0, 1.6, listOf(0.3))))
        val req = server.takeRequest()
        assertEquals("/api/session/turn", req.url.encodedPath)
        val body = req.body!!.utf8()
        assertTrue(body.contains("\"transcript\":\"I play cricket\"") && body.contains("\"pauses\":[0.3]"))
        assertEquals("android", req.headers["x-sakhi-client"])
        assertTrue(t.say.isNotEmpty())
    }

    @Test fun `a turn sent in parts gives Sakhi's reaction first, then the whole turn`() = runTest {
        val turn = javaClass.classLoader!!.getResource("turn_followup.json")!!.readText().replace("\n", " ").trim()
        val whole = """{"part":"turn",""" + turn.removePrefix("{")
        val reply = """{"part":"reply","say":[{"text":"Oh, you play cricket!","lang":"en-IN","pace":1}]}"""
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/x-ndjson; charset=utf-8")).body("$reply\n$whole\n").build())
        val ahead = mutableListOf<List<Line>>()
        val t = api.turn(TurnRequest("s", "answer", "I play cricket")) { ahead += it }
        assertEquals("application/x-ndjson, application/json", server.takeRequest().headers["Accept"])
        assertEquals(listOf(listOf(Line("Oh, you play cricket!", "en-IN", 1.0))), ahead)
        assertTrue(t.say.isNotEmpty() && t.sessionId.isNotEmpty())
    }

    @Test fun `a server that answers in one piece still works, and nothing comes ahead`() = runTest {
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/json")).body(javaClass.classLoader!!.getResource("turn_followup.json")!!.readText()).build())
        var ahead = 0
        val t = api.turn(TurnRequest("s", "answer", "I play cricket")) { ahead++ }
        assertEquals(0, ahead)
        assertTrue(t.say.isNotEmpty())
    }

    @Test fun `a turn that fails after her reaction was sent surfaces as a ServerException`() = runTest {
        val reply = """{"part":"reply","say":[{"text":"Oh!"}]}"""
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/x-ndjson")).body("$reply\n{\"part\":\"error\",\"error\":\"the turn failed\",\"status\":502}\n").build())
        val e = runCatching { api.turn(TurnRequest("s", "answer", "hi")) }.exceptionOrNull()
        assertTrue(e is ServerException && e.status == 502)
        // ... and one cut off before the turn itself arrived.
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/x-ndjson")).body("$reply\n").build())
        assertTrue(runCatching { api.turn(TurnRequest("s", "answer", "hi")) }.exceptionOrNull() is java.io.IOException)
    }

    @Test fun `carrying on a test left midway gives the turn, or null when there is nothing to carry on`() = runTest {
        val turn = javaClass.classLoader!!.getResource("turn_followup.json")!!.readText().trim().removeSuffix("}") + ""","resumed":true,"seq":2}"""
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/json")).body(turn).build())
        val t = api.resumeSession("abc")
        val req = server.takeRequest()
        assertEquals("/api/session/resume", req.url.encodedPath)
        assertEquals("""{"sessionId":"abc"}""", req.body!!.utf8())
        assertTrue(t != null && t.resumed && t.seq == 2)
        server.enqueue(MockResponse.Builder().code(404).body("""{"error":"nothing_to_resume"}""").build())
        assertEquals(null, api.resumeSession(null))
        assertEquals("{}", server.takeRequest().body!!.utf8())
        // A turn carries its number, so one sent twice is answered once.
        server.enqueue(MockResponse.Builder().body(javaClass.classLoader!!.getResource("turn_followup.json")!!.readText()).build())
        api.turn(TurnRequest("s", "skip", seq = 3))
        assertTrue(server.takeRequest().body!!.utf8().contains("\"seq\":3"))
    }

    @Test fun `Sakhi's voice streams as raw PCM with its sample rate`() = runTest {
        val pcm = ByteArray(960) { it.toByte() }
        server.enqueue(MockResponse.Builder().headers(headersOf("x-sample-rate", "22050", "x-tts-cached", "true")).body(Buffer().write(pcm)).build())
        api.speak(SpeakRequest("Hi", "en-IN", 1.0)).use { v ->
            assertEquals(22050, v.sampleRate)
            assertTrue(v.cached)
            assertArrayEquals(pcm, v.body.readBytes())
        }
    }

    @Test(expected = ServerException::class) fun `server errors surface as ServerException`() = runTest {
        server.enqueue(MockResponse.Builder().code(502).body("""{"error":"Upstream timeout"}""").build())
        api.startSession()
    }
}
