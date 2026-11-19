package com.sakhi.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
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
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.sakhi.app.conversation.ConversationViewModel
import com.sakhi.app.ui.SakhiScreen
import com.sakhi.app.ui.theme.SakhiTheme

class MainActivity : ComponentActivity() {
    private val container by lazy { (application as SakhiApplication).container }
    private val vm: ConversationViewModel by viewModels {
        viewModelFactory { initializer { ConversationViewModel(application, container) } }
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
                val state by vm.state.collectAsStateWithLifecycle()
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
                    onAllowMic = {
                        if (hasMic()) { micBlocked = false; vm.onOrbTap() }
                        else if (shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) ask.launch(Manifest.permission.RECORD_AUDIO)
                        else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                    },
                )
                if (serverDialog) ServerDialog(container.server.baseUrl, container.server.default) { url ->
                    serverDialog = false
                    if (url != null) container.server.baseUrl = url
                }
            }
        }
    }
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
