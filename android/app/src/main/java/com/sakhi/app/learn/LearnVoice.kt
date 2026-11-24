package com.sakhi.app.learn

import android.content.Context
import com.sakhi.app.audio.AudioRouting
import com.sakhi.app.audio.Recorder
import com.sakhi.app.audio.VoicePlayer
import com.sakhi.app.net.VoiceStream

/** The microphone and Sakhi's voice for practice: one recorded message at a time, one reply played at a time. */
interface LearnVoice {
    /** Caller must hold RECORD_AUDIO. → false if the microphone can't be opened. */
    fun startRecording(onLevel: (Float) -> Unit, onFull: () -> Unit): Boolean
    /** → the recording as 16 kHz WAV, or null when it was too short. */
    fun stopRecording(): ByteArray?
    fun cancelRecording()
    suspend fun play(stream: VoiceStream)
    fun stopPlaying()
}

/** On the phone: the voice-call path (echo cancelling, loudspeaker unless headphones), as in the placement test. */
class PhoneLearnVoice(context: Context) : LearnVoice {
    private val routing = AudioRouting(context.applicationContext)
    private val recorder = Recorder()
    private val player = VoicePlayer()
    private var routed = 0

    private fun enter() { if (routed++ == 0) routing.enter { stopPlaying(); cancelRecording() } }
    private fun exit() { if (routed > 0 && --routed == 0) runCatching { routing.exit() } }

    override fun startRecording(onLevel: (Float) -> Unit, onFull: () -> Unit): Boolean {
        stopPlaying()
        recorder.onLevel = onLevel
        recorder.onFull = onFull
        enter()
        return recorder.start().also { if (!it) exit() }
    }

    override fun stopRecording(): ByteArray? {
        if (!recorder.isRecording) return null
        return recorder.stop().also { exit() }
    }

    override fun cancelRecording() { if (recorder.isRecording) { recorder.cancel(); exit() } }

    override suspend fun play(stream: VoiceStream) {
        enter()
        try { stream.use { player.play(it.body, it.sampleRate) } } finally { exit() }
    }

    override fun stopPlaying() = player.stop()
}
