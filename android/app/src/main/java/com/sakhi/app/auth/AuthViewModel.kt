package com.sakhi.app.auth

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sakhi.app.net.Consent
import com.sakhi.app.net.SakhiApi
import com.sakhi.app.net.ServerException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

/** Where the person is on the way in: phone number → code → consents → the conversation. */
sealed interface Gate {
    data object Checking : Gate
    data class Offline(val message: String) : Gate
    /** [focus]: open the keyboard on the number field (Truecaller and the number picker didn't sign them in). */
    data class Phone(val number: String = "", val error: String? = null, val busy: Boolean = false, val note: String? = null, val focus: Boolean = false) : Gate
    data class Code(val phone: String, val verificationId: String, val code: String = "", val error: String? = null, val busy: Boolean = false, val resendIn: Int = 30, val length: Int = 6) : Gate
    data class Consents(val missing: List<String>, val error: String? = null, val busy: Boolean = false) : Gate
    data object Ready : Gate
}

/** The wording version the person agreed to (stored with each consent). Change it when the texts change. */
const val CONSENT_VERSION = "2026-11-v1"

/**
 * Phone OTP first (the app can't be used without it), then the consents the server requires before a test:
 * terms and privacy, 18 or older, and keeping voice recordings.
 */
class AuthViewModel(private val auth: PhoneAuth, private val api: SakhiApi, private val events: EventLog) : ViewModel() {
    private val _gate = MutableStateFlow<Gate>(Gate.Checking)
    val gate: StateFlow<Gate> = _gate.asStateFlow()
    private var ticker: Job? = null

    init {
        // The diagnostic log: each step of signing in, with any error shown (never the number or the code).
        viewModelScope.launch {
            _gate.map { g ->
                val error = when (g) { is Gate.Phone -> g.error ?: g.note; is Gate.Code -> g.error; is Gate.Consents -> g.error; is Gate.Offline -> g.message; else -> null }
                val busy = when (g) { is Gate.Phone -> g.busy; is Gate.Code -> g.busy; is Gate.Consents -> g.busy; else -> false }
                listOf(g::class.simpleName, busy, error, (g as? Gate.Consents)?.missing)
            }.distinctUntilChanged().collect { (step, busy, error, missing) ->
                com.sakhi.app.diag.Diag.log("auth", "gate", "step" to step, "busy" to busy, "error" to error, "missing" to missing)
            }
        }
        check()
    }

    /** Re-check where they stand (at start, after an error, or when the server refuses a request). */
    fun check() {
        if (!auth.configured) { _gate.value = Gate.Ready; return } // a development build without login
        if (auth.currentUser == null) { _gate.value = Gate.Phone(); return }
        _gate.value = Gate.Checking
        viewModelScope.launch { afterSignIn() }
    }

    fun onNumber(text: String) = _gate.update { if (it is Gate.Phone) it.copy(number = text.filter { c -> c.isDigit() || c == ' ' || c == '+' }.take(16), error = null) else it }
    fun onCode(text: String) = _gate.update { if (it is Gate.Code) it.copy(code = text.filter(Char::isDigit).take(it.length), error = null) else it }

    fun sendCode(activity: Activity) {
        val g = _gate.value as? Gate.Phone ?: return
        val phone = indianMobile(g.number) ?: run { _gate.value = g.copy(error = "Enter your 10-digit mobile number"); return }
        _gate.value = g.copy(busy = true, error = null)
        viewModelScope.launch { handle(auth.sendCode(activity, phone), phone) }
    }

    fun resend(activity: Activity) {
        val g = _gate.value as? Gate.Code ?: return
        if (g.resendIn > 0) return
        _gate.value = g.copy(busy = true, error = null)
        viewModelScope.launch { handle(auth.sendCode(activity, g.phone, resend = true), g.phone) }
    }

    fun verify() {
        val g = _gate.value as? Gate.Code ?: return
        if (g.code.length != g.length) { _gate.value = g.copy(error = "Enter the ${g.length}-digit code"); return }
        _gate.value = g.copy(busy = true, error = null)
        viewModelScope.launch { handle(auth.verifyCode(g.verificationId, g.code), g.phone) }
    }

    /** A number chosen in Google's number picker: its code is sent at once. */
    fun useNumber(e164: String, activity: Activity) {
        val g = _gate.value as? Gate.Phone ?: return
        val phone = indianMobile(e164)
        if (phone == null) { _gate.value = g.copy(number = e164.filter { it.isDigit() }.takeLast(10), error = "Adam is for Indian mobile numbers for now.", focus = true); return }
        _gate.value = g.copy(number = phone.removePrefix("+91"), error = null)
        sendCode(activity)
    }

    /** Neither Truecaller nor the picker: they type the number (the keyboard opens). */
    fun typeNumber() = _gate.update { if (it is Gate.Phone) it.copy(busy = false, focus = true) else it }

