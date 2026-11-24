package com.sakhi.app.learn

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sakhi.app.auth.EventLog
import com.sakhi.app.net.AttemptRequest
import com.sakhi.app.net.AttemptResult
import com.sakhi.app.net.ChatMessage
import com.sakhi.app.net.ConversationInfo
import com.sakhi.app.net.Correction
import com.sakhi.app.net.LearnApi
import com.sakhi.app.net.LearnPreferences
import com.sakhi.app.net.LearnProfile
import com.sakhi.app.net.LearnProgress
import com.sakhi.app.net.Lesson
import com.sakhi.app.net.LessonState
import com.sakhi.app.net.SendMessage
import com.sakhi.app.net.ServerException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.UUID

/** Where the learner is in the learning area. */
sealed interface LearnPage {
    data object Home : LearnPage
    /** A practice conversation (free, or the questions conversation of a lesson: [fromLesson]). */
    data class Chat(val conversationId: String, val fromLesson: String? = null) : LearnPage
    data class LessonPage(val sessionId: String) : LearnPage
}

/** The learning home: what to practise, the lessons, and how it's going. */
data class HomeState(
    val loading: Boolean = true,
    val profile: LearnProfile? = null,
    val progress: LearnProgress? = null,
    val lessons: List<Lesson> = emptyList(),
    val conversations: List<ConversationInfo> = emptyList(),
    val starting: Boolean = false,
    val error: String? = null,
)

/** One message on the chat screen. [key] is stable for the list; [id] is the server's, once known. */
data class ChatItem(
    val key: String,
    val fromSakhi: Boolean,
    val text: String,
    val id: String? = null,
    val voice: Boolean = false,
    val corrections: List<Correction> = emptyList(),
    /** Learner message: Sakhi has replied and her check of the corrections is still running. */
    val checking: Boolean = false,
    /** Learner message: it didn't go through; [ChatState.retry] sends it again. */
    val failed: Boolean = false,
    val followUp: String? = null,
)

enum class Mic { Off, Recording, Transcribing }

data class ChatState(
    val conversationId: String = "",
    val title: String? = null,
    val lessonSessionId: String? = null,
    val loading: Boolean = true,
    val items: List<ChatItem> = emptyList(),
    /** Waiting for Sakhi's reply. */
    val thinking: Boolean = false,
    val mic: Mic = Mic.Off,
    /** The message Sakhi's voice is playing, if any. */
    val playing: String? = null,
    val error: String? = null,
    /** The learner's last message failed: send it again with the same id. */
    val retry: Pending? = null,
)

data class Pending(val key: String, val text: String, val voice: Boolean, val clientId: String)

data class LessonUi(
    val loading: Boolean = true,
    val state: LessonState? = null,
    /** The answer to the last exercise (feedback, the right answer when it moved on). */
    val result: AttemptResult? = null,
    /** After a result that moved on: the learner reads the feedback, then taps Next. */
    val awaitingNext: Boolean = false,
    val busy: Boolean = false,
    val mic: Mic = Mic.Off,
    /** What the learner heard themselves say (voice answers), for the answer box. */
    val heard: String? = null,
    val error: String? = null,
)

data class LearnUi(
    val page: LearnPage = LearnPage.Home,
    val home: HomeState = HomeState(),
    val chat: ChatState = ChatState(),
    val lesson: LessonUi = LessonUi(),
)

/**
 * The learning module in the app (docs/LEARNING.md): free practice with Sakhi (her reply first, the checked
 * corrections a moment later), lessons (explanation, examples, exercises with feedback) and progress.
 * [onPaymentRequired] opens the paywall when the server says a subscription is needed (HTTP 402).
 */
