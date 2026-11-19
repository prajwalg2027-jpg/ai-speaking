package com.sakhi.app

import android.app.Application
import com.sakhi.app.config.ServerConfig
import com.sakhi.app.net.LiveConnection
import com.sakhi.app.net.SakhiApi
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** The app's shared objects, created once (manual dependency injection: small, fast to build, no magic). */
class AppContainer(app: Application) {
    val server = ServerConfig(app)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS) // keeps the live speech connection open through idle moments
        .build()
    val api = SakhiApi(http) { server.baseUrl }
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
