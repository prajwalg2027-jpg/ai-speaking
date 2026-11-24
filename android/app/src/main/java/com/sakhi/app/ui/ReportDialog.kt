package com.sakhi.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sakhi.app.conversation.ReportReason
import com.sakhi.app.ui.theme.Sakhi
import kotlinx.coroutines.launch

/** "Report what Sakhi said": the words being reported, a reason, then Send. [onSend] says whether it reached us. */
@Composable
fun ReportDialog(text: String, onSend: suspend (ReportReason) -> Boolean, onDismiss: () -> Unit) {
    val c = Sakhi.colors
    var reason by remember { mutableStateOf<ReportReason?>(null) }
    var busy by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val nothing = text.isBlank()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (sent) "Thank you" else "Report what Sakhi said") },
        text = {
            when {
                sent -> Text("We've received your report and will look at it. Sakhi is an AI and can make mistakes.")
                nothing -> Text("Sakhi hasn't said anything yet. To report one of her replies, press and hold it.")
                else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("“$text”", maxLines = 5, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2, fontStyle = FontStyle.Italic))
                    Column(Modifier.selectableGroup()) {
                        ReportReason.entries.forEach { r ->
                            Row(
                                Modifier.fillMaxWidth().selectable(r == reason, enabled = !busy, role = Role.RadioButton) { reason = r; failed = false }
                                    .padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(r == reason, onClick = null, enabled = !busy)
                                Text(r.label, Modifier.padding(start = 10.dp), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    if (failed) Text("Couldn't send it. Check your internet and try again.", style = MaterialTheme.typography.bodySmall.copy(color = c.rust))
                }
            }
        },
        confirmButton = {
            if (sent || nothing) TextButton(onDismiss) { Text("Close") }
            else TextButton({
                val r = reason ?: return@TextButton
                busy = true
                scope.launch { val ok = onSend(r); busy = false; if (ok) sent = true else failed = true }
            }, enabled = reason != null && !busy) { Text(if (busy) "Sending…" else "Send report") }
        },
        dismissButton = { if (!sent && !nothing) TextButton(onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}
