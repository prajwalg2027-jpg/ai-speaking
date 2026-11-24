package com.sakhi.app.diag

import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

/**
 * The app's diagnostic log (docs/DIAGNOSTICS.md): what happened, step by step, with timings, so a problem seen on
 * a team phone can be read afterwards. Anything can call [log]; it's cheap and never throws.
 *
 * Events wait here (the newest [MAX_PENDING]) until [DiagUploader] sends them to the server, which it does only
 * for phones signed in with a team number. Everyone else's events never leave the phone and are dropped once the
 * server says so. On a team phone (or a debug build) each event is also written to logcat, tag "AdamDiag", for a
 * live look over adb.
 *
 * Never log one-time codes, login tokens, phone numbers or audio. Long strings are cut to [MAX_STRING].
 */
object Diag {
    const val TAG = "AdamDiag"
    const val MAX_PENDING = 5000
    const val MAX_STRING = 600

    /** The server said this phone sends diagnostics. */
    @Volatile var enabled = false
        internal set
    /** Mirror events to logcat (a team phone, or a debug build). */
    @Volatile var logcat = false
    /** The conversation the events belong to (the placement test's session id), while there is one. */
    @Volatile var session: String? = null
    /** Milliseconds since boot (SystemClock.elapsedRealtime in the app): exact gaps between events. */
    @Volatile var uptime: () -> Long = { System.nanoTime() / 1_000_000 }

    private val pending = ArrayDeque<JsonObject>()
    private var seq = 0L
    private var dropped = 0

    fun log(cat: String, name: String, vararg data: Pair<String, Any?>) {
        try {
            val e = buildJsonObject {
                put("t", Instant.now().toString())
                put("up", uptime())
                put("cat", cat)
                put("name", name)
                session?.let { put("sid", it) }
                if (data.isNotEmpty()) put("data", JsonObject(data.associate { (k, v) -> k to json(v) }))
            }
            add(e)
            if (logcat || enabled) Log.i(TAG, "[$cat] $name ${data.joinToString(" ") { (k, v) -> "$k=${v.toString().take(200)}" }}")
        } catch (_: Throwable) { /* a log line must never break the app */ }
    }

    /** An error, with its type, message and where it came from (the first lines of the stack). */
    fun error(cat: String, name: String, t: Throwable, vararg data: Pair<String, Any?>) =
        log(cat, name, *data, "error" to "${t.javaClass.simpleName}: ${t.message}", "at" to stackOf(t))

    @Synchronized private fun add(e: JsonObject) {
        val withSeq = JsonObject(e + ("seq" to JsonPrimitive(seq++)))
        pending.addLast(withSeq)
        while (pending.size > MAX_PENDING) { pending.removeFirst(); dropped++ }
    }

    /** Up to [max] of the oldest waiting events, taken out (give them back with [putBack] if sending fails). */
    @Synchronized fun take(max: Int): List<JsonObject> {
        val out = ArrayList<JsonObject>(minOf(max, pending.size))
        if (dropped > 0) {
            out += buildJsonObject { put("t", Instant.now().toString()); put("cat", "diag"); put("name", "dropped"); put("seq", seq++); put("data", buildJsonObject { put("events", dropped) }) }
            dropped = 0
        }
        while (out.size < max && pending.isNotEmpty()) out += pending.removeFirst()
        return out
    }

    @Synchronized fun putBack(events: List<JsonObject>) {
        events.asReversed().forEach { pending.addFirst(it) }
        while (pending.size > MAX_PENDING) { pending.removeLast(); dropped++ }
    }

    @Synchronized fun size() = pending.size

    /** Not a team phone: forget everything and keep nothing more than a small window. */
    @Synchronized fun clear() { pending.clear(); dropped = 0 }

    internal fun json(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is JsonElement -> v
        is Boolean -> JsonPrimitive(v)
        is Int, is Long, is Short, is Byte -> JsonPrimitive(v as Number)
        is Float -> if (v.isFinite()) JsonPrimitive(Math.round(v * 1000) / 1000.0) else JsonNull
        is Double -> if (v.isFinite()) JsonPrimitive(Math.round(v * 1000) / 1000.0) else JsonNull
        is Number -> JsonPrimitive(v)
        is Enum<*> -> JsonPrimitive(v.name)
        is Collection<*> -> kotlinx.serialization.json.JsonArray(v.take(50).map(::json))
        is Map<*, *> -> JsonObject(v.entries.take(50).associate { (k, x) -> k.toString() to json(x) })
        else -> v.toString().let { JsonPrimitive(if (it.length > MAX_STRING) it.take(MAX_STRING) + "…" else it) }
    }

    fun stackOf(t: Throwable): String = generateSequence(t) { it.cause }.take(3).joinToString(" | caused by ") { c ->
        "${c.javaClass.simpleName}: ${c.message?.take(200)} @ " + c.stackTrace.take(6).joinToString(" < ") { "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}" }
    }
}
