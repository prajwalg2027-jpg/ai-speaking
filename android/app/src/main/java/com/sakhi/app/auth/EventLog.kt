package com.sakhi.app.auth

import com.sakhi.app.net.AppEvent
import com.sakhi.app.net.SakhiApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

/**
 * What the person does in the app, sent to the server's event log. Each event has its own id, so a retried
 * send is stored once. Best effort: what matters for levels and tests is logged by the server itself.
 */
class EventLog(private val api: () -> SakhiApi?, private val scope: CoroutineScope, private val signedIn: () -> Boolean) {
    fun log(name: String, properties: Map<String, String> = emptyMap(), sessionId: String? = null) {
        com.sakhi.app.diag.Diag.log("event", name, *properties.toList().toTypedArray())
        if (!signedIn()) return
        val e = AppEvent(name, UUID.randomUUID().toString(), Instant.now().toString(), properties, sessionId)
        scope.launch { runCatching { api()?.sendEvents(listOf(e)) } }
    }
}
