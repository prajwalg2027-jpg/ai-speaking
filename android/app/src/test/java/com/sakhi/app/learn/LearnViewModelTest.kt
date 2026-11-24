package com.sakhi.app.learn

import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.LearnApi
import com.sakhi.app.net.VoiceStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers.Companion.headersOf
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class LearnViewModelTest {
    private val server = MockWebServer()
    private lateinit var vm: LearnViewModel
    private var paywalls = 0
    private val voice = FakeVoice()

    class FakeVoice : LearnVoice {
        var recording = false
        override fun startRecording(onLevel: (Float) -> Unit, onFull: () -> Unit): Boolean { recording = true; return true }
        override fun stopRecording(): ByteArray? { recording = false; return ByteArray(44 + 16_000) }
        override fun cancelRecording() { recording = false }
        override suspend fun play(stream: VoiceStream) { stream.close() }
        override fun stopPlaying() {}
    }

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.start()
        vm = LearnViewModel(LearnApi(OkHttpClient()) { server.url("/").toString() }, EventLog({ null }, kotlinx.coroutines.MainScope()) { false }, voice) { paywalls++ }
    }
    @After fun tearDown() { server.close(); Dispatchers.resetMain() }

    private fun reply(body: String, code: Int = 200, type: String = "application/json") =
        server.enqueue(MockResponse.Builder().code(code).headers(headersOf("Content-Type", type)).body(body).build())
    private fun waitFor(ok: (LearnUi) -> Boolean): LearnUi {
        repeat(300) { if (ok(vm.ui.value)) return vm.ui.value; Thread.sleep(10) }
        return vm.ui.value
    }

    private val greeting = """{"conversation":{"id":"c1","mode":"conversation","title":null,"lessonSessionId":null,"messageCount":1},
        "messages":[{"id":"g1","role":"tutor","content":"Hi! I'm Sakhi. What would you like to talk about today?","channel":"text","corrections":[]}]}"""
    private fun answer(text: String, corrections: String = "[]") = "event: reply\ndata: {\"reply\":\"Nice! What did you buy?\"}\n\n" +
        "event: corrections\ndata: {\"corrections\":$corrections}\n\n" +
        "event: done\ndata: {\"conversationId\":\"c1\",\"learnerMessage\":{\"id\":\"m1\",\"content\":\"$text\"},\"reply\":{\"id\":\"r1\",\"text\":\"Nice! What did you buy?\"},\"corrections\":$corrections,\"replayed\":false}\n\n"

    private fun startChat() {
        reply(greeting, 201)
        vm.startPractice()
        val u = waitFor { it.page is LearnPage.Chat && it.chat.items.isNotEmpty() }
        assertEquals("Hi! I'm Sakhi. What would you like to talk about today?", u.chat.items.single().text)
        server.takeRequest()
    }

    @Test fun `practice - Sakhi greets, replies, then the corrections appear under the learner's message`() {
        startChat()
        reply(answer("I goed to market", """[{"original":"goed","corrected":"went","explanation":"Go is irregular."}]"""), type = "text/event-stream")
        vm.send("I goed to market")
        val u = waitFor { it.chat.items.size == 3 && !it.chat.thinking && it.chat.items[1].corrections.isNotEmpty() }
        val (_, you, sakhi) = u.chat.items
        assertFalse(you.fromSakhi); assertTrue(sakhi.fromSakhi)
        assertEquals("went", you.corrections.single().corrected)
        assertFalse(you.checking)
        assertEquals("r1", sakhi.id)
        assertFalse(server.takeRequest().body!!.utf8().contains("\"channel\":\"voice\"")) // text is the server's default
    }

    @Test fun `a failed message can be sent again with the same id`() {
        startChat()
        reply("""{"error":"Sakhi could not answer just now","reason":"Sorry, I lost my train of thought. Please send that again."}""", 502)
        vm.send("Hello Sakhi")
        val failed = waitFor { it.chat.retry != null }
        assertEquals("Sorry, I lost my train of thought. Please send that again.", failed.chat.error)
        assertTrue(failed.chat.items.last().failed)
        val first = server.takeRequest().body!!.utf8()
        reply(answer("Hello Sakhi"), type = "text/event-stream")
        vm.retry()
        val ok = waitFor { it.chat.items.size == 3 && !it.chat.thinking }
        assertFalse(ok.chat.items[1].failed)
        val id = Regex("\"clientMessageId\":\"([^\"]+)\"")
        assertEquals(id.find(first)!!.groupValues[1], id.find(server.takeRequest().body!!.utf8())!!.groupValues[1])
    }

    @Test fun `no subscription opens the paywall`() {
        reply("""{"error":"payment_required","reason":"Start learning with Sakhi for ₹299 a month."}""", 402)
        vm.startPractice()
        val u = waitFor { it.home.error != null }
        assertEquals(1, paywalls)
        assertEquals("Start learning with Sakhi for ₹299 a month.", u.home.error)
        assertEquals(LearnPage.Home, u.page)
    }

    @Test fun `speaking - the recording is written down and sent as a voice message`() {
        startChat()
        vm.micTap()
        assertTrue(voice.recording)
        assertEquals(Mic.Recording, vm.ui.value.chat.mic)
        reply("""{"text":"I went to the market","languageCode":"en-IN","seconds":2.1}""")
        reply(answer("I went to the market"), type = "text/event-stream")
        vm.micTap()
        val u = waitFor { it.chat.items.size == 3 && !it.chat.thinking }
        assertEquals(Mic.Off, u.chat.mic)
        assertTrue(u.chat.items[1].voice)
        assertEquals("/api/learn/voice/transcribe", server.takeRequest().url.encodedPath)
        assertTrue(server.takeRequest().body!!.utf8().contains("\"channel\":\"voice\""))
    }

    private fun state(position: Int, status: String = "active", correct: Int = 0) = """{"sessionId":"s1","status":"$status","position":$position,"correct":$correct,"attempts":0,"total":2,"conversationId":"c9",
        "lesson":{"id":"l1","title":"Talking about yesterday","explanation":"Add -ed.","examples":["I worked."],"exerciseCount":2},
        "exercise":${if (status == "active") """{"id":"l1/$position","position":$position,"kind":"fill_blank","prompt":"Q$position ___"}""" else "null"}}"""

    @Test fun `a lesson - answer, feedback, next, then the summary`() {
        reply(state(1))
        vm.openLesson("l1")
        assertEquals("l1/1", waitFor { it.lesson.state != null }.lesson.state!!.exercise!!.id)
        reply("""{"verdict":"correct","feedback":"Correct!","corrections":[],"tryAgain":false,"state":${state(2, correct = 1)},"summary":null}""")
        vm.answer("walked")
        val fed = waitFor { it.lesson.awaitingNext }
        assertEquals("l1/1", fed.lesson.state!!.exercise!!.id) // the feedback stays with its question
        assertEquals("Correct!", fed.lesson.result!!.feedback)
        vm.next()
        assertEquals("l1/2", vm.ui.value.lesson.state!!.exercise!!.id)
        reply("""{"verdict":"incorrect","feedback":"Not quite.","corrections":[],"tryAgain":false,"answer":"played","state":${state(2, "completed", 1)},"summary":{"correct":1,"total":2}}""")
        vm.answer("plaied")
        assertEquals("played", waitFor { it.lesson.awaitingNext }.lesson.result!!.answer)
        vm.next()
        val done = vm.ui.value.lesson
        assertEquals("completed", done.state!!.status)
        assertNotNull(done.result)
        vm.askAboutLesson()
        assertEquals(LearnPage.Chat("c9", fromLesson = "s1"), vm.ui.value.page)
        assertTrue(vm.back())
        assertEquals(LearnPage.LessonPage("s1"), vm.ui.value.page)
    }

    @Test fun `memory - see it, forget one, forget all after a second tap, switch it off`() {
        reply("""{"enabled":true,"items":[{"id":1,"kind":"fact","content":"Works in a call centre"},{"id":2,"kind":"interest","content":"Likes cricket"}],"conversations":[{"id":"c1","summary":"Talked about cricket."}]}""")
        vm.openMemory()
        var u = waitFor { it.memory.memory != null }
        assertEquals(LearnPage.Memory, u.page)
        assertEquals(2, u.memory.memory!!.items.size)
        server.takeRequest()

        reply("""{"ok":true}""")
        vm.forget(1)
        u = waitFor { it.memory.memory!!.items.size == 1 }
        assertEquals("Likes cricket", u.memory.memory!!.items.single().content)
        assertEquals("DELETE", server.takeRequest().method)

        vm.forgetAll()
        assertTrue("the first tap only asks", vm.ui.value.memory.confirmingForgetAll)
        reply("""{"ok":true}""")
        vm.forgetAll()
        u = waitFor { !it.memory.busy && it.memory.memory!!.items.isEmpty() }
        assertTrue(u.memory.memory!!.conversations.isEmpty())
        assertEquals("/api/learn/memory", server.takeRequest().url.encodedPath)

        reply("""{"ok":true}""")
        vm.setMemoryEnabled(false)
        assertFalse(vm.ui.value.memory.memory!!.enabled)
        assertEquals("""{"memoryEnabled":false}""", server.takeRequest().body!!.utf8())
        assertTrue(vm.back())
        assertEquals(LearnPage.Home, vm.ui.value.page)
    }

    @Test fun `memory - a failed delete puts the item back with the reason`() {
        reply("""{"enabled":true,"items":[{"id":1,"kind":"fact","content":"Works in a call centre"}]}""")
        vm.openMemory()
        waitFor { it.memory.memory != null }
        reply("""{"error":"not found"}""", code = 404)
        vm.forget(1)
        val u = waitFor { it.memory.error != null }
        assertEquals(1, u.memory.memory!!.items.size)
    }
}
