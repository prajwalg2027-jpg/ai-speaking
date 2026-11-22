package com.sakhi.app.auth

import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * Every request to the server (and the live speech connection) carries the login token. If the server says
 * 401 anyway (an expired token), one retry with a fresh token. These run on OkHttp's background threads.
 */
class AuthInterceptor(private val auth: PhoneAuth) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = runCatching { runBlocking { auth.idToken() } }.getOrNull()
        val req = chain.request()
        return chain.proceed(if (token == null) req else req.newBuilder().header("Authorization", "Bearer $token").build())
    }
}

class AuthRefresher(private val auth: PhoneAuth) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.priorResponse != null) return null // already retried once
        val token = runCatching { runBlocking { auth.idToken(force = true) } }.getOrNull() ?: return null
        return response.request.newBuilder().header("Authorization", "Bearer $token").build()
    }
}
