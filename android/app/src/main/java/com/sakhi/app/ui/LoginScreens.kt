package com.sakhi.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sakhi.app.auth.Gate
import com.sakhi.app.ui.theme.Sakhi

/** Callbacks for the sign-in screens. */
class LoginActions(
    val onNumber: (String) -> Unit = {},
    val sendCode: () -> Unit = {},
    val onCode: (String) -> Unit = {},
    val verify: () -> Unit = {},
    val resend: () -> Unit = {},
    val changeNumber: () -> Unit = {},
    val agree: (adult: Boolean, terms: Boolean, recordings: Boolean) -> Unit = { _, _, _ -> },
    val retry: () -> Unit = {},
    /** Truecaller one-tap, when the Truecaller app can sign them in (null: not offered). */
    val truecaller: (() -> Unit)? = null,
)

/** Phone number → code → consents. Shown until the person is signed in and has agreed. */
@Composable
fun LoginFlow(gate: Gate, actions: LoginActions, termsUrl: String, privacyUrl: String) {
    val c = Sakhi.colors
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(c.glow, c.bg), endY = 900f)).safeDrawingPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(22.dp).clip(CircleShape).background(Brush.radialGradient(listOf(c.saffron, c.accent, c.accentDeep))))
                Text("Adam", Modifier.padding(start = 10.dp), style = MaterialTheme.typography.titleLarge)
            }
            Spacer(Modifier.height(24.dp))
            when (gate) {
                is Gate.Phone -> PhoneStep(gate, actions)
                is Gate.Code -> CodeStep(gate, actions)
                is Gate.Consents -> ConsentStep(gate, actions, termsUrl, privacyUrl)
                is Gate.Offline -> {
                    Title("Can't connect", "कनेक्ट नहीं हो पाया")
                    Body(gate.message)
                    Primary("Try again", busy = false, onClick = actions.retry)
                }
                Gate.Checking, Gate.Ready -> Box(Modifier.fillMaxWidth().padding(top = 80.dp), Alignment.Center) { CircularProgressIndicator(color = c.accent) }
            }
        }
    }
}

@Composable
private fun PhoneStep(g: Gate.Phone, a: LoginActions) {
    Title("Let's get started", "चलिए शुरू करते हैं")
    g.note?.let { Body(it) }
    a.truecaller?.let { tc ->
        Primary("Continue with Truecaller", busy = g.busy, onClick = tc)
        Body("Or enter your mobile number, and we'll send you a code by SMS.")
    } ?: Body("Enter your mobile number. We'll send you a code by SMS.")
    Field(
        value = g.number, onValue = a.onNumber, label = "Mobile number", prefix = "+91  ",
        keyboard = KeyboardType.Phone, error = g.error, onDone = a.sendCode,
    )
    Primary("Send code · कोड भेजें", busy = g.busy, onClick = a.sendCode)
}

@Composable
private fun CodeStep(g: Gate.Code, a: LoginActions) {
    Title("Enter the code", "कोड डालिए")
    Body("We sent a ${g.length}-digit code to ${g.phone.replaceFirst("+91", "+91 ")}. It may fill in by itself.")
    Field(value = g.code, onValue = a.onCode, label = "${g.length}-digit code", keyboard = KeyboardType.NumberPassword, error = g.error, onDone = a.verify, big = true)
    Primary("Continue · आगे बढ़ें", busy = g.busy, onClick = a.verify)
    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        TextButton(a.changeNumber) { Text("Change number", color = Sakhi.colors.ink2) }
        TextButton(a.resend, enabled = g.resendIn <= 0 && !g.busy) {
            Text(if (g.resendIn > 0) "Send again in ${g.resendIn}s" else "Send again", color = if (g.resendIn > 0) Sakhi.colors.ink2 else Sakhi.colors.accentDeep)
        }
    }
}

@Composable
private fun ConsentStep(g: Gate.Consents, a: LoginActions, termsUrl: String, privacyUrl: String) {
    val c = Sakhi.colors
    var adult by rememberSaveable { mutableStateOf(false) }
    var terms by rememberSaveable { mutableStateOf(false) }
    var rec by rememberSaveable { mutableStateOf(false) }
    Title("Before we talk", "बात शुरू करने से पहले")
    Body("Please confirm these to continue.")
    Check(adult, { adult = it }) { Text("I am 18 years or older. · मेरी उम्र 18 साल या उससे ज़्यादा है।", style = MaterialTheme.typography.bodyMedium) }
    Check(terms, { terms = it }) {
        val link = TextLinkStyles(SpanStyle(color = c.accentDeep, textDecoration = TextDecoration.Underline))
        Text(buildAnnotatedString {
            append("I agree to the ")
            withLink(LinkAnnotation.Url(termsUrl, link)) { append("Terms") }
            append(" and the ")
            withLink(LinkAnnotation.Url(privacyUrl, link)) { append("Privacy Policy") }
            append(".")
        }, style = MaterialTheme.typography.bodyMedium)
    }
    Check(rec, { rec = it }) {
        Text("Adam may keep recordings of my voice to check my level and improve my learning. I can ask for them to be deleted at any time.",
            style = MaterialTheme.typography.bodyMedium)
    }
    g.error?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.hot)) }
    Primary("Agree and start · सहमत हूँ", busy = g.busy) { a.agree(adult, terms, rec) }
}

@Composable private fun Title(en: String, hi: String) {
    Text(en, style = MaterialTheme.typography.headlineLarge.copy(fontSize = 32.sp, lineHeight = 36.sp))
    Text(hi, style = MaterialTheme.typography.bodyLarge.copy(color = Sakhi.colors.ink2))
}
@Composable private fun Body(t: String) = Text(t, style = MaterialTheme.typography.bodyMedium.copy(color = Sakhi.colors.ink2))

@Composable
private fun Field(value: String, onValue: (String) -> Unit, label: String, keyboard: KeyboardType, error: String?, onDone: () -> Unit, prefix: String? = null, big: Boolean = false) {
    val c = Sakhi.colors
    OutlinedTextField(
        value = value, onValueChange = onValue, label = { Text(label) }, singleLine = true,
        prefix = prefix?.let { { Text(it, color = c.ink2) } },
        isError = error != null, supportingText = error?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = if (big) 28.sp else 20.sp, letterSpacing = if (big) 8.sp else 1.sp),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = c.accentDeep, focusedLabelColor = c.accentDeep, cursorColor = c.accentDeep,
            unfocusedContainerColor = c.surface, focusedContainerColor = c.surface),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Primary(label: String, busy: Boolean, onClick: () -> Unit) {
    val c = Sakhi.colors
    Button(onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary, disabledContainerColor = c.accentDeep.copy(alpha = 0.6f), disabledContentColor = c.onPrimary)) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = c.onPrimary, strokeWidth = 2.dp)
        else Text(label, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun Check(checked: Boolean, onChange: (Boolean) -> Unit, label: @Composable () -> Unit) {
    val c = Sakhi.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.surface).border(1.dp, if (checked) c.accent else c.line, RoundedCornerShape(14.dp))
            .clickable(role = Role.Checkbox) { onChange(!checked) }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked, onChange, colors = CheckboxDefaults.colors(checkedColor = c.accentDeep))
        Box(Modifier.padding(start = 6.dp).weight(1f)) { label() }
    }
}