class LearnViewModel(
    private val api: LearnApi,
    private val events: EventLog,
    private val voice: LearnVoice? = null,
    private val onPaymentRequired: () -> Unit = {},
) : ViewModel() {
    private val _ui = MutableStateFlow(LearnUi())
    val ui: StateFlow<LearnUi> = _ui.asStateFlow()
    /** The learner's level while recording (0..1), kept apart so the screen doesn't recompose the list with it. */
    private val _micLevel = MutableStateFlow(0f)
    val micLevel: StateFlow<Float> = _micLevel.asStateFlow()

    private var playJob: Job? = null

    // ---- home ------------------------------------------------------------------------------------

    fun loadHome() {
        _ui.update { it.copy(home = it.home.copy(loading = true, error = null)) }
        viewModelScope.launch {
            try {
                val profile = async { api.profile() }
                val progress = async { api.progress() }
                val lessons = async { api.lessons() }
                val conversations = async { api.conversations() }
                val h = HomeState(false, profile.await(), progress.await(), lessons.await(), conversations.await().filter { it.mode == "conversation" })
                _ui.update { it.copy(home = h) }
            } catch (e: IOException) {
                _ui.update { it.copy(home = it.home.copy(loading = false, error = message(e))) }
            }
        }
    }

    /** "Practise speaking": a new conversation with Sakhi; she greets the learner first. */
    fun startPractice() {
        if (_ui.value.home.starting) return
        _ui.update { it.copy(home = it.home.copy(starting = true, error = null)) }
        viewModelScope.launch {
            try {
                val c = api.newConversation()
                events.log("learn.practice.started")
                _ui.update { it.copy(page = LearnPage.Chat(c.conversation.id), home = it.home.copy(starting = false),
                    chat = ChatState(c.conversation.id, c.conversation.title, c.conversation.lessonSessionId, loading = false, items = c.messages.map(::item))) }
            } catch (e: IOException) {
                paywallIfNeeded(e)
                _ui.update { it.copy(home = it.home.copy(starting = false, error = message(e))) }
            }
        }
    }

    fun openConversation(id: String, fromLesson: String? = null) {
        _ui.update { it.copy(page = LearnPage.Chat(id, fromLesson), chat = ChatState(id)) }
        viewModelScope.launch {
            try {
                val c = api.conversation(id)
                _ui.update { u -> if (u.chat.conversationId != id) u else u.copy(chat = u.chat.copy(title = c.conversation.title,
                    lessonSessionId = c.conversation.lessonSessionId, loading = false, items = c.messages.map(::item))) }
            } catch (e: IOException) {
                _ui.update { u -> if (u.chat.conversationId != id) u else u.copy(chat = u.chat.copy(loading = false, error = message(e))) }
            }
        }
    }

    fun setIntensity(intensity: String) {
        val old = _ui.value.home.profile ?: return
        _ui.update { it.copy(home = it.home.copy(profile = old.copy(correctionIntensity = intensity))) }
        viewModelScope.launch {
            try { api.setPreferences(LearnPreferences(correctionIntensity = intensity)); events.log("learn.intensity", mapOf("intensity" to intensity)) }
            catch (e: IOException) { _ui.update { it.copy(home = it.home.copy(profile = old, error = message(e))) } }
        }
    }

    /** Back inside the learning area. → false at the learning home (the activity decides). */
    fun back(): Boolean {
        val page = _ui.value.page
        if (page == LearnPage.Home) return false
        stopVoice()
        if (page is LearnPage.Chat && page.fromLesson != null) { _ui.update { it.copy(page = LearnPage.LessonPage(page.fromLesson)) }; return true }
        _ui.update { it.copy(page = LearnPage.Home) }
        loadHome()
        return true
    }

    // ---- practice chat ----------------------------------------------------------------------------

    fun send(text: String, viaVoice: Boolean = false) {
        val t = text.trim()
        val chat = _ui.value.chat
        if (t.isEmpty() || chat.thinking || chat.conversationId.isEmpty()) return
        val p = Pending(UUID.randomUUID().toString(), t, viaVoice, UUID.randomUUID().toString())
        _ui.update { it.copy(chat = it.chat.copy(items = it.chat.items + ChatItem(p.key, false, t, voice = viaVoice))) }
        deliver(p)
    }

    /** The last message failed: send it again (same id, so it's answered once). */
    fun retry() { _ui.value.chat.retry?.let(::deliver) }

    private fun deliver(p: Pending) {
        val cid = _ui.value.chat.conversationId
        updateItem(p.key) { it.copy(failed = false) }
        _ui.update { it.copy(chat = it.chat.copy(thinking = true, error = null, retry = null)) }
        val replyKey = "reply-${p.key}"
        viewModelScope.launch {
            try {
                val r = api.send(cid, SendMessage(p.text, if (p.voice) "voice" else "text", p.clientId),
                    onReply = { early -> chatIf(cid) { c ->
                        c.copy(thinking = false, items = c.items.map { if (it.key == p.key) it.copy(checking = true) else it } +
                            ChatItem(replyKey, true, early.reply, followUp = early.followUpQuestion))
                    } },
                    onCorrections = { list -> chatIf(cid) { c -> c.copy(items = c.items.map { if (it.key == p.key) it.copy(corrections = list, checking = false) else it }) } })
                chatIf(cid) { c ->
                    val items = if (c.items.any { it.key == replyKey }) c.items else c.items + ChatItem(replyKey, true, r.reply.text)
                    c.copy(thinking = false, items = items.map {
                        when (it.key) {
                            p.key -> it.copy(id = r.learnerMessage?.id, corrections = r.corrections, checking = false)
                            replyKey -> it.copy(id = r.reply.id, text = r.reply.text, followUp = r.reply.followUpQuestion)
                            else -> it
                        }
                    })
                }
                events.log("learn.message", mapOf("channel" to if (p.voice) "voice" else "text", "corrections" to r.corrections.size.toString()))
            } catch (e: IOException) {
                paywallIfNeeded(e)
                chatIf(cid) { c ->
                    // Sakhi may already have replied before the failure: then only the corrections are lost.
                    val replied = c.items.any { it.key == replyKey }
                    c.copy(thinking = false, error = message(e), retry = if (replied) null else p,
                        items = c.items.map { if (it.key == p.key) it.copy(checking = false, failed = !replied) else it })
                }
            }
        }
    }

    /** Hear Sakhi say one of her messages (tap again to stop). */
    fun play(item: ChatItem) {
        val id = item.id ?: return
        val v = voice ?: return
        if (_ui.value.chat.playing == id) { stopVoice(); return }
        playJob?.cancel(); v.stopPlaying()
        _ui.update { it.copy(chat = it.chat.copy(playing = id)) }
        playJob = viewModelScope.launch {
            try { v.play(api.speech(id)) }
            catch (e: IOException) { _ui.update { it.copy(chat = it.chat.copy(error = message(e))) } }
            finally { _ui.update { u -> if (u.chat.playing == id) u.copy(chat = u.chat.copy(playing = null)) else u } }
        }
    }

    // ---- speaking (chat and lessons) ------------------------------------------------------------------

    /** Tap the mic: start recording (the caller holds RECORD_AUDIO). Tap again: stop, transcribe, send. */
    fun micTap() {
        val v = voice ?: return
        val inLesson = _ui.value.page is LearnPage.LessonPage
        when (if (inLesson) _ui.value.lesson.mic else _ui.value.chat.mic) {
            Mic.Off -> {
                playJob?.cancel(); _ui.update { it.copy(chat = it.chat.copy(playing = null)) }
                val ok = v.startRecording(onLevel = { _micLevel.value = it }, onFull = { viewModelScope.launch { finishRecording() } })
                if (ok) setMic(inLesson, Mic.Recording) else setError(inLesson, "The microphone isn't available right now.")
            }
            Mic.Recording -> finishRecording()
            Mic.Transcribing -> Unit
        }
    }

    private fun finishRecording() {
        val v = voice ?: return
        val inLesson = _ui.value.page is LearnPage.LessonPage
        if ((if (inLesson) _ui.value.lesson.mic else _ui.value.chat.mic) != Mic.Recording) return
        _micLevel.value = 0f
        val wav = v.stopRecording()
        if (wav == null) { setMic(inLesson, Mic.Off); setError(inLesson, "I didn't catch that. Tap the mic, speak, then tap again."); return }
        setMic(inLesson, Mic.Transcribing)
        viewModelScope.launch {
            try {
                val t = api.transcribe(wav).text.trim()
                setMic(inLesson, Mic.Off)
                if (t.isEmpty()) setError(inLesson, "I didn't catch that. Please try again.")
                else if (inLesson) _ui.update { it.copy(lesson = it.lesson.copy(heard = t)) }
                else send(t, viaVoice = true)
            } catch (e: IOException) {
                paywallIfNeeded(e)
                setMic(inLesson, Mic.Off); setError(inLesson, message(e))
            }
        }
    }

    private fun setMic(inLesson: Boolean, m: Mic) = _ui.update { if (inLesson) it.copy(lesson = it.lesson.copy(mic = m)) else it.copy(chat = it.chat.copy(mic = m)) }
    private fun setError(inLesson: Boolean, e: String) = _ui.update { if (inLesson) it.copy(lesson = it.lesson.copy(error = e)) else it.copy(chat = it.chat.copy(error = e)) }

    fun stopVoice() {
        playJob?.cancel(); playJob = null
        voice?.stopPlaying(); voice?.cancelRecording()
        _micLevel.value = 0f
        _ui.update { it.copy(chat = it.chat.copy(playing = null, mic = if (it.chat.mic == Mic.Recording) Mic.Off else it.chat.mic),
            lesson = it.lesson.copy(mic = if (it.lesson.mic == Mic.Recording) Mic.Off else it.lesson.mic)) }
    }

    // ---- lessons ------------------------------------------------------------------------------------

    fun openLesson(lessonId: String) {
        _ui.update { it.copy(page = LearnPage.LessonPage(""), lesson = LessonUi()) }
        viewModelScope.launch {
            try {
                val s = api.startLesson(lessonId)
                events.log("learn.lesson.opened", mapOf("lesson" to lessonId))
                _ui.update { it.copy(page = LearnPage.LessonPage(s.sessionId), lesson = LessonUi(loading = false, state = s)) }
            } catch (e: IOException) {
                paywallIfNeeded(e)
                _ui.update { it.copy(lesson = it.lesson.copy(loading = false, error = message(e))) }
            }
        }
    }

    private var attemptId: Pair<String, String>? = null // (exerciseId + answer) → its client id, so a retry isn't counted twice

    fun answer(text: String, viaVoice: Boolean = false) {
        val l = _ui.value.lesson
        val s = l.state ?: return
        val ex = s.exercise ?: return
        val a = text.trim()
        if (a.isEmpty() || l.busy) return
        val key = "${ex.id}\u0000$a"
        val clientId = attemptId?.takeIf { it.first == key }?.second ?: UUID.randomUUID().toString().also { attemptId = key to it }
        _ui.update { it.copy(lesson = it.lesson.copy(busy = true, error = null)) }
        viewModelScope.launch {
            try {
                val r = api.answer(s.sessionId, AttemptRequest(ex.id, a, if (viaVoice) "voice" else "text", clientId))
                attemptId = null
                val movedOn = !r.tryAgain && r.verdict != null
                events.log("learn.exercise", mapOf("lesson" to s.lesson.id, "verdict" to (r.verdict ?: "invalid")))
                if (r.summary != null) events.log("learn.lesson.completed", mapOf("lesson" to s.lesson.id, "correct" to r.summary.correct.toString(), "total" to r.summary.total.toString()))
                // Moved on: keep showing this exercise with its feedback until the learner taps Next.
                _ui.update { it.copy(lesson = it.lesson.copy(busy = false, result = r, awaitingNext = movedOn, heard = null,
                    state = if (movedOn) it.lesson.state?.copy(status = r.state.status, correct = r.state.correct) else r.state)) }
                pendingState = if (movedOn) r.state else null
            } catch (e: IOException) {
                paywallIfNeeded(e)
                // 409: the lesson moved on elsewhere (another phone, a retry): show where it is now.
                if (e is ServerException && e.status == 409) runCatching { api.lessonState(s.sessionId) }.getOrNull()?.let { st ->
                    _ui.update { it.copy(lesson = LessonUi(loading = false, state = st)) }; return@launch
                }
                _ui.update { it.copy(lesson = it.lesson.copy(busy = false, error = message(e))) }
            }
        }
    }

    private var pendingState: LessonState? = null

    /** After the feedback: the next exercise (or the lesson's summary). */
    fun next() {
        val st = pendingState ?: return
        pendingState = null
        _ui.update { it.copy(lesson = it.lesson.copy(state = st, result = if (st.status == "completed") it.lesson.result else null, awaitingNext = false, heard = null)) }
    }

    /** "Ask Sakhi about this lesson": the lesson's own conversation. */
    fun askAboutLesson() {
        val s = _ui.value.lesson.state ?: return
        val cid = s.conversationId ?: return
        openConversation(cid, fromLesson = s.sessionId)
    }

    fun clearHeard() = _ui.update { it.copy(lesson = it.lesson.copy(heard = null)) }

    // ---- helpers ------------------------------------------------------------------------------------

    private fun item(m: ChatMessage) = ChatItem(m.id, m.role == "tutor", m.content, m.id, m.channel == "voice", m.corrections, followUp = m.followUpQuestion)

    private fun updateItem(key: String, f: (ChatItem) -> ChatItem) = _ui.update { u -> u.copy(chat = u.chat.copy(items = u.chat.items.map { if (it.key == key) f(it) else it })) }

    /** Change the chat only if it is still the same conversation. */
    private fun chatIf(id: String, f: (ChatState) -> ChatState) = _ui.update { u -> if (u.chat.conversationId == id) u.copy(chat = f(u.chat)) else u }

    private fun paywallIfNeeded(e: IOException) { if (e is ServerException && e.status == 402) onPaymentRequired() }

    override fun onCleared() { stopVoice() }

    companion object {
        fun message(e: IOException): String {
            com.sakhi.app.diag.Diag.error("learn", "error", e, "status" to (e as? ServerException)?.status) // every error the learning area shows comes here
            if (e !is ServerException) return "Adam couldn't reach the server. Check your internet and try again."
            val reason = e.reason
            return when {
                e.status == 402 -> reason ?: "Learning with Sakhi needs a subscription."
                reason != null -> reason
                e.status == 429 -> "That's a lot of practice for one day! Let's continue tomorrow."
                e.status == 503 -> "Learning isn't available right now. Please try again later."
                else -> "Sorry, something went wrong. Please try again."
            }
        }

        val INTENSITIES = listOf("gentle", "balanced", "strict")
    }
}
