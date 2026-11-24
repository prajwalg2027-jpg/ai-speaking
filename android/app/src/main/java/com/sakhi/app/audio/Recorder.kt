package com.sakhi.app.audio

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * One spoken message for practice: the microphone ([MicCapture]) into memory, up to [MAX_SEC] seconds, then a WAV
 * file for /api/learn/voice/transcribe. [onLevel] gets the learner's level (0..1) for the mic button; [onFull]
 * is called (on the mic thread) when the 30 s limit is reached and recording has stopped by itself.
 */
class Recorder(private val newMic: () -> MicCapture = { MicCapture(SpeechMeter()) }) {
    private var mic: MicCapture? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var samples = 0
    @Volatile var onLevel: (Float) -> Unit = {}
    @Volatile var onFull: () -> Unit = {}

    val isRecording get() = mic != null
    val seconds get() = samples.toDouble() / MicCapture.RATE

    /** Caller must hold RECORD_AUDIO. → false if the microphone can't be opened. */
    fun start(): Boolean {
        if (mic != null) return true
        synchronized(pcm) { pcm.reset(); samples = 0 }
        val m = newMic()
        m.metering = true
        m.onLevel = { onLevel(it) }
        m.sink = MicCapture.Sink { frame, _, _, _ ->
            val full = synchronized(pcm) {
                if (samples >= MAX_SAMPLES) return@synchronized true
                val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                frame.forEach { bytes.putShort(it) }
                pcm.write(bytes.array())
                samples += frame.size
                samples >= MAX_SAMPLES
            }
            if (full) onFull()
        }
        if (!m.start()) return false
        mic = m
        return true
    }

    /** Stops and returns the recording as WAV, or null when it's too short to be speech. */
    fun stop(): ByteArray? {
        val m = mic ?: return null
        mic = null
        m.sink = null
        m.stop()
        val data = synchronized(pcm) { pcm.toByteArray().also { pcm.reset() } }
        return if (data.size / 2 < MIN_SAMPLES) null else wav(data, MicCapture.RATE)
    }

    fun cancel() { mic?.let { it.sink = null; it.stop() }; mic = null; synchronized(pcm) { pcm.reset() } }

    companion object {
        const val MAX_SEC = 30
        private const val MAX_SAMPLES = MAX_SEC * MicCapture.RATE - MicCapture.FRAME
        /** Less than half a second isn't a message (the server refuses under 0.1 s). */
        private const val MIN_SAMPLES = MicCapture.RATE / 2

        /** 16-bit mono PCM (little-endian) → a WAV file. */
        fun wav(pcm: ByteArray, rate: Int): ByteArray {
            val b = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray()); b.putInt(36 + pcm.size); b.put("WAVE".toByteArray())
            b.put("fmt ".toByteArray()); b.putInt(16); b.putShort(1); b.putShort(1); b.putInt(rate); b.putInt(rate * 2); b.putShort(2); b.putShort(16)
            b.put("data".toByteArray()); b.putInt(pcm.size); b.put(pcm)
            return b.array()
        }
    }
}
