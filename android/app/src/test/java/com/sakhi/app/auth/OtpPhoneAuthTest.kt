package com.sakhi.app.auth

import android.app.Activity
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/** Sign-in through the Adam server (which sends the OTP with MSG91), against a fake server. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class OtpPhoneAuthTest {
    private val web = MockWebServer()
    private lateinit var activity: Activity
    private var clock = Instant.parse("2026-11-21T10:00:00Z")
    private lateinit var auth: OtpPhoneAuth

    @Before fun setUp() {
        web.start()
        activity = Robolectric.buildActivity(ComponentActivity::class.java).get()
        val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test.session", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        auth = OtpPhoneAuth(prefs, { web.url("/").toString() }, now = { clock })
    }
    @After fun tearDown() { web.close() }

    private fun reply(code: Int, body: String) = web.enqueue(MockResponse.Builder().code(code).body(body).build())
    private val session = """{"token":"tok-1","expiresAt":"2027-01-20T10:00:00Z","user":{"id":"u-1","phone":"+919876543210"}}"""

    @Test fun `send then verify signs in with the server session`() = runBlocking {
        reply(200, """{"requestId":"r-1","codeLength":6,"resendAfterSec":30,"expiresInSec":600}""")
        assertEquals(CodeResult.Sent("r-1"), auth.sendCode(activity, "+919876543210"))
        val sent = web.takeRequest()
        assertEquals("/api/auth/otp/send", sent.url.encodedPath)
        assertEquals("""{"phone":"+919876543210"}""", sent.body?.utf8())
        assertNull(sent.headers["Authorization"])

        reply(200, session)
        assertEquals(CodeResult.SignedIn, auth.verifyCode("r-1", "424242"))
        assertTrue(web.takeRequest().body!!.utf8().contains(""""code":"424242""""))
        assertEquals(AuthUser("u-1", "+919876543210"), auth.currentUser)
        assertEquals("tok-1", auth.idToken())
    }

    @Test fun `the server's refusals become the reasons the screen explains`() = runBlocking {
        reply(400, """{"error":"invalid_number","reason":"That number doesn’t look right."}""")
        assertEquals(Reason.INVALID_NUMBER, (auth.sendCode(activity, "+911") as CodeResult.Failed).reason)
        reply(429, """{"error":"too_many_requests"}""")
        assertEquals(Reason.TOO_MANY_REQUESTS, (auth.sendCode(activity, "+919876543210") as CodeResult.Failed).reason)
        reply(400, """{"error":"wrong_code"}""")
        assertEquals(Reason.WRONG_CODE, (auth.verifyCode("r-1", "000000") as CodeResult.Failed).reason)
        reply(410, """{"error":"code_expired"}""")
        assertEquals(Reason.CODE_EXPIRED, (auth.verifyCode("r-1", "000000") as CodeResult.Failed).reason)
        web.close()
        assertEquals(Reason.NETWORK, (auth.sendCode(activity, "+919876543210") as CodeResult.Failed).reason)
    }

    @Test fun `the code length comes from the server`() = runBlocking {
        reply(200, """{"requestId":"r-4","codeLength":4}""")
        assertEquals(CodeResult.Sent("r-4", 4), auth.sendCode(activity, "+919000000001"))
        reply(200, """{"ok":true}""")
        assertEquals("a resend keeps it", CodeResult.Sent("r-4", 4), auth.sendCode(activity, "+919000000001", resend = true))
    }

    @Test fun `Truecaller code and verifier go to the server, which signs in`() = runBlocking {
        reply(200, session)
        assertEquals(CodeResult.SignedIn, auth.signInWithTruecaller("tc-code", "v".repeat(50), "client-1"))
        val r = web.takeRequest()
        assertEquals("/api/auth/truecaller", r.url.encodedPath)
        val body = r.body!!.utf8()
        assertTrue(body, body.contains(""""code":"tc-code"""") && body.contains(""""clientId":"client-1"""") && body.contains(""""codeVerifier":""""))
        assertEquals("tok-1", auth.idToken())
        reply(400, """{"error":"truecaller_failed"}""")
        assertEquals(Reason.TRUECALLER_FAILED, (auth.signInWithTruecaller("bad", "v".repeat(50), "client-1") as CodeResult.Failed).reason)
    }

    @Test fun `send again uses the same request`() = runBlocking {
        reply(200, """{"requestId":"r-9"}""")
        auth.sendCode(activity, "+919876543210")
        web.takeRequest()
        reply(200, """{"ok":true}""")
        assertEquals(CodeResult.Sent("r-9"), auth.sendCode(activity, "+919876543210", resend = true))
        val r = web.takeRequest()
        assertEquals("/api/auth/otp/resend", r.url.encodedPath)
        assertEquals("""{"requestId":"r-9"}""", r.body?.utf8())
    }

    @Test fun `the token is refreshed when less than a week is left, and dropped if the server ended it`() = runBlocking {
        reply(200, session); auth.verifyCode("r-1", "424242"); web.takeRequest()
        clock = Instant.parse("2027-01-15T10:00:00Z") // 5 days left
        reply(200, """{"token":"tok-2","expiresAt":"2027-03-16T10:00:00Z"}""")
        assertEquals("tok-2", auth.idToken())
        val r = web.takeRequest()
        assertEquals("/api/auth/refresh", r.url.encodedPath)
        assertEquals("Bearer tok-1", r.headers["Authorization"])
        assertEquals("no second refresh needed", "tok-2", auth.idToken())

        reply(401, """{"error":"login: signed out"}""")
        assertNull(auth.idToken(force = true))
        assertNull(auth.currentUser)
    }

    @Test fun `offline the token in hand is kept while still valid`() = runBlocking {
        reply(200, session); auth.verifyCode("r-1", "424242"); web.takeRequest()
        clock = Instant.parse("2027-01-15T10:00:00Z")
        web.close()
        assertEquals("tok-1", auth.idToken())
    }

    @Test fun `signing out forgets the session and tells the server`() = runBlocking {
        reply(200, session); auth.verifyCode("r-1", "424242"); web.takeRequest()
        reply(200, """{"ok":true}""")
        auth.signOut()
        assertNull(auth.currentUser)
        assertNull(auth.idToken())
        val r = web.takeRequest()
        assertEquals("/api/auth/logout", r.url.encodedPath)
        assertEquals("Bearer tok-1", r.headers["Authorization"])
    }
}
