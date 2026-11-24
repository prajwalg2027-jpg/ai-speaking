package com.sakhi.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.background
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.net.toUri
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.activity.compose.LocalActivity
import com.sakhi.app.auth.AuthViewModel
import com.sakhi.app.auth.Gate
import com.sakhi.app.auth.PhoneNumberHint
import com.sakhi.app.auth.SignInChain
import com.sakhi.app.auth.TruecallerSignIn
import com.sakhi.app.pay.LinkButton
import com.sakhi.app.pay.PaywallSheet
import com.sakhi.app.pay.PaywallViewModel
import com.sakhi.app.pay.RazorpayCheckout
import com.sakhi.app.pay.subscriptionLine
import com.razorpay.PaymentData
import com.razorpay.PaymentResultWithDataListener
import com.sakhi.app.conversation.ConversationViewModel
import com.sakhi.app.ui.LoginActions
import com.sakhi.app.ui.LoginFlow
import com.sakhi.app.ui.ReportDialog
import com.sakhi.app.conversation.reportableText
import com.sakhi.app.ui.SakhiScreen
import com.sakhi.app.ui.LearnScreen
import com.sakhi.app.ui.LearnActions
import com.sakhi.app.learn.LearnPage
import com.sakhi.app.learn.LearnViewModel
import com.sakhi.app.learn.PhoneLearnVoice
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.saveable.rememberSaveable
import com.sakhi.app.ui.theme.SakhiTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first
import androidx.lifecycle.lifecycleScope

class MainActivity : ComponentActivity(), PaymentResultWithDataListener {
    private val container by lazy { (application as SakhiApplication).container }
    private val vm: ConversationViewModel by viewModels {
        viewModelFactory { initializer { ConversationViewModel(application, container) } }
    }
    private val payVm: PaywallViewModel by viewModels {
        viewModelFactory { initializer { PaywallViewModel(container.api, container.events, container.play) } }
    }
    private val learnVm: LearnViewModel by viewModels {
        viewModelFactory { initializer { LearnViewModel(container.learn, container.events, PhoneLearnVoice(application)) { payVm.open() } } }
    }
    private val authVm: AuthViewModel by viewModels {
        viewModelFactory { initializer { AuthViewModel(container.auth, container.api, container.events) } }
    }

    private lateinit var truecaller: TruecallerSignIn
    private lateinit var numberPicker: PhoneNumberHint
    private lateinit var signInChain: SignInChain

