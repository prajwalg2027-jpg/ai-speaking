package com.sakhi.app

import android.app.Application
import com.sakhi.app.auth.AuthInterceptor
import com.sakhi.app.auth.AuthRefresher
import com.sakhi.app.auth.EventLog
import com.sakhi.app.auth.FirebasePhoneAuth
import com.sakhi.app.auth.PhoneAuth
import com.sakhi.app.config.ServerConfig
import com.sakhi.app.net.ServerException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import com.sakhi.app.net.LiveConnection
import com.sakhi.app.net.SakhiApi
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** The app's shared objects, created once (manual dependency injection: small, fast to build, no magic). */
class AppContainer(app: Application, val auth: PhoneAuth = FirebasePhoneAuth(app)) {
    val server = ServerConfig(app)
    /** Work that outlives a screen (sending events). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS) // keeps the live speech connection open through idle moments
        .apply { if (auth.configured) addInterceptor(AuthInterceptor(auth)).authenticator(AuthRefresher(auth)) }
        .build()
    val api = SakhiApi(http) { server.baseUrl }
    val events = EventLog({ api }, scope) { auth.currentUser != null }
    /** The server refused a request (login expired, consent missing): the sign-in flow takes over. */
    val refusals = MutableSharedFlow<ServerException>(extraBufferCapacity = 4)
    fun newLiveConnection() = LiveConnection(http) { server.baseUrl }
}

class SakhiApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
