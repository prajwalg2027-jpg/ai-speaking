package com.sakhi.app.pay

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.CheckoutStart
import com.sakhi.app.net.PayStatus
import com.sakhi.app.net.SakhiApi
import com.sakhi.app.net.ServerException
import com.sakhi.app.net.VerifyPayment
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

/** What the paywall shows after "Start learning". */
sealed interface Paywall {
    data object Hidden : Paywall
    data object Checking : Paywall
    /** Not subscribed: the offer. [busy] while Checkout opens or the payment is being confirmed. */
    data class Offer(val priceInr: Int, val busy: Boolean = false, val error: String? = null) : Paywall
    /** Subscribed (or no subscription needed). [justPaid]: say thank you. */
    data class Subscribed(val paidUntil: String?, val justPaid: Boolean = false, val cancelAtEnd: Boolean = false) : Paywall
    data class Failed(val message: String) : Paywall
}

/**
 * The subscription flow after the score: check whether they're subscribed (the server decides), offer the plan,
 * start a Razorpay subscription, hand it to Checkout ([openCheckout], done by the activity), and have the server
 * confirm the payment before anything unlocks.
 */
class PaywallViewModel(private val api: SakhiApi, private val events: EventLog) : ViewModel() {
    private val _state = MutableStateFlow<Paywall>(Paywall.Hidden)
    val state: StateFlow<Paywall> = _state.asStateFlow()
    private var started: CheckoutStart? = null

    /** "Start learning" on the result screen. */
    fun open() {
        _state.value = Paywall.Checking
        viewModelScope.launch {
            _state.value = try { fromStatus(api.payStatus()) } catch (e: IOException) { Paywall.Failed(OFFLINE) }
            if (_state.value is Paywall.Offer) events.log("paywall.shown")
        }
    }

    /** "Subscribe": the server starts a subscription; [openCheckout] shows Razorpay. */
    fun subscribe(openCheckout: (CheckoutStart) -> Unit) {
        val offer = _state.value as? Paywall.Offer ?: return
        _state.value = offer.copy(busy = true, error = null)
        viewModelScope.launch {
            try {
                val s = api.startRazorpay()
                started = s
                events.log("checkout.opened")
                openCheckout(s)
            } catch (e: ServerException) {
                if (e.error == "already_subscribed") open() else _state.value = offer.copy(busy = false, error = e.reason ?: GENERIC)
            } catch (e: IOException) {
                _state.value = offer.copy(busy = false, error = OFFLINE)
            }
        }
    }

    /** Razorpay says it was paid: the server checks the signature before anything unlocks. */
    fun onPaid(paymentId: String?, signature: String?, subscriptionIdFromCheckout: String?) {
        val s = started
        val offer = _state.value as? Paywall.Offer ?: Paywall.Offer(s?.priceInr ?: 0)
        val subscriptionId = s?.subscriptionId ?: subscriptionIdFromCheckout
        if (paymentId.isNullOrBlank() || signature.isNullOrBlank() || subscriptionId.isNullOrBlank()) {
            _state.value = offer.copy(busy = false, error = NOT_CONFIRMED); return
        }
        _state.value = offer.copy(busy = true, error = null)
        viewModelScope.launch {
            _state.value = try {
                val st = api.verifyRazorpay(VerifyPayment(paymentId, subscriptionId, signature))
                events.log("subscription.started")
                if (st.active) Paywall.Subscribed(st.paidUntil, justPaid = true) else offer.copy(busy = false, error = PROCESSING)
            } catch (e: ServerException) {
                offer.copy(busy = false, error = e.reason ?: NOT_CONFIRMED)
            } catch (e: IOException) {
                // Paid, but we couldn't reach the server: Razorpay's webhook will still record it.
                offer.copy(busy = false, error = PROCESSING)
            }
        }
    }

    /** Razorpay says it didn't go through. [cancelled]: they closed Checkout (no message needed). */
    fun onPayFailed(cancelled: Boolean, description: String?) {
        val offer = _state.value as? Paywall.Offer ?: return
        events.log(if (cancelled) "checkout.cancelled" else "checkout.failed")
        _state.value = offer.copy(busy = false, error = if (cancelled) null else (description?.takeIf { it.isNotBlank() && it.length < 200 } ?: "The payment didn't go through. You haven't been charged."))
    }

    fun dismiss() { _state.value = Paywall.Hidden }

    private val _account = MutableStateFlow<PayStatus?>(null)
    /** The subscription, for the account dialog (null until loaded, or offline). */
    val account: StateFlow<PayStatus?> = _account.asStateFlow()
    fun loadAccount() { viewModelScope.launch { _account.value = try { api.payStatus() } catch (e: IOException) { null } } }

    /** Stop renewing (they keep access until the end of the paid month). → true when done */
    suspend fun cancel(): Boolean = try {
        _account.value = api.cancelSubscription(); events.log("subscription.cancelled"); true
    } catch (e: IOException) { false }

    private fun fromStatus(st: PayStatus): Paywall =
        if (st.required && !st.active) Paywall.Offer(st.priceInr) else Paywall.Subscribed(st.paidUntil, cancelAtEnd = st.cancelAtEnd)

    private companion object {
        const val OFFLINE = "Adam couldn't reach the server. Check your internet and try again."
        const val GENERIC = "Something went wrong. Please try again."
        const val NOT_CONFIRMED = "We couldn't confirm that payment. If money was taken, it will be refunded; please contact us."
        const val PROCESSING = "Your payment is being confirmed. It can take a minute; open this again shortly."
    }
}