    // Razorpay Checkout's result (it calls the activity). The server confirms the payment before anything unlocks.
    override fun onPaymentSuccess(paymentId: String?, data: PaymentData?) {
        payVm.onPaid(paymentId ?: data?.paymentId, data?.signature, data?.data?.optString("razorpay_subscription_id"))
    }
    override fun onPaymentError(code: Int, response: String?, data: PaymentData?) {
        val description = runCatching { org.json.JSONObject(response ?: "").optJSONObject("error")?.optString("description") }.getOrNull()
        payVm.onPayFailed(cancelled = code == RazorpayCheckout.CANCELLED, description = description)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // The launch screen (Theme.Sakhi.Starting): the orb rises into place as its glow warms up ("Sunrise", splash_icon_animated.xml).
        // It stays only while we check who's signed in (at most 2 s), never for the animation: once the app is ready
        // it goes, even mid-animation, with a 0.2 s fade as the orb grows a touch.
        val splash = installSplashScreen()
        val shownAt = SystemClock.uptimeMillis()
        splash.setKeepOnScreenCondition { authVm.gate.value is Gate.Checking && SystemClock.uptimeMillis() - shownAt < 2_000 }
        splash.setOnExitAnimationListener { screen ->
            val animationsOff = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
            if (animationsOff) screen.remove()
            else {
                runCatching { screen.iconView.animate().scaleX(1.06f).scaleY(1.06f).setDuration(200L).start() }
                screen.view.animate().alpha(0f).setDuration(200L).withEndAction { screen.remove() }.start()
            }
        }
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // The way in, in order: Truecaller, then Google's number picker, then typing the number (auth/SignInChain.kt).
        truecaller = TruecallerSignIn(this, BuildConfig.TRUECALLER_CLIENT_ID,
            onCode = { code, verifier -> signInChain.finished(); authVm.signInWithTruecaller(code, verifier, truecaller.clientId) },
            onFailure = { cancelled -> if (signInChain.running) signInChain.truecallerFailed() else if (!cancelled) authVm.truecallerUnavailable() })
        numberPicker = PhoneNumberHint(this,
            onNumber = { number -> signInChain.finished(); authVm.useNumber(number, this) },
            onUnavailable = { signInChain.pickerFailed() })
        signInChain = SignInChain(lifecycleScope,
            truecallerReady = { truecaller.clientId.isNotBlank() && withTimeoutOrNull(2_500) { truecaller.available.first { it } } == true },
            startTruecaller = truecaller::start,
            startNumberPicker = numberPicker::start,
            typeNumber = authVm::typeNumber)
        truecaller.init()
        RazorpayCheckout.preload(this)
        // A voice conversation can't go on unseen: leaving the app ends it (and frees the microphone).
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { com.sakhi.app.diag.Diag.log("app", "foreground") }
            override fun onStop(owner: LifecycleOwner) {
                com.sakhi.app.diag.Diag.log("app", "background", "configChange" to isChangingConfigurations)
                if (!isChangingConfigurations) { vm.onBackgrounded(); learnVm.stopVoice(); container.diag.flushSoon() }
            }
        })
        val reducedMotion = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        setContent {
            SakhiTheme(wideFrame = true) {
                val updateRequired by container.appConfig.updateRequired.collectAsStateWithLifecycle()
                if (updateRequired) { UpdateScreen { openPlayStore() }; return@SakhiTheme }
                val gate by authVm.gate.collectAsStateWithLifecycle()
                val truecallerReady by truecaller.available.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { container.refusals.collect { authVm.onServerRefusal(it) } }
                LaunchedEffect(Unit) { container.events.log("app.opened") }
                // The number screen (not after a code was sent): run the order of ways in, once.
                val onNumberScreen = gate is Gate.Phone
                LaunchedEffect(onNumberScreen, gate == Gate.Ready) {
                    if (gate == Gate.Ready) signInChain.reset() else if (onNumberScreen) signInChain.begin()
                }
                if (gate != Gate.Ready) {
                    val activity = LocalActivity.current ?: this@MainActivity
                    LoginFlow(
                        gate,
                        LoginActions(
                            onNumber = authVm::onNumber, sendCode = { authVm.sendCode(activity) }, onCode = authVm::onCode, verify = authVm::verify,
                            resend = { authVm.resend(activity) }, changeNumber = authVm::changeNumber, agree = authVm::agree, retry = authVm::check,
                            truecaller = if (truecallerReady) truecaller::start else null,
                        ),
                        termsUrl = "https://adamspeaks.in/terms", privacyUrl = "https://adamspeaks.in/privacy",
                    )
                    return@SakhiTheme
                }
                val state by vm.state.collectAsStateWithLifecycle()
                // A test left midway (the app was closed, the connection lost): the orb carries it on.
                LaunchedEffect(Unit) { vm.checkResume() }
                // The learning area (practice, lessons, progress) or the placement test.
                var inLearn by rememberSaveable { mutableStateOf(false) }
                val openLearn = { payVm.dismiss(); vm.onBackgrounded(); inLearn = true; learnVm.loadHome() }
                // A subscribed learner who has a level already starts in the learning area.
                LaunchedEffect(Unit) { if (!inLearn && learnFirst()) openLearn() }
                var accountOpen by remember { mutableStateOf(false) }
                var micBlocked by remember { mutableStateOf(false) }
                var serverDialog by remember { mutableStateOf(false) }
                var reportText by remember { mutableStateOf<String?>(null) }
                val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                    micBlocked = !granted
                    if (granted) vm.onOrbTap()
                }
                val hasMic = { ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
                var sayPending by remember { mutableStateOf<String?>(null) }
                val askSay = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> sayPending?.let { if (granted) vm.sayTap(it) }; sayPending = null }
                val askLearn = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) learnVm.micTap() }
                val learn by learnVm.ui.collectAsStateWithLifecycle()
                BackHandler(enabled = inLearn && learn.page != LearnPage.Home) { learnVm.back() }
                if (inLearn) LearnScreen(learn, micLevel = { learnVm.micLevel.value }, LearnActions(
                    back = { learnVm.back() }, reload = learnVm::loadHome, practise = learnVm::startPractice,
                    openConversation = { learnVm.openConversation(it) }, openLesson = learnVm::openLesson, setIntensity = learnVm::setIntensity,
                    send = { learnVm.send(it) }, retry = learnVm::retry,
                    mic = { if (hasMic()) learnVm.micTap() else askLearn.launch(Manifest.permission.RECORD_AUDIO) },
                    play = learnVm::play, answer = learnVm::answer, next = learnVm::next, askAboutLesson = learnVm::askAboutLesson,
                    clearHeard = learnVm::clearHeard,
                    placement = { learnVm.stopVoice(); inLearn = false },
                    account = if (container.auth.configured) ({ payVm.loadAccount(); accountOpen = true }) else null,
                    report = { reportText = it },
                ))
                else SakhiScreen(
                    state = state,
                    level = { vm.level.value },
                    reducedMotion = reducedMotion,
                    onOrb = { if (hasMic()) vm.onOrbTap() else ask.launch(Manifest.permission.RECORD_AUDIO) },
                    onRestart = vm::restart,
                    onLogoLongPress = if (container.server.canOverride) ({ serverDialog = true }) else null,
                    micBlocked = micBlocked,
                    onAccount = if (container.auth.configured) ({ payVm.loadAccount(); accountOpen = true }) else null,
                    onStartLearning = { vm.stopSaying(); payVm.open() },
                    onReport = { reportText = it },
                    onStartOver = { if (hasMic()) vm.startOver() else ask.launch(Manifest.permission.RECORD_AUDIO) },
                    onHear = vm::hear,
                    onSay = { t -> if (hasMic()) vm.sayTap(t) else { sayPending = t; askSay.launch(Manifest.permission.RECORD_AUDIO) } },
                    onAllowMic = {
                        if (hasMic()) { micBlocked = false; vm.onOrbTap() }
                        else if (shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) ask.launch(Manifest.permission.RECORD_AUDIO)
                        else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                    },
                )
                val paywall by payVm.state.collectAsStateWithLifecycle()
                // Razorpay picked on Google Play's choice screen: Checkout opens for it.
                LaunchedEffect(Unit) { payVm.checkouts.collect { s -> RazorpayCheckout.open(this@MainActivity, s, BRAND_HEX) } }
                PaywallSheet(paywall,
                    onSubscribe = { payVm.subscribe(openPlay = { accountId -> container.play.buy(this@MainActivity, accountId) }) { s -> RazorpayCheckout.open(this@MainActivity, s, BRAND_HEX) } },
                    onRetry = payVm::open, onDismiss = payVm::dismiss, onStartLearning = { if (inLearn) { payVm.dismiss(); learnVm.loadHome() } else openLearn() })
                val pay by payVm.account.collectAsStateWithLifecycle()
                if (accountOpen) AccountDialog(
                    phone = container.auth.currentUser?.phone,
                    subscription = pay?.let { subscriptionLine(it.active, it.paidUntil, it.cancelAtEnd) },
                    onCancelSubscription = if (pay?.active == true && pay?.cancelAtEnd == false) ({ payVm.cancel() }) else null,
                    onDismiss = { accountOpen = false },
                    onSignOut = { accountOpen = false; inLearn = false; learnVm.stopVoice(); vm.onBackgrounded(); authVm.signOut() },
                    onDelete = { authVm.deleteAccount().also { if (it) { accountOpen = false; inLearn = false; learnVm.stopVoice(); vm.onBackgrounded() } } },
                    onReport = { accountOpen = false; reportText = reportableText(vm.state.value) },
                    diagLink = if (com.sakhi.app.diag.Diag.enabled) container.diag.link else null,
                )
                reportText?.let { text -> ReportDialog(text, onSend = { reason -> vm.report(text, reason) }, onDismiss = { reportText = null }) }
                if (serverDialog) ServerDialog(container.server.baseUrl, container.server.default) { url ->
                    serverDialog = false
                    if (url != null) container.server.baseUrl = url
                }
            }
        }
    }
}

