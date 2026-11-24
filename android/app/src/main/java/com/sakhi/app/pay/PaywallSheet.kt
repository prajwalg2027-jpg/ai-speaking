package com.sakhi.app.pay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sakhi.app.ui.theme.Sakhi
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** "21 Dec 2026" for an ISO time, in India time; null if it can't be read. */
fun paidUntilText(iso: String?): String? = iso?.let {
    runCatching { DateTimeFormatter.ofPattern("d MMM yyyy").format(Instant.parse(it).atZone(ZoneId.of("Asia/Kolkata"))) }.getOrNull()
}

/** The paywall after "Start learning": the offer, Razorpay, then a thank-you. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaywallSheet(state: Paywall, onSubscribe: () -> Unit, onRetry: () -> Unit, onDismiss: () -> Unit, onStartLearning: () -> Unit = onDismiss) {
    if (state == Paywall.Hidden) return
    val busy = state is Paywall.Checking || (state as? Paywall.Offer)?.busy == true
    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Sakhi.colors.surface,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (state) {
                Paywall.Checking -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { CircularProgressIndicator(color = Sakhi.colors.accent) }
                is Paywall.Offer -> Offer(state, onSubscribe)
                is Paywall.Subscribed -> Subscribed(state, onStartLearning)
                is Paywall.Failed -> {
                    Text("Can't open this right now", style = MaterialTheme.typography.headlineSmall)
                    Text(state.message, style = MaterialTheme.typography.bodyLarge)
                    Primary("Try again", busy = false, onClick = onRetry)
                }
                Paywall.Hidden -> Unit
            }
        }
    }
}

@Composable
private fun Offer(o: Paywall.Offer, onSubscribe: () -> Unit) {
    val c = Sakhi.colors
    Text("Learn with Sakhi", style = MaterialTheme.typography.headlineMedium)
    Text("सखी के साथ सीखिए", style = MaterialTheme.typography.bodyLarge.copy(color = c.ink2))
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("₹${o.priceInr}", style = MaterialTheme.typography.displaySmall.copy(color = c.accentDeep))
        Text("a month", style = MaterialTheme.typography.bodyLarge.copy(color = c.ink2), modifier = Modifier.padding(bottom = 6.dp))
    }
    listOf(
        "Talk with Sakhi every day, about anything",
        "Gentle corrections as you speak",
        "Short lessons made for your level",
        "Cancel any time",
    ).forEach { Text("•  $it", style = MaterialTheme.typography.bodyLarge) }
    o.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.error)) }
    Primary("Subscribe · ₹${o.priceInr} a month", busy = o.busy, onClick = onSubscribe)
    Text(if (o.play) "Pay with Google Play, or with Razorpay: UPI, cards or net banking. Renews every month until you cancel, in Account."
        else "Payments by Razorpay: UPI, cards or net banking. Renews every month until you cancel, in Account.",
        style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
}

@Composable
private fun Subscribed(s: Paywall.Subscribed, onStart: () -> Unit) {
    val until = paidUntilText(s.paidUntil)
    Text(if (s.justPaid) "You're in. Thank you!" else if (until != null) "You're subscribed" else "Learning with Sakhi", style = MaterialTheme.typography.headlineMedium)
    if (until != null) Text(if (s.cancelAtEnd) "Your subscription ends on $until." else "Paid until $until; it renews every month.", style = MaterialTheme.typography.bodyLarge)
    Text("Talk with Sakhi about anything, get gentle corrections, and take short lessons made for your level.", style = MaterialTheme.typography.bodyLarge)
    Primary("Start learning", busy = false, onClick = onStart)
}

@Composable
private fun Primary(text: String, busy: Boolean, onClick: () -> Unit) {
    val c = Sakhi.colors
    Button(onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary, disabledContainerColor = c.accentDeep.copy(alpha = 0.6f), disabledContentColor = c.onPrimary)) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = c.onPrimary, strokeWidth = 2.dp) else Text(text, style = MaterialTheme.typography.labelLarge.copy(color = c.onPrimary))
    }
}

/** For the account dialog: one line about the subscription, or null when there's nothing to say. */
fun subscriptionLine(active: Boolean, paidUntil: String?, cancelAtEnd: Boolean): String? {
    if (!active) return null
    val until = paidUntilText(paidUntil) ?: return "Subscribed."
    return if (cancelAtEnd) "Subscribed until $until (cancelled; it won't renew)." else "Subscribed: renews on $until."
}

/** A small text button, used by the account dialog. */
@Composable
fun LinkButton(text: String, onClick: () -> Unit) = TextButton(onClick) { Text(text, color = Sakhi.colors.accentDeep) }
