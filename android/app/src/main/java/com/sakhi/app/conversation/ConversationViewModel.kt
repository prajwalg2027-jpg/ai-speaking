package com.sakhi.app.conversation

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sakhi.app.AppContainer
import com.sakhi.app.audio.AudioGate
import com.sakhi.app.audio.AudioRouting
import com.sakhi.app.audio.MicCapture
import com.sakhi.app.audio.SpeechMeter
import com.sakhi.app.audio.VoicePlayer
import com.sakhi.app.net.Card
import com.sakhi.app.net.Interrupted
import com.sakhi.app.net.LiveEvent
import com.sakhi.app.net.Line
import com.sakhi.app.net.ListenSpec
import com.sakhi.app.net.Result
import com.sakhi.app.net.ServerException
import com.sakhi.app.net.SpeakRequest
import com.sakhi.app.net.Timing
import com.sakhi.app.net.Turn
import com.sakhi.app.net.TurnRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.io.IOException

enum class Phase { IDLE, THINKING, SPEAKING, LISTENING }
enum class SessionState { IDLE, LIVE, RESULT }

data class Message(
    val id: Long,
    val fromSakhi: Boolean,
    val words: List<String>,
    val shown: Int = words.size,
    val lang: String = "en-IN",
    val thinking: Boolean = false,
    val live: Boolean = false,
    val cut: Boolean = false,
) {
    val text: String get() = words.joinToString(" ")
}

data class CardState(val card: Card, val deal: Int, val answered: Boolean = false, val hindiLocked: Boolean = false)

data class UiState(
    val session: SessionState = SessionState.IDLE,
    val phase: Phase = Phase.IDLE,
    val messages: List<Message> = emptyList(),
    val card: CardState? = null,
    val learnerLanguage: String? = null,
    val waitNudge: Boolean = false,
    val notice: Boolean = false,
    val result: Result? = null,
)

/**
 * The placement conversation (a port of public/app.js run()): Sakhi speaks each line with her words revealed
 * in step with the voice, then the app listens for one answer, sends it, and plays a quick "Okay." while the
 * server writes the reply. The server decides everything about the assessment; this only talks and listens.
 */
