package com.sakhi.app.auth

import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.truecaller.android.sdk.oAuth.CodeVerifierUtil
import com.truecaller.android.sdk.oAuth.TcOAuthCallback
import com.truecaller.android.sdk.oAuth.TcOAuthData
import com.truecaller.android.sdk.oAuth.TcOAuthError
import com.truecaller.android.sdk.oAuth.TcSdk
import com.truecaller.android.sdk.oAuth.TcSdkOptions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * Truecaller one-tap sign-in (Truecaller OAuth SDK 3.3). When the Truecaller app is on the phone and signed in,
 * [available] turns true and [start] shows Truecaller's consent sheet; the authorization code and its PKCE
 * verifier go to [onCode], and the Adam server gets the verified number from Truecaller itself
 * (server/truecaller.js). Anyone else uses the SMS code. Create it in the activity's onCreate (it registers for
 * an activity result).
 *
 * [clientId] is this build's Truecaller client id (empty: Truecaller is off and nothing is initialised).
 */
class TruecallerSignIn(
    private val activity: ComponentActivity,
    val clientId: String,
    private val onCode: (code: String, codeVerifier: String) -> Unit,
    private val onFailure: (cancelled: Boolean) -> Unit,
) {
    private val _available = MutableStateFlow(false)
    val available: StateFlow<Boolean> = _available.asStateFlow()
    private var state: String? = null
    private var verifier: String? = null

    private val launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        runCatching { TcSdk.getInstance().onActivityResultObtained(activity, r.resultCode, r.data) }
    }

    private val callback = object : TcOAuthCallback {
        override fun onSdkReady() {
            _available.value = runCatching { TcSdk.getInstance().isOAuthFlowUsable }.getOrDefault(false)
        }
        override fun onSuccess(tcOAuthData: TcOAuthData) {
            val expected = state; val v = verifier
            state = null; verifier = null
            val code = tcOAuthData.authorizationCode
            // The state must be the one this request set (request forgery otherwise).
            if (expected == null || v == null || tcOAuthData.state != expected || code.isNullOrBlank()) onFailure(false)
            else onCode(code, v)
        }
        override fun onFailure(tcOAuthError: TcOAuthError) {
            state = null; verifier = null
            onFailure(tcOAuthError.errorCode in CANCELLED)
        }
        // Only Truecaller users are verified here; everyone else uses the SMS code.
        override fun onVerificationRequired(tcOAuthError: TcOAuthError?) { onFailure(false) }
    }

    /** Set up the SDK (in the background, as Truecaller recommends). Safe to call again. */
    fun init() {
        if (clientId.isBlank()) return
        runCatching {
            TcSdk.clear()
            TcSdk.initAsync(
                TcSdkOptions.Builder(activity, callback)
                    .sdkOptions(TcSdkOptions.OPTION_VERIFY_ONLY_TC_USERS)
                    .footerType(TcSdkOptions.FOOTER_TYPE_ANOTHER_MOBILE_NO) // "use another number" → the SMS code
                    .ctaText(TcSdkOptions.CTA_TEXT_CONTINUE)
                    .loginTextPrefix(TcSdkOptions.LOGIN_TEXT_PREFIX_TO_GET_STARTED)
                    .build(),
            )
        }.onFailure { _available.value = false }
    }

    /** Show Truecaller's consent sheet. */
    fun start() {
        if (!_available.value) return
        try {
            val v = CodeVerifierUtil.generateRandomCodeVerifier()
            val challenge = CodeVerifierUtil.getCodeChallenge(v) ?: return onFailure(false)
            val s = UUID.randomUUID().toString()
            val sdk = TcSdk.getInstance()
            sdk.setOAuthState(s)
            sdk.setOAuthScopes(arrayOf("openid", "phone", "profile"))
            sdk.setCodeChallenge(challenge)
            state = s; verifier = v
            sdk.getAuthorizationCode(activity, launcher)
        } catch (e: Exception) {
            state = null; verifier = null
            onFailure(false)
        }
    }

    fun release() { runCatching { TcSdk.clear() } }

    private companion object {
        /** The person closed the sheet or chose "another number" (Truecaller's error codes 2, 11, 14). */
        val CANCELLED = setOf(2, 11, 14)
    }
}
