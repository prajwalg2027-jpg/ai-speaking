package com.sakhi.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/**
 * A conversation is a voice call as far as Android is concerned: communication mode turns on the phone's
 * echo canceller for Sakhi's voice. Calls normally use the earpiece, so we route to the loudspeaker unless
 * headphones or a Bluetooth headset are connected.
 */
class AudioRouting(context: Context) {
    private val am = context.getSystemService(AudioManager::class.java)
    private var focus: AudioFocusRequest? = null

    /** [onInterrupted]: another app (a phone call) took the audio. */
    fun enter(onInterrupted: () -> Unit) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { if (it == AudioManager.AUDIOFOCUS_LOSS || it == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) onInterrupted() }
            .build()
        am.requestAudioFocus(req); focus = req
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = am.availableCommunicationDevices
            val personal = devices.firstOrNull { it.type in PERSONAL }
            (personal ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER })?.let { am.setCommunicationDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none { it.type in PERSONAL }
        }
    }

    fun exit() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        else @Suppress("DEPRECATION") { am.isSpeakerphoneOn = false }
        am.mode = AudioManager.MODE_NORMAL
        focus?.let { am.abandonAudioFocusRequest(it) }; focus = null
    }

    private companion object {
        // TYPE_BLE_HEADSET is a plain number: on older phones no device has it, so it simply never matches.
        @android.annotation.SuppressLint("InlinedApi")
        val PERSONAL = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
        )
    }
}
