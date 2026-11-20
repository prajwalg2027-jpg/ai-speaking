package com.sakhi.app.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RemoteAppConfigTest {
    private val web = MockWebServer()
    private lateinit var ctx: Context
    private lateinit var server: ServerConfig

    @Before fun setUp() {
        web.start()
        ctx = ApplicationProvider.getApplicationContext()
        server = ServerConfig(ctx)
    }
    @After fun tearDown() { web.close() }

    // A generous timeout: on a busy CI machine the first request (class loading, Robolectric) can pass the app's 5 s.
    private val http = OkHttpClient.Builder().callTimeout(60, TimeUnit.SECONDS).build()
    private fun config(versionCode: Int = 5) = RemoteAppConfig(server, versionCode, web.url("/app-config.json").toString(),
        ctx.getSharedPreferences("test.appconfig", Context.MODE_PRIVATE), http)
    private fun serve(json: String, code: Int = 200) = web.enqueue(MockResponse.Builder().code(code).body(json).build())

    @Test fun `only secure addresses on our domain or Cloud Run`() {
        assertTrue(RemoteAppConfig.acceptable("https://api.adamspeaks.in"))
        assertTrue(RemoteAppConfig.acceptable("https://adamspeaks.in"))
        assertTrue(RemoteAppConfig.acceptable("https://adam-nfgw4g4xwa-el.a.run.app"))
        assertFalse(RemoteAppConfig.acceptable("http://api.adamspeaks.in"), "not https")
        assertFalse(RemoteAppConfig.acceptable("https://evil.example"))
        assertFalse(RemoteAppConfig.acceptable("https://adamspeaks.in.evil.example"))
        assertFalse(RemoteAppConfig.acceptable("https://notadamspeaks.in"))
    }

    @Test fun `the published address is used, without the login token, and remembered`() = runBlocking {
        serve("""{"version":1,"serverUrl":"https://api.adamspeaks.in/","minVersionCode":1}""")
        assertEquals("https://api.adamspeaks.in", config().refresh()?.serverUrl?.trimEnd('/'))
        assertEquals("https://api.adamspeaks.in", server.baseUrl)
        assertNull(web.takeRequest().headers["Authorization"])
        assertEquals("https://api.adamspeaks.in", ServerConfig(ctx).baseUrl, "kept for the next start")
    }

    @Test fun `a foreign address is ignored, and a failed fetch keeps the last good one`() = runBlocking {
        serve("""{"serverUrl":"https://api.adamspeaks.in"}""")
        assertNotNull("the config was fetched", config().refresh())
        serve("""{"serverUrl":"https://evil.example"}""")
        config().refresh()
        assertEquals("https://api.adamspeaks.in", server.baseUrl)
        serve("oops", 500)
        assertNull(config().refresh())
        assertEquals("https://api.adamspeaks.in", server.baseUrl)
    }

    @Test fun `a debug build's manual address still wins`() = runBlocking {
        serve("""{"serverUrl":"https://api.adamspeaks.in"}""")
        assertNotNull("the config was fetched", config().refresh())
        server.baseUrl = "http://192.168.1.20:3000"
        assertEquals("http://192.168.1.20:3000", server.baseUrl)
        server.clearOverride()
        assertEquals("https://api.adamspeaks.in", server.baseUrl)
    }

    @Test fun `an app older than the minimum version is asked to update`() = runBlocking {
        val c = config(versionCode = 5)
        assertFalse(c.updateRequired.value)
        serve("""{"minVersionCode":6}""")
        c.refresh()
        assertTrue(c.updateRequired.value)
        assertTrue(config(versionCode = 5).updateRequired.value, "remembered at the next start, even offline")
        serve("""{"minVersionCode":5}""")
        c.refresh()
        assertFalse(c.updateRequired.value)
    }

    private fun assertFalse(v: Boolean, msg: String) = org.junit.Assert.assertFalse(msg, v)
    private fun assertEquals(a: String, b: String, msg: String) = org.junit.Assert.assertEquals(msg, a, b)
    private fun assertTrue(v: Boolean, msg: String) = org.junit.Assert.assertTrue(msg, v)
}
