package com.sakhi.app.pay

import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.CheckoutStart
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class PaywallViewModelTest {
    private val server = MockWebServer()
    private lateinit var vm: PaywallViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.start()
        val api = SakhiApi(OkHttpClient()) { server.url("/").toString() }
        vm = PaywallViewModel(api, EventLog({ null }, kotlinx.coroutines.MainScope()) { false })
    }
    @After fun tearDown() { server.close(); Dispatchers.resetMain() }

    private fun reply(body: String, code: Int = 200) = server.enqueue(MockResponse.Builder().code(code).body(body).build())
    private fun waitFor(ok: (Paywall) -> Boolean): Paywall {
        repeat(300) { if (ok(vm.state.value)) return vm.state.value; Thread.sleep(10) }
        return vm.state.value
    }
    private val notSubscribed = """{"required":true,"active":false,"priceInr":299,"status":null,"provider":null,"paidUntil":null,"cancelAtEnd":false}"""
    private val checkout = """{"subscriptionId":"sub_1","keyId":"rzp_test_1","priceInr":299,"name":"Adam","description":"Learning, monthly","contact":"+919876500000"}"""

    @Test fun `not subscribed, the offer, then Checkout, then the server confirms`() {
        reply(notSubscribed)
        vm.open()
        assertEquals(Paywall.Offer(299), waitFor { it is Paywall.Offer })

        reply(checkout)
        var opened: CheckoutStart? = null
        vm.subscribe { opened = it }
        repeat(300) { if (opened == null) Thread.sleep(10) }
        assertEquals("sub_1", opened?.subscriptionId)
        assertTrue((vm.state.value as Paywall.Offer).busy)
        assertEquals("/api/pay/status", server.takeRequest().target)
        assertEquals("/api/pay/razorpay/subscription", server.takeRequest().target)

        reply("""{"required":true,"active":true,"priceInr":299,"status":"active","provider":"razorpay","paidUntil":"2026-12-21T00:00:00Z","cancelAtEnd":false}""")
        vm.onPaid("pay_1", "sig_1", null)
        val done = waitFor { it is Paywall.Subscribed } as Paywall.Subscribed
        assertTrue(done.justPaid)
        val verify = server.takeRequest()
        assertEquals("/api/pay/razorpay/verify", verify.target)
        // The subscription id is the one the server started, not one from Checkout.
        assertTrue(verify.body!!.utf8().contains("\"subscriptionId\":\"sub_1\""))
    }

    @Test fun `already subscribed, no offer`() {
        reply("""{"required":true,"active":true,"priceInr":299,"status":"active","provider":"razorpay","paidUntil":"2026-12-21T00:00:00Z","cancelAtEnd":true}""")
        vm.open()
        val s = waitFor { it is Paywall.Subscribed } as Paywall.Subscribed
        assertTrue(s.cancelAtEnd)
    }

    @Test fun `payments switched off, straight through`() {
        reply("""{"required":false,"active":false,"priceInr":299,"cancelAtEnd":false}""")
        vm.open()
        assertTrue(waitFor { it is Paywall.Subscribed } is Paywall.Subscribed)
    }

    @Test fun `closing Checkout says nothing, a failed payment says why`() {
        reply(notSubscribed)
        vm.open(); waitFor { it is Paywall.Offer }
        vm.onPayFailed(cancelled = true, description = "Payment cancelled by user")
        assertNull((vm.state.value as Paywall.Offer).error)
        vm.onPayFailed(cancelled = false, description = "Your bank declined this payment")
        assertEquals("Your bank declined this payment", (vm.state.value as Paywall.Offer).error)
    }

    @Test fun `a payment the server can't confirm is not treated as paid`() {
        reply(notSubscribed)
        vm.open(); waitFor { it is Paywall.Offer }
        reply(checkout)
        var opened = false
        vm.subscribe { opened = true }
        repeat(300) { if (!opened) Thread.sleep(10) }
        server.takeRequest(); server.takeRequest()
        reply("""{"error":"payment_not_verified","reason":"We couldn't confirm that payment."}""", 400)
        vm.onPaid("pay_1", "forged", null)
        val o = waitFor { it is Paywall.Offer && !it.busy } as Paywall.Offer
        assertEquals("We couldn't confirm that payment.", o.error)
        // Missing pieces never reach the server.
        vm.onPaid(null, "sig", "sub_1")
        assertTrue((vm.state.value as Paywall.Offer).error != null)
    }

    @Test fun `offline shows a retry`() {
        server.close()
        vm.open()
        assertTrue(waitFor { it is Paywall.Failed } is Paywall.Failed)
    }

    @Test fun `cancelling from the account dialog`() = runBlocking {
        reply("""{"required":true,"active":true,"priceInr":299,"status":"active","provider":"razorpay","paidUntil":"2026-12-21T00:00:00Z","cancelAtEnd":true}""")
        assertTrue(vm.cancel())
        assertEquals("/api/pay/cancel", server.takeRequest().target)
        assertTrue(vm.account.value!!.cancelAtEnd)
    }

    @Test fun `the account line`() {
        assertNull(subscriptionLine(false, null, false))
        assertEquals("Subscribed: renews on 21 Dec 2026.", subscriptionLine(true, "2026-12-20T20:00:00Z", false))
        assertEquals("Subscribed until 21 Dec 2026 (cancelled; it won't renew).", subscriptionLine(true, "2026-12-20T20:00:00Z", true))
    }
}
