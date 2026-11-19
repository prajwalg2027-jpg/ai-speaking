package com.sakhi.app.auth

import android.app.Activity
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseOptions
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import com.sakhi.app.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Firebase phone sign-in. Firebase is set up in code from this build's settings (no google-services plugin),
 * so a build without them simply runs without login. On Android, Firebase usually reads the SMS itself, so
 * most people never type the code.
 */
class FirebasePhoneAuth(context: Context) : PhoneAuth {
    private val auth: FirebaseAuth? = if (BuildConfig.FIREBASE_APP_ID.isBlank()) null else {
        val app = FirebaseApp.getApps(context).firstOrNull() ?: FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder()
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .build(),
        )
        FirebaseAuth.getInstance(app).also { it.setLanguageCode("en") }
    }
    private var resendToken: PhoneAuthProvider.ForceResendingToken? = null

    override val configured get() = auth != null
    override val currentUser get() = auth?.currentUser?.let { AuthUser(it.uid, it.phoneNumber) }

    override suspend fun idToken(force: Boolean): String? =
        auth?.currentUser?.getIdToken(force)?.await()?.token

    override suspend fun sendCode(activity: Activity, phone: String, resend: Boolean): CodeResult {
        val a = auth ?: return CodeResult.Failed(Reason.OTHER, "login is not set up in this build")
        return suspendCancellableCoroutine { cont ->
            val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
                override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                    resendToken = token
                    if (cont.isActive) cont.resume(CodeResult.Sent(id))
                }
                override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                    // Android read the SMS (or verified the number instantly): sign in now.
                    a.signInWithCredential(credential).addOnCompleteListener { t ->
                        if (cont.isActive) cont.resume(if (t.isSuccessful) CodeResult.SignedIn else failure(t.exception))
                    }
                }
                override fun onVerificationFailed(e: FirebaseException) { if (cont.isActive) cont.resume(failure(e)) }
            }
            val options = PhoneAuthOptions.newBuilder(a)
                .setPhoneNumber(phone)
                .setTimeout(60L, TimeUnit.SECONDS)
                .setActivity(activity)
                .setCallbacks(callbacks)
                .apply { if (resend) resendToken?.let { setForceResendingToken(it) } }
                .build()
            PhoneAuthProvider.verifyPhoneNumber(options)
        }
    }

    override suspend fun verifyCode(verificationId: String, code: String): CodeResult {
        val a = auth ?: return CodeResult.Failed(Reason.OTHER, null)
        return try {
            a.signInWithCredential(PhoneAuthProvider.getCredential(verificationId, code)).await()
            CodeResult.SignedIn
        } catch (e: Exception) { failure(e) }
    }

    override fun signOut() { auth?.signOut() }

    private fun failure(e: Exception?): CodeResult.Failed = when (e) {
        is FirebaseAuthInvalidCredentialsException ->
            if (e.errorCode == "ERROR_INVALID_PHONE_NUMBER") CodeResult.Failed(Reason.INVALID_NUMBER, e.message)
            else if (e.errorCode == "ERROR_SESSION_EXPIRED") CodeResult.Failed(Reason.CODE_EXPIRED, e.message)
            else CodeResult.Failed(Reason.WRONG_CODE, e.message)
        is FirebaseTooManyRequestsException -> CodeResult.Failed(Reason.TOO_MANY_REQUESTS, e.message)
        is FirebaseNetworkException -> CodeResult.Failed(Reason.NETWORK, e.message)
        else -> CodeResult.Failed(Reason.OTHER, e?.message)
    }
}
