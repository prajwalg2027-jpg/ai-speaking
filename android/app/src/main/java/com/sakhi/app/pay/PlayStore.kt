package com.sakhi.app.pay

import android.app.Activity
import kotlinx.coroutines.flow.Flow

/** What the paywall needs from Google Play: [PlayBilling] on a phone, a fake in tests. */
interface PlayStore {
    /** Connect to Play and find the subscription product. → true when Play can sell it on this phone. */
    suspend fun ready(productId: String): Boolean
    /**
     * Open Play's purchase screen for the product [ready] found. Under user choice billing, Play first asks the
     * learner: Google Play or Razorpay. [accountId] goes on the purchase, so the server can tell whose it is.
     * The outcome arrives on [results]. → false when it couldn't open.
     */
    fun buy(activity: Activity, accountId: String): Boolean
    /** Purchase tokens of subscriptions Play already holds for this learner (bought, but the server may not know). */
    suspend fun owned(): List<String>
    val results: Flow<PlayResult>
}

/** What happened on Play's screen. */
sealed interface PlayResult {
    data class Bought(val purchaseToken: String) : PlayResult
    /** Paid in a way that completes later (e.g. cash at a shop): access starts when it does. */
    data object Pending : PlayResult
    /** They picked Razorpay on Play's choice screen: [externalToken] is for reporting the payment to Google. */
    data class ChoseRazorpay(val externalToken: String) : PlayResult
    data object Cancelled : PlayResult
    /** Play says they already have it (bought before, the server may not know yet). */
    data object AlreadyOwned : PlayResult
    data class Failed(val message: String?) : PlayResult
}
