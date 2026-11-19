package com.sakhi.app.auth

import android.app.Activity
import androidx.activity.ComponentActivity
import com.sakhi.app.net.SakhiApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
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

/** A phone login that behaves like Firebase, without Google Play services. */
class FakePhoneAuth(var autoRead: Boolean = false) : PhoneAuth {
    override val configured = true
    override var currentUser: AuthUser? = null
    var token = "token-1"
    var sentTo: String? = null
    override suspend fun idToken(force: Boolean) = if (currentUser == null) null else (if (force) "fresh-token" else token)
    override suspend fun sendCode(activity: Activity, phone: String, resend: Boolean): CodeResult {
        sentTo = phone
        if (autoRead) { currentUser = AuthUser("uid-1", phone); return CodeResult.SignedIn }
        return CodeResult.Sent("verif-1")
    }
    override suspend fun verifyCode(verificationId: String, code: String): CodeResult =
        if (code == "123456") { currentUser = AuthUser("uid-1", sentTo); CodeResult.SignedIn } else CodeResult.Failed(Reason.WRONG_CODE, null)
    override fun signOut() { currentUser = null }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuthFlowTest {
    private val server = MockWebServer()
    private lateinit var api: SakhiApi
    private lateinit var activity: Activity

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.start()
        api = SakhiApi(OkHttpClient()) { server.url("/").toString() }
        activity = Robolectric.buildActivity(ComponentActivity::class.java).get()
    }
    @After fun tearDown() { server.close(); Dispatchers.resetMain() }

    private fun events(auth: PhoneAuth) = EventLog({ null }, kotlinx.coroutines.MainScope()) { auth.currentUser != null }
    private fun reply(body: String, code: Int = 200) = server.enqueue(MockResponse.Builder().code(code).body(body).build())
    private fun waitFor(vm: AuthViewModel, ok: (Gate) -> Boolean): Gate {
        repeat(200) { if (ok(vm.gate.value)) return vm.gate.value; Thread.sleep(10) }
        return vm.gate.value
    }

    @Test fun `Indian mobile numbers in any common form`() {
        assertEquals("+919876543210", indianMobile("98765 43210"))
        assertEquals("+919876543210", indianMobile("+91 98765-43210"))
        assertEquals("+919876543210", indianMobile("098765 43210"))
        assertNull(indianMobile("12345 67890")) // mobiles start with 6–9
        assertNull(indianMobile("98765"))
    }

    @Test fun `phone, code, consents, then the conversation`() {
        val auth = FakePhoneAuth()
        val vm = AuthViewModel(auth, api, events(auth))
        assertTrue(vm.gate.value is Gate.Phone)
        vm.onNumber("12345"); vm.sendCode(activity)
        assertEquals("Enter your 10-digit mobile number", (vm.gate.value as Gate.Phone).error)
        vm.onNumber("98765 43210"); vm.sendCode(activity)
        val code = waitFor(vm) { it is Gate.Code } as Gate.Code
        assertEquals("+919876543210", code.phone)
        assertEquals(30, code.resendIn)

        vm.onCode("111111"); vm.verify()
        assertEquals("That code isn't right. Check the SMS and try again.", (waitFor(vm) { (it as? Gate.Code)?.error != null } as Gate.Code).error)

        reply("""{"id":"u1","phone":"+919876543210","missingConsents":["terms","privacy","age_18_plus","recordings"]}""")
        vm.onCode("123456"); vm.verify()
        val consents = waitFor(vm) { it is Gate.Consents } as Gate.Consents
        assertEquals(4, consents.missing.size)
        assertEquals("/api/me", server.takeRequest().url.encodedPath)

        vm.agree(adult = false, terms = true, recordings = true)
        assertEquals("Adam is for people aged 18 or older.", (vm.gate.value as Gate.Consents).error)
        vm.agree(adult = true, terms = true, recordings = false)
        assertEquals("Please tick all the boxes to continue.", (vm.gate.value as Gate.Consents).error)

        reply("""{"missingConsents":[]}""")
        vm.agree(adult = true, terms = true, recordings = true)
        assertEquals(Gate.Ready, waitFor(vm) { it == Gate.Ready })
        val body = server.takeRequest().body!!.utf8()
        for (p in listOf("age_18_plus", "terms", "privacy", "recordings")) assertTrue(body, body.contains("\"purpose\":\"$p\""))
        assertTrue(body.contains("\"version\":\"$CONSENT_VERSION\""))
    }

    @Test fun `when Android reads the SMS itself, there's no code to type`() {
        val auth = FakePhoneAuth(autoRead = true)
        val vm = AuthViewModel(auth, api, events(auth))
        reply("""{"id":"u1","missingConsents":[]}""")
        vm.onNumber("9876543210"); vm.sendCode(activity)
        assertEquals(Gate.Ready, waitFor(vm) { it == Gate.Ready })
    }

    @Test fun `already signed in and agreed goes straight to the conversation, and a later refusal goes back to sign-in`() {
        val auth = FakePhoneAuth().apply { currentUser = AuthUser("uid-1", "+919876543210") }
        reply("""{"id":"u1","missingConsents":[]}""")
        val vm = AuthViewModel(auth, api, events(auth))
        assertEquals(Gate.Ready, waitFor(vm) { it == Gate.Ready })
        vm.onServerRefusal(com.sakhi.app.net.ServerException("x", 403, "consent_required", listOf("recordings")))
        assertEquals(Gate.Consents(listOf("recordings")), vm.gate.value)
        vm.onServerRefusal(com.sakhi.app.net.ServerException("x", 401))
        assertTrue(vm.gate.value is Gate.Phone)
        assertNull(auth.currentUser)
    }

    @Test fun `deleting the account erases on the server and signs out`() {
        val auth = FakePhoneAuth().apply { currentUser = AuthUser("uid-1", "+919876543210") }
        reply("""{"id":"u1","missingConsents":[]}""")
        val vm = AuthViewModel(auth, api, events(auth))
        waitFor(vm) { it == Gate.Ready }
        reply("""{"erased":true,"recordings":3}""")
        assertTrue(runBlocking { vm.deleteAccount() })
        server.takeRequest()
        assertEquals("DELETE", server.takeRequest().method)
        assertEquals("Your account and data have been deleted.", (vm.gate.value as Gate.Phone).note)
    }

    @Test fun `every request carries the login token, refreshed once after a 401`() {
        val auth = FakePhoneAuth().apply { currentUser = AuthUser("uid-1", "+91") }
        val http = OkHttpClient.Builder().addInterceptor(AuthInterceptor(auth)).authenticator(AuthRefresher(auth)).build()
        val authed = SakhiApi(http) { server.url("/").toString() }
        reply("""{"error":"login: token expired"}""", 401)
        reply("""{"id":"u1"}""")
        assertEquals("u1", runBlocking { authed.me() }.id)
        assertEquals("Bearer token-1", server.takeRequest().headers["Authorization"])
        assertEquals("Bearer fresh-token", server.takeRequest().headers["Authorization"])
    }
}