/**
 * Open the learning area at start? Only for a learner with access (subscribed, or payments off) who has a placement
 * level already; anyone else starts with the placement test. Any failure (offline, module off): the placement test.
 */
private suspend fun MainActivity.learnFirst(): Boolean = runCatching {
    val c = (application as SakhiApplication).container
    val pay = c.api.payStatus()
    (!pay.required || pay.active) && c.learn.profile().placementLevel != null
}.getOrDefault(false)

private fun ComponentActivity.openPlayStore() {
    val market = Intent(Intent.ACTION_VIEW, "market://details?id=$packageName".toUri())
    runCatching { startActivity(market) }.onFailure {
        startActivity(Intent(Intent.ACTION_VIEW, "https://play.google.com/store/apps/details?id=$packageName".toUri()))
    }
}

/** This version is no longer supported (app-config.json minVersionCode): update from Google Play. */
@androidx.compose.runtime.Composable
private fun UpdateScreen(onUpdate: () -> Unit) {
    val c = com.sakhi.app.ui.theme.Sakhi.colors
    androidx.compose.foundation.layout.Column(
        androidx.compose.ui.Modifier.fillMaxSize().background(c.bg).safeDrawingPadding().padding(32.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(14.dp, androidx.compose.ui.Alignment.CenterVertically),
    ) {
        Text("Please update Adam", style = androidx.compose.material3.MaterialTheme.typography.headlineLarge)
        Text("कृपया Adam ऐप अपडेट करें।", style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(color = c.ink2))
        Text("This version no longer works. The new version is free on Google Play.", style = androidx.compose.material3.MaterialTheme.typography.bodyMedium.copy(color = c.ink2))
        androidx.compose.material3.Button(onUpdate, androidx.compose.ui.Modifier.fillMaxWidth().height(54.dp),
            colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary)) { Text("Update") }
    }
}

