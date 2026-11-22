package com.sakhi.app.auth

import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.identity.GetPhoneNumberHintIntentRequest
import com.google.android.gms.auth.api.identity.Identity

/**
 * Google's phone number picker (Play services "Phone Number Hint"): shows the numbers on the phone's SIMs, no
 * permission needed. [onNumber] gets the chosen number (E.164, e.g. +919876543210); [onUnavailable] means it
 * couldn't open (no Play services, no SIM number) or the person closed it. Create it in the activity's onCreate
 * (it registers for an activity result).
 */
class PhoneNumberHint(
    private val activity: ComponentActivity,
    private val onNumber: (String) -> Unit,
    private val onUnavailable: () -> Unit,
) {
    private val launcher = activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        val number = if (r.resultCode == Activity.RESULT_OK) {
            runCatching { Identity.getSignInClient(activity).getPhoneNumberFromIntent(r.data) }.getOrNull()
        } else null
        if (number.isNullOrBlank()) onUnavailable() else onNumber(number)
    }

    fun start() {
        try {
            Identity.getSignInClient(activity)
                .getPhoneNumberHintIntent(GetPhoneNumberHintIntentRequest.builder().build())
                .addOnSuccessListener { pending ->
                    runCatching { launcher.launch(IntentSenderRequest.Builder(pending).build()) }.onFailure { onUnavailable() }
                }
                .addOnFailureListener { onUnavailable() }
        } catch (e: Exception) {
            onUnavailable()
        }
    }
}
