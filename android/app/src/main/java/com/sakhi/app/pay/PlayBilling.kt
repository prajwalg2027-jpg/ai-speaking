package com.sakhi.app.pay

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/**
 * Google Play Billing (https://developer.android.com/google/play/billing/integrate) with user choice billing
 * (https://developer.android.com/google/play/billing/alternative/alternative-billing-with-user-choice-in-app):
 * Play shows its own choice screen, Google Play or Razorpay. The app never decides access: every purchase token goes
 * to the server, which checks it with Google and acknowledges it. One per app (the container holds it).
 */
class PlayBilling(context: Context) : PlayStore {
    private val _results = MutableSharedFlow<PlayResult>(extraBufferCapacity = 4)
    override val results: SharedFlow<PlayResult> = _results.asSharedFlow()
    private var product: ProductDetails? = null
    private val connecting = Mutex()

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases -> _results.tryEmit(outcome(result, purchases)) }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableUserChoiceBilling { details -> _results.tryEmit(PlayResult.ChoseRazorpay(details.externalTransactionToken)) }
        .build()

    private suspend fun connect(): Boolean = connecting.withLock {
        if (client.isReady) return@withLock true
        suspendCancellableCoroutine { c ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) { if (c.isActive) c.resume(result.responseCode == BillingResponseCode.OK) }
                override fun onBillingServiceDisconnected() { if (c.isActive) c.resume(false) }
            })
        }
    }

    override suspend fun ready(productId: String): Boolean {
        if (!connect()) return false
        if (product?.productId == productId) return true
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(BillingClient.ProductType.SUBS).build(),
        )).build()
        product = suspendCancellableCoroutine { c ->
            client.queryProductDetailsAsync(params) { result, found ->
                if (c.isActive) c.resume(if (result.responseCode == BillingResponseCode.OK) found.productDetailsList.firstOrNull() else null)
            }
        }
        return product != null
    }

    override fun buy(activity: Activity, accountId: String): Boolean {
        val p = product ?: return false
        val offers = p.subscriptionOfferDetails.orEmpty()
        val offer = offers.firstOrNull { it.offerId == null } ?: offers.firstOrNull() ?: return false // the base plan
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(p).setOfferToken(offer.offerToken).build()))
            .setObfuscatedAccountId(accountId)
            .build()
        return client.launchBillingFlow(activity, params).responseCode == BillingResponseCode.OK
    }

    override suspend fun owned(): List<String> {
        if (!connect()) return emptyList()
        return suspendCancellableCoroutine { c ->
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, purchases ->
                if (c.isActive) c.resume(if (result.responseCode == BillingResponseCode.OK) purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.map { it.purchaseToken } else emptyList())
            }
        }
    }

    private fun outcome(result: BillingResult, purchases: List<Purchase>?): PlayResult = when (result.responseCode) {
        BillingResponseCode.OK -> purchases.orEmpty().firstOrNull()?.let {
            if (it.purchaseState == Purchase.PurchaseState.PURCHASED) PlayResult.Bought(it.purchaseToken) else PlayResult.Pending
        } ?: PlayResult.Failed(null)
        BillingResponseCode.USER_CANCELED -> PlayResult.Cancelled
        BillingResponseCode.ITEM_ALREADY_OWNED -> PlayResult.AlreadyOwned
        else -> PlayResult.Failed(result.debugMessage)
    }
}