/** Signed-in account: sign out, or erase everything (Google Play requires in-app account deletion). */
@androidx.compose.runtime.Composable
private fun AccountDialog(
    phone: String?, onDismiss: () -> Unit, onSignOut: () -> Unit, onDelete: suspend () -> Boolean,
    subscription: String? = null, onCancelSubscription: (suspend () -> Boolean)? = null, onReport: () -> Unit = {},
    diagLink: String? = null,
) {
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var diagCopied by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var cancelFailed by remember { mutableStateOf(false) }
    var busyCancel by remember { mutableStateOf(false) }
    val cancelScope = rememberCoroutineScope()
    if (cancelling && onCancelSubscription != null) {
        AlertDialog(
            onDismissRequest = { if (!busyCancel) cancelling = false },
            title = { Text("Cancel your subscription?") },
            text = { Text(if (cancelFailed) "Couldn't cancel right now. Check your internet and try again." else "It won't renew. You keep learning until the end of the month you've paid for.") },
            confirmButton = { TextButton({ busyCancel = true; cancelScope.launch { cancelFailed = !onCancelSubscription(); busyCancel = false; if (!cancelFailed) cancelling = false } }, enabled = !busyCancel) { Text(if (busyCancel) "Cancelling…" else "Cancel subscription") } },
            dismissButton = { TextButton({ cancelling = false; cancelFailed = false }, enabled = !busyCancel) { Text("Keep it") } },
        )
        return
    }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (confirming) "Delete your account?" else "Your account") },
        text = {
            // One column: the AlertDialog text slot stacks its children on top of each other otherwise.
            androidx.compose.foundation.layout.Column {
                Text(when {
                    failed -> "Couldn't delete right now. Check your internet and try again."
                    confirming -> "This permanently deletes your account, your voice recordings, and everything Adam knows about you. It can't be undone."
                    else -> "Signed in as ${phone ?: "your phone number"}." + (subscription?.let { "\n\n$it" } ?: "")
                })
                if (!confirming && !failed) {
                    // Google Play's AI-generated content policy: a way to flag what the AI said, inside the app.
                    LinkButton("Report what Sakhi said", onReport)
                    if (onCancelSubscription != null) LinkButton("Cancel subscription") { cancelling = true }
                    // Team phones: the diagnostic log's address, to paste to whoever is looking into a problem.
                    if (diagLink != null) LinkButton(if (diagCopied) "Diagnostics link copied" else "Copy diagnostics link") {
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(diagLink)); diagCopied = true
                        com.sakhi.app.diag.Diag.log("diag", "link.copied")
                    }
                }
            }
        },
        confirmButton = {
            if (confirming) TextButton({ busy = true; scope.launch { failed = !onDelete(); busy = false } }, enabled = !busy) { Text(if (busy) "Deleting…" else "Delete everything") }
            else TextButton(onSignOut) { Text("Sign out") }
        },
        dismissButton = {
            if (confirming) TextButton({ confirming = false; failed = false }, enabled = !busy) { Text("Cancel") }
            else TextButton({ confirming = true }) { Text("Delete my account and data") }
        },
    )
}

/** Debug builds only: point the app at another server (e.g. your Mac on Wi-Fi). */
@androidx.compose.runtime.Composable
private fun ServerDialog(current: String, default: String, done: (String?) -> Unit) {
    var url by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = { done(null) },
        title = { Text("Server address") },
        text = { OutlinedTextField(url, { url = it }, singleLine = true, supportingText = { Text("Default: $default") }) },
        confirmButton = { TextButton({ done(url) }) { Text("Save") } },
        dismissButton = { TextButton({ done(default) }) { Text("Use default") } },
    )
}

/** Razorpay Checkout's colour: the app's deep accent. */
private const val BRAND_HEX = "#993C25"
