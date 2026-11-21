package com.sakhi.app.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The order of the ways in, run once when the number screen first shows:
 *  1. Truecaller one-tap, if the Truecaller app can sign them in;
 *  2. otherwise (or if it doesn't sign them in), Google's phone number picker — a chosen number gets its code at once;
 *  3. otherwise (no picker, or closed), the number field with the number keyboard.
 * The steps themselves are passed in, so the order is tested without a phone.
 */
class SignInChain(
    private val scope: CoroutineScope,
    /** Waits (briefly) for Truecaller to be ready. → true if it can sign them in. */
    private val truecallerReady: suspend () -> Boolean,
    private val startTruecaller: () -> Unit,
    private val startNumberPicker: () -> Unit,
    private val typeNumber: () -> Unit,
) {
    private enum class Step { IDLE, TRUECALLER, PICKER, DONE }
    private var step = Step.IDLE

    /** True while the chain is choosing for them (so a Truecaller failure moves on instead of showing an error). */
    val running get() = step == Step.TRUECALLER || step == Step.PICKER

    fun begin() {
        if (step != Step.IDLE) return
        step = Step.TRUECALLER
        scope.launch { if (truecallerReady()) startTruecaller() else picker() }
    }

    /** Truecaller didn't sign them in (not installed, closed, "another number", or an error). */
    fun truecallerFailed() { if (step == Step.TRUECALLER) picker() }

    /** The picker couldn't open, or they closed it. */
    fun pickerFailed() { if (step == Step.PICKER) { step = Step.DONE; typeNumber() } }

    /** A number was chosen, or they signed in: nothing more to try. */
    fun finished() { step = Step.DONE }

    /** Back to the start (after signing out), so the next number screen runs the order again. */
    fun reset() { step = Step.IDLE }

    private fun picker() { step = Step.PICKER; startNumberPicker() }
}
