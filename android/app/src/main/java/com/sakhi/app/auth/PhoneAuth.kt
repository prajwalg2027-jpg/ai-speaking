package com.sakhi.app.auth

import android.app.Activity

/** The signed-in person (from the phone login). */
data class AuthUser(val uid: String, val phone: String?)

/** What happened after asking for a code. */
sealed interface CodeResult {
    /** The SMS was sent; the person types the code (or Android reads it). */
    data class Sent(val verificationId: String) : CodeResult
    /** Android verified the number by itself (read the SMS): already signed in. */
    data object SignedIn : CodeResult
    data class Failed(val reason: Reason, val message: String?) : CodeResult
}

enum class Reason { INVALID_NUMBER, TOO_MANY_REQUESTS, WRONG_CODE, CODE_EXPIRED, NETWORK, OTHER }

/**
 * Phone OTP sign-in. The real one goes through the Adam server, which uses MSG91 ([OtpPhoneAuth]); tests use a
 * fake, so the sign-in flow is tested without a server.
 */
interface PhoneAuth {
    /** False when this build has no login (development against a local server without one). */
    val configured: Boolean
    val currentUser: AuthUser?
    /** The login token for the server; refreshed before it expires (or now, when [force] is true). */
    suspend fun idToken(force: Boolean = false): String?
    /** Send a code to [phone] (E.164, e.g. +919876543210). [resend]: send again to the same number. */
    suspend fun sendCode(activity: Activity, phone: String, resend: Boolean = false): CodeResult
    suspend fun verifyCode(verificationId: String, code: String): CodeResult
    fun signOut()
}

/** "98765 43210", "+91 98765-43210", "098765 43210" → "+919876543210"; null if it isn't an Indian mobile number. */
fun indianMobile(input: String): String? {
    var d = input.filter { it.isDigit() }
    if (d.length == 12 && d.startsWith("91")) d = d.drop(2)
    if (d.length == 11 && d.startsWith("0")) d = d.drop(1)
    return if (d.length == 10 && d[0] in '6'..'9') "+91$d" else null
}
