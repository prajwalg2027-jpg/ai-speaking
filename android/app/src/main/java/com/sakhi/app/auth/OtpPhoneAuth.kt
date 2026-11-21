package com.sakhi.app.auth

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.sakhi.app.net.SakhiJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

@Serializable private data class SendBody(val phone: String)
@Serializable private data class ResendBody(val requestId: String)
@Serializable private data class VerifyBody(val requestId: String, val code: String, val client: String = "android")
@Serializable private data class Sent(val requestId: String, val codeLength: Int = 6, val resendAfterSec: Int = 30)
@Serializable private data class SessionUser(val id: String, val phone: String)
@Serializable private data class Session(val token: String, val expiresAt: String, val user: SessionUser? = null)
@Serializable private data class Refusal(val error: String? = null, val reason: String? = null)

/**
 * Phone OTP sign-in through the Adam server, which sends and checks the code with MSG91 (server/login.js).
 * Signing in gives a session token, kept in the app's private storage and refreshed well before it expires
 * (60 days); signing out ends the session on the server too.
 *
 * Uses its own plain HTTP client: these requests must never go through the login interceptor.
 */
class OtpPhoneAuth(
    private val prefs: SharedPreferences,
    private val serverUrl: () -> String,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build(),
    private val now: () -> Instant = Instant::now,
) : PhoneAuth {
    constructor(context: Context, serverUrl: () -> String) :
        this(context.getSharedPreferences("adam.session", Context.MODE_PRIVATE), serverUrl)

    private val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val refreshing = Mutex()
    private var lastRequestId: String? = null

    override val configured = true

    override val currentUser: AuthUser?
        get() {
            val token = prefs.getString(TOKEN, null) ?: return null
            if (expiry()?.isAfter(now()) != true) return null
            return AuthUser(prefs.getString(USER_ID, null) ?: token.take(8), prefs.getString(PHONE, null))
        }

    private fun expiry(): Instant? = prefs.getString(EXPIRES, null)?.let { runCatching { Instant.parse(it) }.getOrNull() }

    override suspend fun idToken(force: Boolean): String? {
        val token = prefs.getString(TOKEN, null) ?: return null
        val exp = expiry() ?: return null
        val soon = exp.isBefore(now().plusSeconds(REFRESH_BEFORE_SEC))
        if (!force && !soon) return token
        return refreshing.withLock {
            val current = prefs.getString(TOKEN, null) ?: return@withLock null
            if (current != token) return@withLock current // refreshed meanwhile
            try {
                val (code, body) = post("/api/auth/refresh", "{}", bearer = token)
                when {
                    code == 401 -> { clear(); null }
                    code in 200..299 -> SakhiJson.decodeFromString<Session>(body).also(::save).token
                    else -> if (exp.isAfter(now())) token else null
                }
            } catch (e: IOException) { if (exp.isAfter(now())) token else null } // offline: keep the one we have
        }
    }

    override suspend fun sendCode(activity: Activity, phone: String, resend: Boolean): CodeResult = request {
        val id = lastRequestId
        if (resend && id != null) {
            val (code, body) = post("/api/auth/otp/resend", SakhiJson.encodeToString(ResendBody.serializer(), ResendBody(id)))
            if (code in 200..299) CodeResult.Sent(id) else failure(code, body)
        } else {
            val (code, body) = post("/api/auth/otp/send", SakhiJson.encodeToString(SendBody.serializer(), SendBody(phone)))
            if (code in 200..299) {
                val s = SakhiJson.decodeFromString<Sent>(body)
                lastRequestId = s.requestId
                CodeResult.Sent(s.requestId)
            } else failure(code, body)
        }
    }

    override suspend fun verifyCode(verificationId: String, code: String): CodeResult = request {
        val (status, body) = post("/api/auth/otp/verify", SakhiJson.encodeToString(VerifyBody.serializer(), VerifyBody(verificationId, code)))
        if (status in 200..299) { save(SakhiJson.decodeFromString<Session>(body)); lastRequestId = null; CodeResult.SignedIn } else failure(status, body)
    }

    override fun signOut() {
        val token = prefs.getString(TOKEN, null)
        clear()
        if (token != null) background.launch { runCatching { post("/api/auth/logout", "{}", bearer = token) } }
    }

    private fun save(s: Session) = prefs.edit {
        putString(TOKEN, s.token)
        putString(EXPIRES, s.expiresAt)
        s.user?.let { putString(USER_ID, it.id); putString(PHONE, it.phone) }
    }

    private fun clear() = prefs.edit { remove(TOKEN); remove(EXPIRES); remove(USER_ID); remove(PHONE) }

    private suspend fun request(block: suspend () -> CodeResult): CodeResult = try { block() }
        catch (e: IOException) { CodeResult.Failed(Reason.NETWORK, e.message) }
        catch (e: Exception) { CodeResult.Failed(Reason.OTHER, e.message) }

    private fun failure(code: Int, body: String): CodeResult.Failed {
        val r = runCatching { SakhiJson.decodeFromString<Refusal>(body) }.getOrNull()
        val reason = when (r?.error) {
            "invalid_number" -> Reason.INVALID_NUMBER
            "too_many_requests" -> Reason.TOO_MANY_REQUESTS
            "wrong_code" -> Reason.WRONG_CODE
            "code_expired" -> Reason.CODE_EXPIRED
            else -> if (code == 429) Reason.TOO_MANY_REQUESTS else Reason.OTHER
        }
        return CodeResult.Failed(reason, r?.reason)
    }

    private suspend fun post(path: String, json: String, bearer: String? = null): Pair<Int, String> = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(serverUrl().trimEnd('/') + path).post(json.toRequestBody(JSON))
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }.build()
        http.newCall(req).execute().use { it.code to it.body.string() }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        const val REFRESH_BEFORE_SEC = 7L * 86400 // refresh when less than a week is left
        const val TOKEN = "token"
        const val EXPIRES = "expiresAt"
        const val USER_ID = "userId"
        const val PHONE = "phone"
    }
}
