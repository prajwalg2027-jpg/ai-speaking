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