    /** Truecaller gave an authorization code: the server checks it with Truecaller and signs in. */
    fun signInWithTruecaller(code: String, codeVerifier: String, clientId: String) {
        val g = _gate.value as? Gate.Phone ?: return
        _gate.value = g.copy(busy = true, error = null)
        viewModelScope.launch { handle(auth.signInWithTruecaller(code, codeVerifier, clientId), "") }
    }

    /** Truecaller couldn't sign them in (not closed by them): carry on with the number. */
    fun truecallerUnavailable() = _gate.update { if (it is Gate.Phone) it.copy(busy = false, note = "Truecaller didn’t work this time. Please enter your number.") else it }

    fun changeNumber() { ticker?.cancel(); _gate.value = Gate.Phone(number = ((_gate.value as? Gate.Code)?.phone ?: "").removePrefix("+91")) }

    private suspend fun handle(r: CodeResult, phone: String) {
        when (r) {
            is CodeResult.Sent -> { _gate.value = Gate.Code(phone, r.verificationId, length = r.codeLength); startResendTimer() }
            CodeResult.SignedIn -> { ticker?.cancel(); events.log("login.completed"); afterSignIn() }
            is CodeResult.Failed -> {
                val msg = message(r.reason)
                _gate.update { when (it) { is Gate.Code -> it.copy(busy = false, error = msg); is Gate.Phone -> it.copy(busy = false, error = msg); else -> Gate.Phone(phone.removePrefix("+91"), msg) } }
            }
        }
    }

    private fun startResendTimer() {
        ticker?.cancel()
        ticker = viewModelScope.launch {
            while (true) {
                delay(1000)
                val g = _gate.value as? Gate.Code ?: break
                if (g.resendIn <= 0) break
                _gate.value = g.copy(resendIn = g.resendIn - 1)
            }
        }
    }

    /** Signed in: does the server have every consent it needs? */
    private suspend fun afterSignIn() {
        _gate.value = try {
            val me = api.me()
            if (me.missingConsents.isEmpty()) Gate.Ready else Gate.Consents(me.missingConsents)
        } catch (e: ServerException) {
            if (e.status == 401) { auth.signOut(); Gate.Phone(note = "Please sign in again.") } else Gate.Offline("Adam couldn't reach the server. Check your internet and try again.")
        } catch (e: IOException) {
            Gate.Offline("Adam couldn't reach the server. Check your internet and try again.")
        }
    }

    /** All three boxes must be ticked: 18 or older, terms and privacy, keeping voice recordings. */
    fun agree(adult: Boolean, terms: Boolean, recordings: Boolean) {
        val g = _gate.value as? Gate.Consents ?: return
        if (!adult) { _gate.value = g.copy(error = "Adam is for people aged 18 or older."); return }
        if (!terms || !recordings) { _gate.value = g.copy(error = "Please tick all the boxes to continue."); return }
        _gate.value = g.copy(busy = true, error = null)
        viewModelScope.launch {
            _gate.value = try {
                val left = api.saveConsents(listOf("age_18_plus", "terms", "privacy", "recordings").map { Consent(it, CONSENT_VERSION, true) }).missingConsents
                events.log("consents.given")
                if (left.isEmpty()) Gate.Ready else Gate.Consents(left, "Something didn't save. Please try again.")
            } catch (e: IOException) {
                g.copy(busy = false, error = "Couldn't save. Check your internet and try again.")
            }
        }
    }

    /** The server refused a request: a login problem or a missing consent. */
    fun onServerRefusal(e: ServerException) {
        when {
            e.error == "consent_required" -> _gate.value = Gate.Consents(e.missing)
            e.status == 401 -> { auth.signOut(); _gate.value = Gate.Phone(note = "Please sign in again.") }
        }
    }

    fun signOut() { events.log("logout"); auth.signOut(); _gate.value = Gate.Phone() }

    /** Erase their data on the server, then sign out. → true when done. */
    suspend fun deleteAccount(): Boolean = try {
        api.deleteMe(); auth.signOut(); _gate.value = Gate.Phone(note = "Your account and data have been deleted."); true
    } catch (e: IOException) { false }

    private fun message(r: Reason) = when (r) {
        Reason.INVALID_NUMBER -> "That number doesn't look right. Check it and try again."
        Reason.TOO_MANY_REQUESTS -> "Too many tries. Please wait a while and try again."
        Reason.WRONG_CODE -> "That code isn't right. Check the SMS and try again."
        Reason.CODE_EXPIRED -> "That code has expired. Tap “Send again”."
        Reason.NETWORK -> "No internet connection. Check it and try again."
        Reason.TRUECALLER_FAILED -> "Truecaller sign-in didn’t work. Please enter your number instead."
        Reason.OTHER -> "Something went wrong. Please try again."
    }
}
