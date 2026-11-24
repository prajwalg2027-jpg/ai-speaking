package com.sakhi.app.net

import kotlinx.serialization.Serializable

// The learning module's JSON (server/learning/api.js, docs/LEARNING.md › API). Unknown fields are ignored.

@Serializable
data class LearnProfile(
    val name: String? = null,
    val correctionIntensity: String = "balanced",
    val goals: List<String> = emptyList(),
    val supportLanguage: String? = null,
    val level: Int? = null,
    val placementLevel: Int? = null,
    val levelConfidence: Double? = null,
    /** The learner's own switch for Sakhi's memory of them. */
    val memoryEnabled: Boolean = true,
)

/** PATCH /api/learn/preferences: only the fields that are set are changed. */
@Serializable data class LearnPreferences(val correctionIntensity: String? = null, val goals: List<String>? = null, val memoryEnabled: Boolean? = null)

/** One thing Sakhi remembers about the learner (GET /api/learn/memory). */
@Serializable
data class MemoryItem(
    val id: Long,
    /** fact | goal | event | interest | preference */
    val kind: String = "fact",
    val content: String,
    /** Events: the day it happens (YYYY-MM-DD). */
    val dueOn: String? = null,
    /** placement | conversation */
    val source: String? = null,
)

/** What an earlier practice conversation was about. */
@Serializable data class MemoryConversation(val id: String, val summary: String, val topics: List<String> = emptyList(), val startedAt: String? = null)

/** Everything Sakhi remembers; [enabled] is false when the learner (or the admin) switched memory off. */
@Serializable data class LearnerMemory(val enabled: Boolean = true, val items: List<MemoryItem> = emptyList(), val conversations: List<MemoryConversation> = emptyList())

@Serializable
data class LearnActivity(
    val messages: Int = 0,
    val conversations: Int = 0,
    val lessonsCompleted: Int = 0,
    val mistakesThisWeek: Int = 0,
    val correctUsesThisWeek: Int = 0,
)

@Serializable
data class Skill(
    val concept: String,
    val category: String? = null,
    val mistakes: Int = 0,
    val correctUses: Int = 0,
    val mastery: Double = 0.0,
    /** learning | practising | mastered */
    val status: String = "learning",
)

@Serializable
data class LearnProgress(
    val level: Int? = null,
    val placementLevel: Int? = null,
    val levelConfidence: Double? = null,
    val activity: LearnActivity = LearnActivity(),
    val skills: List<Skill> = emptyList(),
    /** Concepts to practise most (top 3). */
    val focus: List<String> = emptyList(),
)

@Serializable
data class ConversationInfo(
    val id: String,
    /** conversation (free practice) | lesson */
    val mode: String = "conversation",
    val title: String? = null,
    val lessonSessionId: String? = null,
    val startedAt: String? = null,
    val lastMessageAt: String? = null,
    val lastMessage: String? = null,
    val messageCount: Int = 0,
)

@Serializable
data class Correction(
    val id: String? = null,
    val original: String,
    val corrected: String,
    val category: String? = null,
    val concept: String? = null,
    val explanation: String? = null,
    val severity: String? = null,
)

@Serializable
data class ChatMessage(
    val id: String,
    /** learner | tutor */
    val role: String,
    val content: String,
    val channel: String = "text",
    val createdAt: String? = null,
    val replyTo: String? = null,
    val encouragement: String? = null,
    val followUpQuestion: String? = null,
    val corrections: List<Correction> = emptyList(),
)

@Serializable data class ConversationList(val conversations: List<ConversationInfo> = emptyList())
@Serializable data class ConversationWithMessages(val conversation: ConversationInfo, val messages: List<ChatMessage> = emptyList())
@Serializable data class NewConversation(val title: String? = null)

@Serializable
data class SendMessage(
    val message: String,
    /** text | voice */
    val channel: String = "text",
    val clientMessageId: String? = null,
    val sttConfidence: Double? = null,
)

/** Sakhi's reply as it is streamed first (event "reply"): before the corrections are checked. */
@Serializable data class EarlyReply(val reply: String, val encouragement: String? = null, val followUpQuestion: String? = null)

@Serializable data class TutorReply(val id: String? = null, val text: String, val encouragement: String? = null, val followUpQuestion: String? = null)
@Serializable data class LearnerMessageRef(val id: String, val content: String = "", val channel: String = "text")

/** The whole answer to a learner's message (event "done", or the plain JSON answer). */
@Serializable
data class MessageResult(
    val conversationId: String? = null,
    val learnerMessage: LearnerMessageRef? = null,
    val reply: TutorReply,
    val corrections: List<Correction> = emptyList(),
    val replayed: Boolean = false,
)

@Serializable data class CorrectionsEvent(val corrections: List<Correction> = emptyList())

@Serializable data class LessonProgress(val sessionId: String, val status: String = "active", val position: Int = 1, val correct: Int = 0)

@Serializable
data class Lesson(
    val id: String,
    val category: String? = null,
    val title: String,
    val level: Int? = null,
    val objective: String? = null,
    val summary: String? = null,
    val explanation: String? = null,
    val examples: List<String> = emptyList(),
    val exerciseCount: Int = 0,
    val progress: LessonProgress? = null,
    val completedTimes: Int = 0,
)

@Serializable data class LessonList(val lessons: List<Lesson> = emptyList())

@Serializable
data class Exercise(
    val id: String,
    val position: Int = 1,
    /** fill_blank | choose | transform | free_response | … */
    val kind: String,
    val prompt: String,
    val options: List<String>? = null,
)

@Serializable
data class LessonState(
    val sessionId: String,
    /** active | completed */
    val status: String = "active",
    val position: Int = 1,
    val correct: Int = 0,
    val attempts: Int = 0,
    val total: Int = 0,
    val conversationId: String? = null,
    val lesson: Lesson,
    val exercise: Exercise? = null,
)

@Serializable data class AttemptRequest(val exerciseId: String, val answer: String, val channel: String = "text", val clientAttemptId: String? = null)
@Serializable data class LessonSummary(val correct: Int = 0, val total: Int = 0)

@Serializable
data class AttemptResult(
    /** correct | partly | incorrect; null when the answer couldn't be marked (e.g. not one of the options). */
    val verdict: String? = null,
    val feedback: String = "",
    val corrections: List<Correction> = emptyList(),
    /** Wrong first try: a hint, and one more go. */
    val tryAgain: Boolean = false,
    /** The right answer, shown once the lesson moves on after a wrong answer. */
    val answer: String? = null,
    val explanation: String? = null,
    val state: LessonState,
    /** Set when this answer finished the lesson. */
    val summary: LessonSummary? = null,
    val replayed: Boolean = false,
)

@Serializable data class Transcript(val text: String = "", val languageCode: String? = null, val seconds: Double? = null)
