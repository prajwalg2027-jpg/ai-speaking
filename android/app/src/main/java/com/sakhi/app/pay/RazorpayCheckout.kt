package com.sakhi.app.pay

import android.app.Activity
import com.razorpay.Checkout
import com.sakhi.app.net.CheckoutStart
import org.json.JSONObject

/**
 * Razorpay Standard Checkout for the first payment of a subscription
 * (https://razorpay.com/docs/payments/payment-gateway/android-integration/standard/integration-steps).
 * The result comes back to the activity, which implements PaymentResultWithDataListener.
 */
object RazorpayCheckout {
    fun preload(activity: Activity) = runCatching { Checkout.preload(activity.applicationContext) }

    fun open(activity: Activity, s: CheckoutStart, colorHex: String) {
        val co = Checkout()
        co.setKeyID(s.keyId)
        co.open(activity, JSONObject().apply {
            put("subscription_id", s.subscriptionId)
            put("name", s.name)
            put("description", s.description)
            put("theme", JSONObject().put("color", colorHex))
            s.contact?.let { put("prefill", JSONObject().put("contact", it)) }
            put("retry", JSONObject().put("enabled", true).put("max_count", 3))
        })
    }

    /** Checkout's "they closed it" code. */
    const val CANCELLED = Checkout.PAYMENT_CANCELED
}
