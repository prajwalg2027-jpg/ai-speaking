package com.sakhi.app.pay

import android.app.Activity
import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.CheckoutStart
import com.sakhi.app.net.SakhiApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
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

/** Google Play's screen in the paywall (user choice billing), with a fake Play and a fake server. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class PlayPaywallTest {
    private class FakePlay(var canSell: Boolean = true, var bought: List<String> = emptyList()) : PlayStore {
        val opened = mutableListOf<String>()
        override val results = MutableSharedFlow<PlayResult>(extraBufferCapacity = 4)
        override suspend fun ready(productId: String) = canSell && productId == "learning_monthly"
        override fun buy(activity: Activity, accountId: String): Boolean { opened += accountId; return true }
        override suspend fun owned() = bought
    }

    private val server = MockWebServer()
    private val play = FakePlay()
    private lateinit var vm: PaywallViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.start()
        val api = SakhiApi(OkHttpClient()) { server.url("/").toString() }
        vm = PaywallViewModel(api, EventLog({ null }, kotlinx.coroutines.MainScope()) { false }, play)
    }
    @After fun tearDown() { server.close(); Dispatchers.resetMain() }

    private fun reply(body: String, code: Int = 200) = server.enqueue(MockResponse.Builder().code(code).body(body).build())
    private fun waitFor(ok: (Paywall) -> Boolean): Paywall {
        repeat(300) { if (ok(vm.state.value)) return vm.state.value; Thread.sleep(10) }
        return vm.state.value
    }
    private val notSubscribed = """{"required":true,"active":false,"priceInr":299,"cancelAtEnd":false,"play":{"productId":"learning_monthly","accountId":"user-1"}}"""
    private val subscribed = """{"required":true,"active":true,"priceInr":299,"status":"active","provider":"play","paidUntil":"2026-12-21T00:00:00Z","cancelAtEnd":false}"""

    @Test fun `Play's screen opens with the learner's id, and the server confirms the purchase`() {
        reply(notSubscribed)
        vm.open()
        assertEquals(Paywall.Offer(299, play = true), waitFor { it is Paywall.Offer })
        var checkout = false
        vm.subscribe(openPlay = { id -> play.buy(Activity(), id) }) { checkout = true }
        assertEquals(listOf("user-1"), play.opened)
        assertFalse(checkout)
        assertTrue((vm.state.value as Paywall.Offer).busy)

        reply(subscribed)
        play.results.tryEmit(PlayResult.Bought("token-1"))
        val done = waitFor { it is Paywall.Subscribed } as Paywall.Subscribed
        assertTrue(done.justPaid)
        server.takeRequest()
        val verify = server.takeRequest()
        assertEquals("/api/pay/play/verify", verify.target)
        assertEquals("""{"purchaseToken":"token-1"}""", verify.body!!.utf8())
    }

    @Test fun `Razorpay picked on Play's screen: Checkout opens, and the server gets Play's token`() = runBlocking {
        reply(notSubscribed)
        vm.open(); waitFor { it is Paywall.Offer }
        vm.subscribe(openPlay = { true }) { error("Checkout isn't opened directly") }
        val opened = CompletableDeferred<CheckoutStart>()
        CoroutineScope(Dispatchers.Unconfined).launch { opened.complete(vm.checkouts.first()) }
        reply("""{"subscriptionId":"sub_1","keyId":"rzp_test_1","priceInr":299,"name":"Adam","description":"Learning, monthly"}""")
        play.results.tryEmit(PlayResult.ChoseRazorpay("ext-1"))
        assertEquals("sub_1", withTimeout(3_000) { opened.await() }.subscriptionId)
        server.takeRequest()
        val start = server.takeRequest()
        assertEquals("/api/pay/razorpay/subscription", start.target)
        assertEquals("""{"playExternalToken":"ext-1"}""", start.body!!.utf8())
    }

    @Test fun `a phone Play can't sell on (a test build): Razorpay directly`() {
        play.canSell = false
        reply(notSubscribed)
        vm.open()
        assertEquals(Paywall.Offer(299, play = false), waitFor { it is Paywall.Offer })
        reply("""{"subscriptionId":"sub_1","keyId":"rzp_test_1","priceInr":299,"name":"Adam","description":"Learning, monthly"}""")
        var opened: CheckoutStart? = null
        vm.subscribe(openPlay = { error("Play isn't used") }) { opened = it }
        repeat(300) { if (opened == null) Thread.sleep(10) }
        assertEquals("sub_1", opened?.subscriptionId)
        assertTrue(play.opened.isEmpty())
    }

    @Test fun `bought on Play before, the server didn't know: sent on opening`() {
        play.bought = listOf("token-old")
        reply(notSubscribed)
        reply(subscribed)
        vm.open()
        assertTrue(waitFor { it is Paywall.Subscribed } is Paywall.Subscribed)
        server.takeRequest()
        assertEquals("/api/pay/play/verify", server.takeRequest().target)
    }

    @Test fun `closing Play's screen says nothing; pending says it's waiting`() {
        reply(notSubscribed)
        vm.open(); waitFor { it is Paywall.Offer }
        vm.subscribe(openPlay = { true }) { }
        play.results.tryEmit(PlayResult.Cancelled)
        val o = waitFor { it is Paywall.Offer && !it.busy } as Paywall.Offer
        assertNull(o.error)
        play.results.tryEmit(PlayResult.Pending)
        assertTrue((waitFor { (it as? Paywall.Offer)?.error != null } as Paywall.Offer).error!!.contains("waiting"))
    }
}
