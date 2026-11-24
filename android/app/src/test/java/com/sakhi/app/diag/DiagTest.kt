package com.sakhi.app.diag

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.sakhi.app.net.SakhiApi
import com.sakhi.app.net.SakhiJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class DiagTest {
    private val web = MockWebServer()
    private lateinit var ctx: Context

    @Before fun setUp() { web.start(); ctx = ApplicationProvider.getApplicationContext(); Diag.clear(); Diag.enabled = false; Diag.session = null }
    @After fun tearDown() { scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel(); web.close(); Diag.clear(); Diag.enabled = false }

    private var signedIn = true
    private val scope = CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
    private fun uploader(spill: File = File(ctx.filesDir, "spill.jsonl")) = DiagUploader(
        { SakhiApi(OkHttpClient()) { web.url("/").toString() } }, scope, { signedIn },
        ctx.getSharedPreferences("diag-test", Context.MODE_PRIVATE), spill, { web.url("/").toString() }, mapOf("model" to "Test phone"))

    @Test fun `events keep their order, data and session; long text is cut`() {
        Diag.session = "s1"
        Diag.log("conv", "answer", "transcript" to "x".repeat(2000), "speechSec" to 2.34567, "end" to Phase.A, "lines" to listOf("Hi", "There"))
        Diag.session = null
        Diag.log("net", "http", "status" to 200)
        val (a, b) = Diag.take(10)
        assertEquals("s1", a["sid"]!!.jsonPrimitive.content)
        val data = a["data"]!!.jsonObject
        assertTrue(data["transcript"]!!.jsonPrimitive.content.length <= Diag.MAX_STRING + 1)
        assertEquals("2.346", data["speechSec"]!!.jsonPrimitive.content)
        assertEquals("A", data["end"]!!.jsonPrimitive.content)
        assertEquals(2, data["lines"]!!.jsonArray.size)
        assertNull(b["sid"])
        assertTrue(b["seq"]!!.jsonPrimitive.int > a["seq"]!!.jsonPrimitive.int)
        assertEquals(0, Diag.size())
    }

    @Test fun `only the newest events are kept, and the gap is said`() {
        repeat(Diag.MAX_PENDING + 7) { Diag.log("t", "e$it") }
        val first = Diag.take(2)
        assertEquals("dropped", first[0]["name"]!!.jsonPrimitive.content)
        assertEquals(7, first[0]["data"]!!.jsonObject["events"]!!.jsonPrimitive.int)
        assertEquals("e7", first[1]["name"]!!.jsonPrimitive.content)
    }

    @Test fun `an error carries its type, message and where it happened`() {
        Diag.error("voice", "failed", java.io.IOException("socket closed"))
        val d = Diag.take(1)[0]["data"]!!.jsonObject
        assertEquals("IOException: socket closed", d["error"]!!.jsonPrimitive.content)
        assertTrue(d["at"]!!.jsonPrimitive.content.contains("DiagTest"))
    }

    @Test fun `requests get an id, the code only on a team phone, and a line with status and time`() {
        web.enqueue(MockResponse.Builder().code(200).body("{}").build())
        web.enqueue(MockResponse.Builder().code(503).body("{}").build())
        val http = OkHttpClient.Builder().addInterceptor(DiagInterceptor { "c".repeat(32) }).build()
        http.newCall(Request.Builder().url(web.url("/api/config?x=secret")).build()).execute().close()
        Diag.enabled = true
        http.newCall(Request.Builder().url(web.url("/api/session")).build()).execute().close()
        val r1 = web.takeRequest(); val r2 = web.takeRequest()
        assertTrue(r1.headers["x-request-id"]!!.length == 16)
        assertNull(r1.headers["x-adam-diag"])
        assertEquals("c".repeat(32), r2.headers["x-adam-diag"])
        val lines = Diag.take(10).map { it["data"]!!.jsonObject }
        assertEquals("/api/config", lines[0]["path"]!!.jsonPrimitive.content) // no query string
        assertEquals(503, lines[1]["status"]!!.jsonPrimitive.int)
        assertEquals(r2.headers["x-request-id"], lines[1]["rid"]!!.jsonPrimitive.content)
    }

    @Test fun `a team phone sends its log; anyone else's is dropped`() = runBlocking {
        val up = uploader()
        assertEquals(32, up.code.length)
        assertTrue(up.link.endsWith("/api/diag/logs/${up.code}"))
        Diag.log("conv", "start")
        Diag.enabled = false
        up.flush()
        assertEquals(0, web.requestCount) // not a team phone: nothing leaves
        Diag.enabled = true
        web.enqueue(MockResponse.Builder().body("""{"saved":1}""").build())
        up.flush()
        val body = SakhiJson.parseToJsonElement(web.takeRequest().body!!.utf8()).jsonObject
        assertEquals(up.code, body["diagId"]!!.jsonPrimitive.content)
        assertEquals("Test phone", body["device"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertEquals("start", body["events"]!!.jsonArray[0].jsonObject["name"]!!.jsonPrimitive.content)
        assertEquals(0, Diag.size())
    }

    @Test fun `a failed send keeps the events; a crash saves them for the next start`() = runBlocking {
        val spill = File(ctx.filesDir, "spill-crash.jsonl").also { it.delete() }
        val up = uploader(spill)
        Diag.enabled = true
        Diag.log("conv", "turn")
        web.enqueue(MockResponse.Builder().code(500).body("{}").build())
        up.flush()
        assertEquals(1, Diag.size())
        up.saveSpill()
        assertEquals(0, Diag.size())
        assertTrue(spill.exists())
        signedIn = false // the sender's loop stays idle
        uploader(spill).start() // restores what was saved, then logs the start
        assertFalse(spill.exists())
        assertTrue(Diag.size() >= 2)
    }

    private enum class Phase { A }
}
