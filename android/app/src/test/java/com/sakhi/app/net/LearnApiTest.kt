package com.sakhi.app.net

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers.Companion.headersOf
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The learning API against the server's real shapes (server/learning/api.js, runtime.js, lessons.js). */
class LearnApiTest {
    private val server = MockWebServer()
    private lateinit var api: LearnApi

    @Before fun setUp() { server.start(); api = LearnApi(OkHttpClient(), "1.0") { server.url("/").toString() } }
    @After fun tearDown() { server.close() }

    private val done = """{"conversationId":"c1","learnerMessage":{"id":"m1","content":"I goed to market","channel":"text"},
        "reply":{"id":"r1","text":"Nice! What did you buy?","encouragement":null,"followUpQuestion":"What did you buy?"},
        "corrections":[{"id":"k1","original":"goed","corrected":"went","category":"grammar","concept":"irregular_past","explanation":"Go is irregular: went.","severity":"important"}],
        "replayed":false,"meta":{"promptVersion":"tutor-v3"}}""".replace("\n", " ")

    @Test fun `a message streams the reply first, then the checked corrections, then the whole answer`() = runTest {
        val body = "event: reply\ndata: {\"reply\":\"Nice! What did you buy?\",\"encouragement\":null,\"followUpQuestion\":\"What did you buy?\"}\n\n" +
            "event: corrections\ndata: {\"corrections\":[{\"original\":\"goed\",\"corrected\":\"went\"}]}\n\n" +
            "event: done\ndata: $done\n\n"
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "text/event-stream")).body(body).build())
        val order = mutableListOf<String>()
        val r = api.send("c1", SendMessage("I goed to market", "text", "client-1"),
            onReply = { order += "reply:${it.reply}" }, onCorrections = { order += "corrections:${it.size}" })
        assertEquals(listOf("reply:Nice! What did you buy?", "corrections:1"), order)
        assertEquals("went", r.corrections.single().corrected)
        assertEquals("r1", r.reply.id)
        val req = server.takeRequest()
        assertEquals("/api/learn/conversations/c1/messages", req.url.encodedPath)
        assertTrue(req.headers["Accept"]!!.startsWith("text/event-stream"))
        val sent = req.body!!.utf8()
        assertTrue(sent.contains("\"clientMessageId\":\"client-1\"") && sent.contains("\"message\":\"I goed to market\""))
    }

    @Test fun `a plain JSON answer works too, and still calls back`() = runTest {
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "application/json")).body(done).build())
        var replies = 0; var corrections = -1
        val r = api.send("c1", SendMessage("I goed to market"), onReply = { replies++ }, onCorrections = { corrections = it.size })
        assertEquals(1, replies); assertEquals(1, corrections); assertEquals("Nice! What did you buy?", r.reply.text)
    }

    @Test fun `an error event after the reply is a ServerException with the server's sentence`() = runTest {
        val body = "event: error\ndata: {\"status\":502,\"error\":\"Sakhi could not answer just now\",\"reason\":\"Please send that again.\"}\n\n"
        server.enqueue(MockResponse.Builder().headers(headersOf("Content-Type", "text/event-stream")).body(body).build())
        val e = runCatching { api.send("c1", SendMessage("hi")) }.exceptionOrNull()
        assertTrue(e is ServerException && e.status == 502 && e.reason == "Please send that again.")
    }

    @Test fun `no subscription is a 402`() = runTest {
        server.enqueue(MockResponse.Builder().code(402).body("""{"error":"payment_required","reason":"Start learning with Sakhi for ₹299 a month.","priceInr":299}""").build())
        val e = runCatching { api.newConversation() }.exceptionOrNull()
        assertTrue(e is ServerException && e.status == 402 && e.error == "payment_required")
    }

    @Test fun `lessons, a lesson session and an answer`() = runTest {
        val lesson = """{"id":"past-simple-regular","category":"grammar","title":"Talking about yesterday","level":1,"objective":"Use the past simple","version":1,
            "summary":"Add -ed","explanation":"When something happened…","examples":["Yesterday I worked from home."],"exerciseCount":5}"""
        server.enqueue(MockResponse.Builder().body("""{"lessons":[${lesson.dropLast(1)},"progress":{"sessionId":"s1","status":"active","position":2,"correct":1},"completedTimes":0}]}""").build())
        val list = api.lessons()
        assertEquals(2, list.single().progress!!.position)
        val state = """{"sessionId":"s1","status":"active","position":2,"correct":1,"attempts":1,"total":5,"conversationId":"c9","lesson":$lesson,
            "exercise":{"id":"past-simple-regular/2","position":2,"kind":"fill_blank","prompt":"Last Sunday we ___ (play) cricket.","options":null}}"""
        server.enqueue(MockResponse.Builder().body(state).build())
        assertEquals("fill_blank", api.startLesson("past-simple-regular").exercise!!.kind)
        assertEquals("/api/learn/lessons/past-simple-regular/start", server.takeRequest().let { server.takeRequest() }.url.encodedPath)
        server.enqueue(MockResponse.Builder().body("""{"verdict":"incorrect","feedback":"Not quite. Have another look and try again.","corrections":[],"tryAgain":true,"answer":null,"explanation":null,"markedBy":"exact","state":$state,"summary":null}""").build())
        val r = api.answer("s1", AttemptRequest("past-simple-regular/2", "plaied", "text", "a1"))
        assertTrue(r.tryAgain); assertEquals("incorrect", r.verdict)
        assertTrue(server.takeRequest().body!!.utf8().contains("\"exerciseId\":\"past-simple-regular/2\""))
    }

    @Test fun `profile, progress and preferences`() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"name":"Asha","correctionIntensity":"gentle","goals":[],"supportLanguage":"hi-IN","level":2,"placementLevel":2,"levelConfidence":null}""").build())
        assertEquals(2, api.profile().placementLevel)
        server.enqueue(MockResponse.Builder().body("""{"level":2,"placementLevel":2,"levelConfidence":null,"activity":{"messages":12,"conversations":2,"lessonsCompleted":1,"mistakesThisWeek":4,"correctUsesThisWeek":9},
            "skills":[{"concept":"past_simple","category":"grammar","mistakes":3,"correctUses":2,"mastery":0.4,"status":"learning","lastSeenAt":"2026-11-20T10:00:00Z"}],"focus":["past_simple"]}""").build())
        val p = api.progress()
        assertEquals(12, p.activity.messages); assertEquals(listOf("past_simple"), p.focus)
        server.enqueue(MockResponse.Builder().body("""{"ok":true}""").build())
        api.setPreferences(LearnPreferences(correctionIntensity = "strict"))
        server.takeRequest(); server.takeRequest()
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("""{"correctionIntensity":"strict"}""", patch.body!!.utf8())
    }
}
