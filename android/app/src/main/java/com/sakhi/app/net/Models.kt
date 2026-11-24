package com.sakhi.app.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The server's JSON (server/session.js respond()). Unknown fields are ignored so the server can grow. */
val SakhiJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

@Serializable data class Line(val text: String, val lang: String = "en-IN", val pace: Double = 1.0)

@Serializable data class Band(val en: String = "", val hi: String = "")

/** The task card: an emoji picture, a word, or a sentence to read. */
@Serializable data class Card(val text: String, val kind: String = "", val look: String = "sentence", val band: Band? = null)

/** Where the card appears: on this word of this line (where Sakhi starts asking). */
@Serializable data class Cue(val line: Int = 0, val word: Int = 0)

@Serializable data class ListenSpec(val silenceMs: Int = 1400, val language: String = "auto")

@Serializable data class TaskInfo(val id: String, val level: Int? = null, val kind: String? = null, val item: String? = null)

@Serializable data class AnswerSummary(val q: String, val transcript: String? = null)

@Serializable
data class Result(
    val level: Int,
    val name: String = "",
    val blurb: String = "",
    val hindi: String? = null,
    val overall: Double? = null,
    val dims: Map<String, Double?> = emptyMap(),
    val reasons: List<String> = emptyList(),
    val doingWell: List<String> = emptyList(),
    val practise: List<String> = emptyList(),
    val answers: List<AnswerSummary> = emptyList(),
)

@Serializable
data class Turn(
    val sessionId: String,
    val say: List<Line> = emptyList(),
    val card: Card? = null,
    val cue: Cue? = null,
    val learnerLanguage: String? = null,
    val listen: ListenSpec? = null,
    val task: TaskInfo? = null,
    val done: Result? = null,
)

/** Sakhi's reaction, sent ahead of the rest of her turn (see [SakhiApi.turn]). */
@Serializable data class TurnReply(val say: List<Line> = emptyList())

@Serializable data class Timing(val spanSec: Double, val voicedSec: Double, val pauses: List<Double>)

@Serializable data class Interrupted(val index: Int, val heardSec: Double)

@Serializable
data class TurnRequest(
    val sessionId: String,
    val event: String,
    val transcript: String? = null,
    val languageCode: String? = null,
    val speechSec: Double? = null,
    val timing: Timing? = null,
    val interrupted: Interrupted? = null,
)

@Serializable data class ServerStatus(val ready: Boolean = false, val reason: String? = null)

@Serializable data class SpeakRequest(val text: String, val lang: String, val pace: Double, val sessionId: String? = null)

/** Events from our /api/live relay (server/live.js). */
@Serializable
data class LiveEvent(
    val type: String,
    val idx: Int = -1,
    val text: String? = null,
    val language: String? = null,
    val languageConfidence: Double? = null,
    val speechSec: Double? = null,
    val reason: String? = null,
    val code: String? = null,
    val fatal: Boolean = false,
    val message: String? = null,
    @SerialName("requestId") val requestId: String? = null,
)

/** The signed-in customer (GET /api/me). */
@Serializable
data class Me(
    val id: String? = null,
    val phone: String? = null,
    val name: String? = null,
    val missingConsents: List<String> = emptyList(),
)

// ---- Payments (server/payments.js) ----
/** Whether the learning module needs a subscription, and whether they have one. */
@Serializable data class PayStatus(
    val required: Boolean = false,
    val active: Boolean = false,
    val priceInr: Int = 0,
    val status: String? = null,
    val paidUntil: String? = null,
    val cancelAtEnd: Boolean = false,
    /** "razorpay" or "play": who the latest subscription is with. */
    val provider: String? = null,
    /** Set when the server can take Google Play purchases (Play builds use them; null: Razorpay only). */
    val play: PlayOffer? = null,
)
/** The Play subscription product, and the id Play keeps on the purchase so the server knows whose it is. */
@Serializable data class PlayOffer(val productId: String, val accountId: String)
@Serializable data class PlayPurchase(val purchaseToken: String)
/** Starting a Razorpay subscription; [playExternalToken] when it was picked on Play's choice screen. */
@Serializable data class RazorpayStart(val playExternalToken: String? = null)
/** What Razorpay Checkout needs to take the first payment of a subscription. */
@Serializable data class CheckoutStart(val subscriptionId: String, val keyId: String, val priceInr: Int, val name: String, val description: String, val contact: String? = null)
@Serializable data class VerifyPayment(val paymentId: String, val subscriptionId: String, val signature: String)

