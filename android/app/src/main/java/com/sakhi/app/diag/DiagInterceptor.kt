package com.sakhi.app.diag

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import java.util.UUID

/**
 * Every request: a request id (x-request-id, also in the server's Cloud Run log), the phone's diagnostics code
 * when it sends diagnostics (x-adam-diag: the server then adds its own side to the same log), and a line in
 * [Diag] with the status and the time to the answer's headers. Only the path is logged: no bodies, no headers.
 */
class DiagInterceptor(private val code: () -> String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val path = original.url.encodedPath
        val rid = UUID.randomUUID().toString().replace("-", "").take(16)
        val req = original.newBuilder().header("x-request-id", rid).apply { if (Diag.enabled) header("x-adam-diag", code()) }.build()
        if (path.startsWith("/api/diag/")) return chain.proceed(req)
        val t0 = System.nanoTime()
        val res = try { chain.proceed(req) } catch (e: IOException) {
            Diag.log("net", "http.failed", "method" to req.method, "path" to path, "ms" to (System.nanoTime() - t0) / 1_000_000, "rid" to rid, "error" to "${e.javaClass.simpleName}: ${e.message}")
            throw e
        }
        Diag.log("net", "http", "method" to req.method, "path" to path, "status" to res.code, "ms" to (System.nanoTime() - t0) / 1_000_000, "rid" to rid,
            "type" to res.header("Content-Type")?.substringBefore(';'))
        return res
    }
}
