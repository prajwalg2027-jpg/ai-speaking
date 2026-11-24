package com.sakhi.app.pay

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.CheckoutStart
import com.sakhi.app.net.PayStatus
import com.sakhi.app.net.PlayOffer
import com.sakhi.app.net.SakhiApi
import com.sakhi.app.net.ServerException
import com.sakhi.app.net.VerifyPayment
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

/** What the paywall shows after "Start learning". */
sealed interface Paywall {
    data object Hidden : Paywall
    data object Checking : Paywall
    /** Not subscribed: the offer. [busy] while Checkout opens or the payment is being confirmed. [play]: through Google Play's screen. */
    data class Offer(val priceInr: Int, val busy: Boolean = false, val error: String? = null, val play: Boolean = false) : Paywall
    /** Subscribed (or no subscription needed). [justPaid]: say thank you. */
    data class Subscribed(val paidUntil: String?, val justPaid: Boolean = false, val cancelAtEnd: Boolean = false) : Paywall
    data class Failed(val message: String) : Paywall
}

/**
 * The subscription flow after the score: check whether they're subscribed (the server decides), offer the plan, and
 * take the payment; the server confirms it before anything unlocks.
 * - Play builds ([play] can sell the product, and the server takes Play purchases): Play's screen, where the learner
 *   picks Google Play or Razorpay (user choice billing). Play purchases go to the server; picking Razorpay goes on to
 *   Checkout ([checkouts]) with Play's token, so the server can report the payment to Google.
 * - Otherwise (sideloaded test builds): Razorpay directly, through Checkout ([openCheckout], done by the activity).
 */
class PaywallViewModel(private val api: SakhiApi, private val events: EventLog, private val play: PlayStore? = null) : ViewModel() {
    private val _state = MutableStateFlow<Paywall>(Paywall.Hidden)
    val state: StateFlow<Paywall> = _state.asStateFlow()
    private var started: CheckoutStart? = null
    /** Set when this phone buys through Play: the server takes Play purchases and Play can sell the product here. */
    private var playOffer: PlayOffer? = null
    private var priceInr = 0

    private val _checkouts = MutableSharedFlow<CheckoutStart>(extraBufferCapacity = 1)
    /** Razorpay picked on Play's choice screen: the activity opens Checkout for this. */
    val checkouts: SharedFlow<CheckoutStart> = _checkouts.asSharedFlow()

    init { play?.let { p -> viewModelScope.launch { p.results.collect { onPlayResult(it) } } } }

    /** "Start learning" on the result screen. */
    fun open() {
        _state.value = Paywall.Checking
        viewModelScope.launch {
            _state.value = try {
                val st = api.payStatus()
                priceInr = st.priceInr
                playOffer = st.play?.takeIf { o -> play != null && withTimeoutOrNull(PLAY_WAIT_MS) { runCatching { play.ready(o.productId) }.getOrDefault(false) } == true }
                (if (st.required && !st.active) recoverPlay() else null) ?: fromStatus(st)
            } catch (e: IOException) { Paywall.Failed(OFFLINE) }
            if (_state.value is Paywall.Offer) events.log("paywall.shown")
        }
    }

    /**
     * "Subscribe": Play's screen when this phone buys through Play ([openPlay] opens it with the learner's id);
     * otherwise the server starts a Razorpay subscription and [openCheckout] shows Checkout.
     */
    fun subscribe(openPlay: ((accountId: String) -> Boolean)? = null, openCheckout: (CheckoutStart) -> Unit) {
        val offer = _state.value as? Paywall.Offer ?: return
        val p = playOffer
        if (p != null && openPlay != null) {
            _state.value = offer.copy(busy = true, error = null)
            if (openPlay(p.accountId)) { events.log("play.opened"); return }
            playOffer = null // Play couldn't open: Razorpay instead
        }
        startRazorpay(offer, null, openCheckout)
    }

    private fun startRazorpay(offer: Paywall.Offer, playToken: String?, openCheckout: (CheckoutStart) -> Unit) {
        _state.value = offer.copy(busy = true, error = null)
        viewModelScope.launch {
            try {
                val s = api.startRazorpay(playToken)
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
        _state.value = offer.copy(busy = false, error = if (cancelled) null else (description?.takeIf { it.isNotBlank() && it.length < 200 } ?: NOT_THROUGH))
    }

    /** What happened on Play's screen. A purchase is confirmed by the server, never by the app. */
    private suspend fun onPlayResult(r: PlayResult) {
        val offer = _state.value as? Paywall.Offer ?: Paywall.Offer(priceInr, play = true)
        when (r) {
            is PlayResult.Bought -> {
                _state.value = offer.copy(busy = true, error = null)
                _state.value = try {
                    val st = api.verifyPlay(r.purchaseToken)
                    events.log("subscription.started")
                    if (st.active) Paywall.Subscribed(st.paidUntil, justPaid = true) else offer.copy(busy = false, error = PROCESSING)
                } catch (e: ServerException) {
                    offer.copy(busy = false, error = e.reason ?: NOT_CONFIRMED)
                } catch (e: IOException) {
                    offer.copy(busy = false, error = PROCESSING) // Play's notification to the server still records it
                }
            }
            is PlayResult.ChoseRazorpay -> { events.log("play.chose_razorpay"); startRazorpay(offer, r.externalToken) { _checkouts.tryEmit(it) } }
            PlayResult.Pending -> _state.value = offer.copy(busy = false, error = PENDING)
            PlayResult.Cancelled -> { events.log("play.cancelled"); _state.value = offer.copy(busy = false, error = null) }
            PlayResult.AlreadyOwned -> _state.value = recoverPlay() ?: offer.copy(busy = false, error = PROCESSING)
            is PlayResult.Failed -> { events.log("play.failed"); _state.value = offer.copy(busy = false, error = NOT_THROUGH) }
        }
    }

    /** A Play subscription the server may not know about (the app closed before it could say): send it now. */
    private suspend fun recoverPlay(): Paywall? {
        val p = play ?: return null
        if (playOffer == null) return null
        for (token in runCatching { p.owned() }.getOrDefault(emptyList())) {
            val st = try { api.verifyPlay(token) } catch (e: IOException) { continue }
            if (st.active) return Paywall.Subscribed(st.paidUntil, justPaid = true, cancelAtEnd = st.cancelAtEnd)
        }
        return null
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
        if (st.required && !st.active) Paywall.Offer(st.priceInr, play = playOffer != null) else Paywall.Subscribed(st.paidUntil, cancelAtEnd = st.cancelAtEnd)

    private companion object {
        const val OFFLINE = "Adam couldn't reach the server. Check your internet and try again."
        const val GENERIC = "Something went wrong. Please try again."
        const val NOT_CONFIRMED = "We couldn't confirm that payment. If money was taken, it will be refunded; please contact us."
        const val PROCESSING = "Your payment is being confirmed. It can take a minute; open this again shortly."
        const val PENDING = "Your payment is waiting to be completed. Learning opens as soon as it goes through."
        const val NOT_THROUGH = "The payment didn't go through. You haven't been charged."
        /** How long to wait for Google Play to answer before offering Razorpay directly. */
        const val PLAY_WAIT_MS = 5_000L
    }
}