@Serializable data class Consent(val purpose: String, val version: String, val granted: Boolean)
@Serializable data class ConsentsRequest(val consents: List<Consent>)
@Serializable data class MissingConsents(val missingConsents: List<String> = emptyList())

@Serializable
data class AppEvent(
    val name: String,
    val clientEventId: String,
    val occurredAt: String,
    val properties: Map<String, String> = emptyMap(),
    val sessionId: String? = null,
)
@Serializable data class EventsRequest(val events: List<AppEvent>)

/** GET /api/diag/status: whether this phone sends its diagnostic log (team numbers). */
@Serializable data class DiagStatus(val enabled: Boolean = false)

/** The server's error body: { error, reason?, missing? }. */
@Serializable data class ErrorBody(val error: String = "", val reason: String? = null, val missing: List<String> = emptyList())

// ---- The result screen's detailed feedback (GET /api/session/insights, server/placement/insights.js) ----------

/** A piece of a word-by-word difference: [k] is "same", "del" (what they said, taken out) or "add" (put in). */
@Serializable data class DiffPart(val t: String, val k: String = "same")

/** One answer: what they said, said the right way ([diff]), why, and the same idea one level up ([up]). */
@Serializable data class AnswerInsight(
    val i: Int = 0,
    val question: String = "",
    val said: String = "",
    val better: String = "",
    val same: Boolean = false,
    val diff: List<DiffPart> = emptyList(),
    val why: String? = null,
    val up: String? = null,
    val upDiff: List<DiffPart> = emptyList(),
    val upAdds: List<String> = emptyList(),
)

@Serializable data class BestSentence(val quote: String, val tags: List<String> = emptyList(), val why: String? = null)
@Serializable data class Rung(val level: Int, val text: String)
@Serializable data class Ladder(val you: Int, val rungs: List<Rung> = emptyList())
@Serializable data class HabitExample(val said: String, val better: String, val diff: List<DiffPart> = emptyList())
@Serializable data class Habit(val name: String, val rule: String, val examples: List<HabitExample> = emptyList())
@Serializable data class LocalTip(val title: String, val said: String, val better: String, val rule: String, val hindi: String? = null)

/** Counted by the server from their answers (not the AI). */
@Serializable data class SpokenCounts(
    val answers: Int = 0,
    val englishWords: Int = 0,
    val longestAnswer: Int = 0,
    val joiningWords: List<String> = emptyList(),
    val hindiWords: Int = 0,
)

/** Every part may be missing: the screen shows what there is. */
@Serializable data class Insights(
    val status: String = "ready",
    val level: Int = 0,
    val counts: SpokenCounts? = null,
    val answers: List<AnswerInsight> = emptyList(),
    val best: BestSentence? = null,
    val ladder: Ladder? = null,
    val habit: Habit? = null,
    val tip: LocalTip? = null,
) {
    val isEmpty get() = answers.isEmpty() && best == null && ladder == null && habit == null && tip == null && (counts?.answers ?: 0) == 0
}

/** A sentence said back (POST /api/session/sayback): each of its words, heard or not. */
@Serializable data class SaidWord(val t: String, val ok: Boolean = false)
@Serializable data class SayBack(val heard: String = "", val score: Double = 0.0, val matched: Int = 0, val total: Int = 0, val words: List<SaidWord> = emptyList())
