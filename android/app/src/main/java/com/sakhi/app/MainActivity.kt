package com.sakhi.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
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
import com.sakhi.app.conversation.ConversationViewModel
import com.sakhi.app.ui.LoginActions
import com.sakhi.app.ui.LoginFlow
import com.sakhi.app.ui.SakhiScreen
import com.sakhi.app.ui.theme.SakhiTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val container by lazy { (application as SakhiApplication).container }
    private val vm: ConversationViewModel by viewModels {
        viewModelFactory { initializer { ConversationViewModel(application, container) } }
    }
    private val authVm: AuthViewModel by viewModels {
        viewModelFactory { initializer { AuthViewModel(container.auth, container.api, container.events) } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A voice conversation can't go on unseen: leaving the app ends it (and frees the microphone).
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) { if (!isChangingConfigurations) vm.onBackgrounded() }
        })
        val reducedMotion = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        setContent {
            SakhiTheme {
                val updateRequired by container.appConfig.updateRequired.collectAsStateWithLifecycle()
                if (updateRequired) { UpdateScreen { openPlayStore() }; return@SakhiTheme }
                val gate by authVm.gate.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { container.refusals.collect { authVm.onServerRefusal(it) } }
                LaunchedEffect(Unit) { container.events.log("app.opened") }
                if (gate != Gate.Ready) {
                    val activity = LocalActivity.current ?: this@MainActivity
                    LoginFlow(
                        gate,
                        LoginActions(
                            onNumber = authVm::onNumber, sendCode = { authVm.sendCode(activity) }, onCode = authVm::onCode, verify = authVm::verify,
                            resend = { authVm.resend(activity) }, changeNumber = authVm::changeNumber, agree = authVm::agree, retry = authVm::check,
                        ),
                        termsUrl = "https://adamspeaks.in/terms", privacyUrl = "https://adamspeaks.in/privacy",
                    )
                    return@SakhiTheme
                }
                val state by vm.state.collectAsStateWithLifecycle()
                var accountOpen by remember { mutableStateOf(false) }
                var micBlocked by remember { mutableStateOf(false) }
                var serverDialog by remember { mutableStateOf(false) }
                val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                    micBlocked = !granted
                    if (granted) vm.onOrbTap()
                }
                val hasMic = { ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
                SakhiScreen(
                    state = state,
                    level = { vm.level.value },
                    reducedMotion = reducedMotion,
                    onOrb = { if (hasMic()) vm.onOrbTap() else ask.launch(Manifest.permission.RECORD_AUDIO) },
                    onRestart = vm::restart,
                    onLogoLongPress = if (container.server.canOverride) ({ serverDialog = true }) else null,
                    micBlocked = micBlocked,
                    onAccount = if (container.auth.configured) ({ accountOpen = true }) else null,
                    onAllowMic = {
                        if (hasMic()) { micBlocked = false; vm.onOrbTap() }
                        else if (shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) ask.launch(Manifest.permission.RECORD_AUDIO)
                        else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                    },
                )
                if (accountOpen) AccountDialog(
                    phone = container.auth.currentUser?.phone,
                    onDismiss = { accountOpen = false },
                    onSignOut = { accountOpen = false; vm.onBackgrounded(); authVm.signOut() },
                    onDelete = { authVm.deleteAccount().also { if (it) { accountOpen = false; vm.onBackgrounded() } } },
                )
                if (serverDialog) ServerDialog(container.server.baseUrl, container.server.default) { url ->
                    serverDialog = false
                    if (url != null) container.server.baseUrl = url
                }
            }
        }
    }
}

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
        androidx.compose.ui.Modifier.fillMaxSize().background(c.bg).padding(32.dp),
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
private fun AccountDialog(phone: String?, onDismiss: () -> Unit, onSignOut: () -> Unit, onDelete: suspend () -> Boolean) {
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (confirming) "Delete your account?" else "Your account") },
        text = {
            Text(when {
                failed -> "Couldn't delete right now. Check your internet and try again."
                confirming -> "This permanently deletes your account, your voice recordings, and everything Adam knows about you. It can't be undone."
                else -> "Signed in as ${phone ?: "your phone number"}."
            })
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
