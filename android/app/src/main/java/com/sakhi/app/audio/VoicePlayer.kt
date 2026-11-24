package com.sakhi.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.InputStream
import kotlin.math.sqrt

/**
 * Plays Sakhi's voice as it streams in (16-bit mono PCM), so she starts talking with the first bytes.
 * While she talks, every mic frame goes through a [BargeInDetector]: she dips when the learner speaks
 * and stops if they keep going. Uses the voice-communication stream, which the echo canceller listens to.
 */
class VoicePlayer {
    enum class Stop { BARGE_IN, APP }
    /** [stalled]: the voice stopped arriving mid-line (the voice service throttled or hung), so the line was cut short. */
    data class Outcome(val stoppedBy: Stop?, val heardSec: Double, val totalSec: Double, val stalled: Boolean = false)
    data class Progress(val playedSec: Double, val receivedSec: Double, val complete: Boolean, val level: Float)

    /** The learner talked over Sakhi; called on the mic thread with when their speech began. */
    @Volatile var onBargeIn: (onsetMs: Long?) -> Unit = {}

    private class Active(val track: AudioTrack, val detector: BargeInDetector, val volume: Float, val stream: InputStream) {
        @Volatile var stoppedBy: Stop? = null
    }
    @Volatile private var active: Active? = null

    val isPlaying get() = active != null

    /** Mic frame while Sakhi talks (mic thread). */
    fun onMicFrame(rms: Float, threshold: Float, ms: Float, nowMs: Long, speechOnsetMs: Long?) {
        val a = active ?: return
        if (a.stoppedBy != null) return
        when (val act = a.detector.frame(rms, threshold, ms, nowMs, a.volume)) {
            is BargeInDetector.Action.SetVolume -> runCatching { a.track.setVolume(act.volume) }
            BargeInDetector.Action.BargeIn -> { halt(a, Stop.BARGE_IN); onBargeIn(speechOnsetMs ?: (nowMs - 300)) }
            BargeInDetector.Action.None -> Unit
        }
    }

    /** Stop now (a tap on the orb, or the app is leaving). */
    fun stop() { active?.let { halt(it, Stop.APP) } }

    private fun halt(a: Active, why: Stop) {
        if (a.stoppedBy != null) return
        a.stoppedBy = why
        runCatching { a.track.pause(); a.track.flush() }
        runCatching { a.stream.close() } // unblocks a read that's waiting on the network
    }

    suspend fun play(
        stream: InputStream,
        sampleRate: Int,
        volume: Float = 1f,
        onStart: () -> Unit = {},
        onProgress: (Progress) -> Unit = {},
    ): Outcome = withContext(Dispatchers.IO) {
        val min = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(min, sampleRate / 5 * 2))
            .build()
        track.setVolume(volume)
        val a = Active(track, BargeInDetector(), volume, stream)
        active = a
        val levelStep = sampleRate / 50 // a level value every 20 ms
        val levels = ArrayList<Float>(512)
        var framesWritten = 0L
        var complete = false
        var started = false
        var heardFrames = 0L
        var lastBytesAt = SystemClock.elapsedRealtime()
        var stalled = false
        try {
            coroutineScope {
                val ticker = launch {
                    while (isActive) {
                        // No audio for a while and nothing left to play: the voice service has stalled. Give up on
                        // the line (closing the stream ends the read) rather than sit silent until the server times out.
                        if (!complete && !stalled && SystemClock.elapsedRealtime() - lastBytesAt > STALL_MS &&
                            (!started || (track.playbackHeadPosition.toLong() and 0xFFFFFFFFL) >= framesWritten)) {
                            stalled = true
                            runCatching { stream.close() }
                        }
                        if (started) {
                            val head = track.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                            val idx = (head / levelStep).toInt()
                            val lvl = synchronized(levels) { levels.getOrNull(idx) ?: 0f }
                            onProgress(Progress(head.toDouble() / sampleRate, framesWritten.toDouble() / sampleRate, complete, if (a.stoppedBy == null) lvl else 0f))
                        }
                        delay(33)
                    }
                }
                val buf = ByteArray(4096)
                var carry = -1 // a leftover odd byte
                var acc = 0.0; var accN = 0
                read@ while (a.stoppedBy == null) {
                    val n = runCatching { stream.read(buf) }.getOrElse { -1 }
                    if (n < 0) break
                    lastBytesAt = SystemClock.elapsedRealtime()
                    var bytes = buf.copyOf(n)
                    if (carry >= 0) { bytes = byteArrayOf(carry.toByte()) + bytes; carry = -1 }
                    if (bytes.size % 2 == 1) { carry = bytes.last().toInt() and 0xFF; bytes = bytes.copyOf(bytes.size - 1) }
                    if (bytes.isEmpty()) continue
                    for (i in bytes.indices step 2) {
                        val s = ((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xFF)).toShort() / 32768.0
                        acc += s * s; accN++
                        if (accN == levelStep) { synchronized(levels) { levels += minOf(1f, (sqrt(acc / accN) * 4).toFloat()) }; acc = 0.0; accN = 0 }
                    }
                    var off = 0
                    while (off < bytes.size) {
                        if (a.stoppedBy != null) break@read
                        val w = track.write(bytes, off, bytes.size - off, AudioTrack.WRITE_NON_BLOCKING)
                        if (w < 0) break@read
                        off += w
                        if (!started && off > 0) { track.play(); started = true; onStart() }
                        if (w == 0) delay(10)
                    }
                    framesWritten += bytes.size / 2
                }
                complete = true
                // Let what's buffered play out.
                val until = SystemClock.elapsedRealtime() + 2_000 + framesWritten * 1000 / sampleRate
                while (a.stoppedBy == null && started && (track.playbackHeadPosition.toLong() and 0xFFFFFFFFL) < framesWritten && SystemClock.elapsedRealtime() < until) delay(20)
                ticker.cancel()
            }
        } finally {
            active = null
            heardFrames = if (started) runCatching { track.playbackHeadPosition.toLong() and 0xFFFFFFFFL }.getOrDefault(0L) else 0L
            runCatching { track.stop() }
            track.release()
            runCatching { stream.close() }
        }
        val total = framesWritten.toDouble() / sampleRate
        Outcome(a.stoppedBy, minOf(total, heardFrames.toDouble() / sampleRate), total, stalled && a.stoppedBy == null)
    }

    companion object {
        /** How long a line may go without new audio, once what arrived has played, before it is given up. */
        const val STALL_MS = 3_000L
    }
}
