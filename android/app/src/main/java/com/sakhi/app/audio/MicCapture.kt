package com.sakhi.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.os.SystemClock
import kotlin.math.sqrt

/**
 * The microphone: 16 kHz mono PCM16 in 20 ms frames, through Android's voice-communication path, so the
 * phone's echo canceller removes Sakhi's own voice (an interruption is the learner, not her echo).
 * Each frame goes to the [SpeechMeter] and then to [sink] on the mic thread.
 */
class MicCapture(private val meter: SpeechMeter) {
    fun interface Sink { fun onFrame(pcm: ShortArray, rms: Float, ms: Float, nowMs: Long) }

    @Volatile var sink: Sink? = null
    /** The learner's level for the orb (0..1), while [metering]. */
    @Volatile var onLevel: (Float) -> Unit = {}
    @Volatile var metering = false

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    private val effects = mutableListOf<android.media.audiofx.AudioEffect>()

    val isRunning get() = running

    /** Caller must hold RECORD_AUDIO. Returns false if the mic can't be opened. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, FRAME * 2 * 8))
        }.getOrNull() ?: return false
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return false }
        val id = rec.audioSessionId
        if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(id)?.also { it.enabled = true; effects += it }
        if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(id)?.also { it.enabled = true; effects += it }
        if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(id)?.also { it.enabled = true; effects += it }
        record = rec
        running = true
        rec.startRecording()
        thread = Thread({ loop(rec) }, "sakhi-mic").apply { start() }
        return true
    }

    private fun loop(rec: AudioRecord) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val ms = FRAME * 1000f / RATE
        while (running) {
            val buf = ShortArray(FRAME)
            var got = 0
            while (got < FRAME && running) {
                val n = rec.read(buf, got, FRAME - got)
                if (n <= 0) break
                got += n
            }
            if (got < FRAME) continue
            var sum = 0.0
            for (s in buf) { val v = s / 32768.0; sum += v * v }
            val rms = sqrt(sum / FRAME).toFloat()
            val now = SystemClock.elapsedRealtime()
            val level = meter.frame(rms, ms, now)
            if (metering) onLevel(level)
            sink?.onFrame(buf, rms, ms, now)
        }
    }

    fun stop() {
        running = false
        thread?.join(500); thread = null
        effects.forEach { runCatching { it.release() } }; effects.clear()
        record?.let { runCatching { it.stop() }; it.release() }
        record = null
    }

    companion object {
        const val RATE = 16_000
        const val FRAME = 320 // 20 ms
    }
}