class ConversationViewModel(app: Application, private val c: AppContainer) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    /** The orb's audio level (0..1), updated up to 50×/s: kept apart so the screen doesn't recompose with it. */
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level.asStateFlow()

    private val meter = SpeechMeter()
    private val mic = MicCapture(meter)
    private val player = VoicePlayer()
    private val routing = AudioRouting(app)
    private val haptics = Haptics(app)
    private val live = c.newLiveConnection()
    private val gate = AudioGate { live.sendPcm(it) }
    private val liveEvents = Channel<LiveEvent>(Channel.UNLIMITED)

    private var job: Job? = null
    private var sessionId: String? = null
    private var collector: AnswerCollector? = null
    @Volatile private var bargeInAt: Long? = null
    private var tapInterrupt = false
    private var ids = 0L
    private var backchannels: Deferred<List<Pair<String, ByteArray>>>? = null
    private var lastBackchannel: String? = null

    init {
        live.onEvent = { liveEvents.trySend(it) }
        mic.onLevel = { _level.value = it }
        mic.sink = MicCapture.Sink { pcm, rms, ms, now ->
            player.onMicFrame(rms, meter.threshold, ms, now, meter.speechOnsetAtMs)
            gate.onFrame(pcm, now)
        }
        player.onBargeIn = { onset -> bargeInAt = onset }
        viewModelScope.launch { for (e in liveEvents) onLive(e) }
    }

    // ---------- taps ----------

    /** The orb: start, interrupt Sakhi, or "I'm done speaking". Call only with the mic permission granted. */
    fun onOrbTap() {
        val s = _state.value
        when {
            s.session != SessionState.LIVE -> start()
            s.phase == Phase.SPEAKING -> { tapInterrupt = true; player.stop() }
            s.phase == Phase.LISTENING -> collector?.manual(immediate = false, nowMs = now())
        }
    }

    fun restart() { stop(); _state.value = UiState(); start() }

    /** The app went to the background: a voice conversation can't continue unseen, so it stops. */
    fun onBackgrounded() {
        if (_state.value.session != SessionState.LIVE) return
        stop()
        _state.update { it.copy(session = SessionState.IDLE, phase = Phase.IDLE, notice = false) }
    }

    // ---------- the conversation ----------

    private fun start() {
        if (job?.isActive == true) return
        _state.update { it.copy(notice = false, session = SessionState.LIVE, phase = Phase.THINKING) }
        job = viewModelScope.launch {
            try {
                val status = c.api.status()
                if (!status.ready) throw IOException(status.reason ?: "server not ready")
                if (!mic.isRunning && !mic.start()) throw IOException("microphone unavailable")
                routing.enter { viewModelScope.launch { onBackgrounded() } }
                if (!live.connect()) throw IOException("speech service: ${live.lastFailure}")
                run()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Conversation stopped", e)
                stop()
                val refused = e as? ServerException
                if (refused != null && (refused.status == 401 || refused.error == "consent_required")) c.refusals.tryEmit(refused)
                _state.update { it.copy(session = SessionState.IDLE, phase = Phase.IDLE, notice = refused == null || refused.status >= 500) }
            }
        }
    }

    private suspend fun run() {
        backchannels = viewModelScope.async { loadBackchannels() }
        var turn = c.api.startSession()
        sessionId = turn.sessionId
        c.events.log("assessment.opened", sessionId = turn.sessionId)
        live.bind(turn.sessionId)
        thinking()
        delay(500)
        while (true) {
            tapInterrupt = false
            _state.update { it.copy(learnerLanguage = turn.learnerLanguage) }
            // The card: a new one appears (or is dealt) on its cue word; no card puts it away; the same card stays.
            val next = turn.card
            val shownCard = _state.value.card?.card
            val change = next != null && (shownCard == null || shownCard.text != next.text)
            if (next == null && shownCard != null && turn.done == null) exitCard()
            if (next != null && !change && turn.say.any { it.lang == "hi-IN" }) _state.update { s -> s.copy(card = s.card?.copy(hindiLocked = true)) }
            var cardShown = !change
            val revealCard = { if (!cardShown && next != null) { cardShown = true; showCard(next) } }
            val cue = turn.cue

            var interrupted: Interrupted? = null
            for ((i, line) in turn.say.withIndex()) {
                if (turn.done != null && i == 0) exitCard()
                val r = speak(line) { n -> if (cue != null && i == cue.line && n > cue.word) revealCard() }
                if (cue == null || i >= cue.line) revealCard()
                if (r?.stoppedBy == VoicePlayer.Stop.BARGE_IN) { interrupted = Interrupted(i, r.heardSec); break }
            }
            if (turn.done == null) revealCard()
            val done = turn.done
            if (done != null && interrupted == null) return showResult(done)

            val (ans, timing) = listen(turn.listen ?: ListenSpec())
            val req = when (ans.end) {
                AnswerEnd.NO_SPEECH -> TurnRequest(turn.sessionId, "no_speech")
                AnswerEnd.LIVE_FAILED -> TurnRequest(turn.sessionId, "live_failed")
                else -> TurnRequest(turn.sessionId, "answer", ans.transcript, ans.language, ans.speechSec,
                    timing?.let { Timing(it.spanSec, it.voicedSec, it.pauses) }, interrupted)
            }
            if (req.event == "answer" && !req.transcript.isNullOrBlank()) _state.update { s -> s.copy(card = s.card?.copy(answered = true)) }
            val words = req.transcript?.trim()?.split(Regex("\\s+"))?.count { it.isNotEmpty() } ?: 0
            var replied = false
            val reacting = if (req.event == "answer" && words >= 3) viewModelScope.async { backchannel { replied } } else null
            setPhase(Phase.THINKING)
            sent()
            turn = c.api.turn(req)
            replied = true
            if (reacting?.await() == true) turn = dropRepeatedAck(turn)
        }
    }

    private fun showResult(r: Result) {
        c.events.log("result.viewed", mapOf("level" to r.level.toString()), sessionId)
        exitCard()
        _state.update { it.copy(session = SessionState.RESULT, phase = Phase.IDLE, result = r) }
        stopAudio()
    }

    // ---------- speaking ----------

    private suspend fun speak(line: Line, onWord: (Int) -> Unit): VoicePlayer.Outcome? {
        val reveal = WordReveal(line.text, line.pace)
        val id = sakhiLine(reveal.words, line.lang)
        var shown = 0
        val show = { n: Int -> if (n > shown) { shown = n; updateMessage(id) { it.copy(shown = n) }; onWord(n) } }
        return try {
            val voice = c.api.speak(SpeakRequest(line.text, line.lang, line.pace, sessionId))
            val out = voice.use {
                player.play(it.body, it.sampleRate, onStart = { setPhase(Phase.SPEAKING) }) { p ->
                    _level.value = p.level
                    show(reveal.shown(p.playedSec, p.receivedSec, p.complete))
                }
            }
            _level.value = 0f
            val cut = out.stoppedBy == VoicePlayer.Stop.BARGE_IN || (out.stoppedBy != null && tapInterrupt)
            if (cut) {
                updateMessage(id) { it.copy(shown = maxOf(1, shown), words = it.words.take(maxOf(1, shown)), cut = true) }
                if (bargeInAt == null) bargeInAt = now() // a tap: listen from now
                return out.copy(stoppedBy = VoicePlayer.Stop.BARGE_IN)
            }
            show(reveal.words.size)
            out
        } catch (e: IOException) {
            Log.w(TAG, "Voice failed; showing the line as text", e)
            show(reveal.words.size)
            delay(1500)
            null
        }
    }

    // ---------- listening ----------

    private suspend fun listen(spec: ListenSpec): Pair<CollectedAnswer, com.sakhi.app.audio.SpeechTiming?> {
        if (bargeInAt == null) haptics.yourTurn() // after an interruption they're already talking
        setPhase(Phase.LISTENING)
        val bubbleId = youLive()
        if (!live.ensureConnected()) {
            removeMessage(bubbleId)
            return CollectedAnswer("", null, null, 0.0, false, AnswerEnd.LIVE_FAILED) to null
        }
        sessionId?.let { live.bind(it) }
        live.configure(spec.silenceMs, spec.language)
        mic.metering = true
        val t = now()
        val talking = meter.speechOnsetAtMs
        val from = bargeInAt?.let { it - AudioGate.ONSET_MARGIN_MS }
            ?: talking?.let { minOf(t - AudioGate.PREROLL_MS, it - AudioGate.ONSET_MARGIN_MS) }
            ?: (t - AudioGate.PREROLL_MS)
        bargeInAt = null
        gate.startStreaming(from, t)
        meter.startTiming()
        val result = CompletableDeferred<CollectedAnswer>()
        val col = AnswerCollector(t, spec.language == "auto", object : AnswerCollector.Output {
            override fun partial(text: String) = updateMessage(bubbleId) { it.copy(words = words(text), shown = Int.MAX_VALUE) }
            override fun nudge() = _state.update { it.copy(waitNudge = true) }
            override fun redetectLanguage() = live.configure(language = "auto")
            override fun requestFinal() = live.finish()
            override fun done(answer: CollectedAnswer) { result.complete(answer) }
        })
        collector = col
        val ticker = viewModelScope.launch { while (!col.finished) { col.tick(now()); delay(100) } }
        val ans = try { result.await() } finally {
            ticker.cancel()
            collector = null
            gate.stopStreaming()
            mic.metering = false
            _level.value = 0f
            _state.update { it.copy(waitNudge = false) }
        }
        val timing = meter.stopTiming()
        if (ans.end == AnswerEnd.NO_SPEECH || ans.end == AnswerEnd.LIVE_FAILED || ans.transcript.isEmpty()) removeMessage(bubbleId)
        else updateMessage(bubbleId) { it.copy(words = words(ans.transcript), shown = Int.MAX_VALUE, live = false) }
        if (ans.transcript.isNotEmpty()) haptics.gotIt()
        return ans to (if (ans.spoke) timing else null)
    }

    private fun onLive(e: LiveEvent) {
        val col = collector
        val t = now()
        when (e.type) {
            "speech_start" -> col?.speechStart(e.idx, t)
            "partial" -> col?.partial(e.idx, e.text.orEmpty())
            "speech_end" -> col?.speechEnd(e.idx, t)
            "final" -> col?.final(e.idx, e.text, e.language, e.languageConfidence, e.speechSec, t)
            "dropped" -> col?.failed()
            "error" -> if (e.fatal) { live.close(); col?.failed() }
            "closed" -> { live.close(); col?.failed() }
        }
    }

    // ---------- quick reactions ----------

    private suspend fun loadBackchannels(): List<Pair<String, ByteArray>> = BACKCHANNELS.mapNotNull { text ->
        runCatching {
            c.api.speak(SpeakRequest(text, "en-IN", 1.0)).use { v -> text to trimSilence(v.body.readBytes(), v.sampleRate) }
        }.getOrNull()
    }

    /** A beat after they stop, if the reply isn't here yet: a soft "Okay." Returns whether one was said. */
    private suspend fun backchannel(replied: () -> Boolean): Boolean {
        delay(350)
        if (replied()) return false
        val clips = backchannels?.takeIf { it.isCompleted }?.await().orEmpty()
        val pool = clips.filter { it.first != lastBackchannel }.ifEmpty { clips }
        val (text, pcm) = pool.randomOrNull() ?: return false
        lastBackchannel = text
        player.play(ByteArrayInputStream(pcm), 24_000, volume = 0.8f)
        return true
    }

    // ---------- screen state helpers ----------

    private fun setPhase(p: Phase) = _state.update { if (it.phase == p) it else it.copy(phase = p, waitNudge = if (p == Phase.LISTENING) it.waitNudge else false) }

    private fun thinking() = _state.update { s ->
        if (s.messages.any { it.thinking }) s else s.copy(phase = Phase.THINKING, messages = trim(s.messages + Message(++ids, true, emptyList(), thinking = true)))
    }

    private fun sent() = thinking()

    /** Sakhi starts a line: it replaces the "…" bubble if there is one. */
    private fun sakhiLine(words: List<String>, lang: String): Long {
        val id = ++ids
        _state.update { s ->
            val msg = Message(id, true, words, shown = 0, lang = lang)
            val i = s.messages.indexOfFirst { it.thinking }
            s.copy(messages = trim(if (i >= 0) s.messages.toMutableList().also { it[i] = msg } else s.messages + msg))
        }
        return id
    }

    private fun youLive(): Long {
        val id = ++ids
        _state.update { s -> s.copy(messages = trim(s.messages.filterNot { it.thinking } + Message(id, false, emptyList(), live = true))) }
        return id
    }

    private fun updateMessage(id: Long, f: (Message) -> Message) =
        _state.update { s -> s.copy(messages = s.messages.map { if (it.id == id) f(it) else it }) }

    private fun removeMessage(id: Long) = _state.update { s -> s.copy(messages = s.messages.filterNot { it.id == id }) }

    private fun showCard(card: Card) = _state.update { s ->
        val deal = (s.card?.deal ?: 0) + 1
        s.copy(card = CardState(card, deal))
    }

    private fun exitCard() = _state.update { it.copy(card = null) }

    private fun trim(list: List<Message>) = if (list.size > MAX_MESSAGES) list.takeLast(MAX_MESSAGES) else list
    private fun words(t: String) = t.split(Regex("\\s+")).filter { it.isNotEmpty() }

    // ---------- teardown ----------

    private fun stopAudio() {
        player.stop()
        gate.reset()
        live.close()
        mic.stop()
        runCatching { routing.exit() }
    }

    private fun stop() {
        job?.cancel(); job = null
        collector = null
        stopAudio()
        _level.value = 0f
    }

    override fun onCleared() { stop() }

    private fun now() = SystemClock.elapsedRealtime()

    private companion object {
        const val TAG = "Sakhi"
        const val MAX_MESSAGES = 9
    }
}
