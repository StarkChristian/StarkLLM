package com.starkllm.app.ui

import android.content.ContentResolver
import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException

/** A file chosen on the phone, sent as it is read (large PDFs are not loaded into memory). Re-readable for a retry. */
class UriBody(private val context: Context, private val uri: Uri, private val mime: String?) : RequestBody() {
    override fun contentType() = (mime ?: context.contentResolver.getType(uri))?.toMediaTypeOrNull()
    override fun contentLength(): Long = sizeOf(context, uri) ?: -1L
    override fun writeTo(sink: BufferedSink) {
        // only what another app offers through its provider: a file:// path could name the app's own private files
        if (!uri.scheme.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true)) throw IOException("only content:// is sent")
        context.contentResolver.openInputStream(uri)?.use { sink.writeAll(it.source()) }
    }
}

fun nameOf(context: Context, uri: Uri): String? =
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    }

private fun sizeOf(context: Context, uri: Uri): Long? =
    context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
    }

/**
 * Dictation: records the microphone into an Ogg/Opus file in the app's cache while the button is held. The recording is
 * sent to the PC, turned into text there, and deleted here.
 */
class Dictation(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private val file = File(context.cacheDir, "dictation.ogg")
    private var started = 0L

    fun start(): Boolean {
        cancel()                // a recording that was not ended (it would keep the microphone)
        file.delete()
        var r: MediaRecorder? = null
        return try {
            r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
            r.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            r.setAudioSamplingRate(16000)
            r.setAudioEncodingBitRate(24000)
            r.setOutputFile(file.absolutePath)
            r.prepare()
            r.start()
            recorder = r
            started = System.currentTimeMillis()
            true
        } catch (e: Exception) {
            // the microphone is busy or the recorder failed: release it, or the microphone stays taken
            runCatching { r?.release() }
            recorder = null
            file.delete()
            false
        }
    }

    /** the recording, or null when it was too short (a tap, not a hold) or failed. Always releases the microphone. */
    fun stop(): ByteArray? {
        val r = recorder ?: return null
        recorder = null
        val ok = try {
            runCatching { r.stop() }.isSuccess
        } finally {
            runCatching { r.release() }
        }
        val long = System.currentTimeMillis() - started > 600
        val bytes = if (ok && long && file.exists()) runCatching { file.readBytes() }.getOrNull() else null
        file.delete()
        return bytes
    }

    /** ends a recording without using it (the screen was left while the button was held) */
    fun cancel() {
        stop()
    }
}

/**
 * Asks for the fingerprint (or face, or the phone's PIN) before something that matters: unlocking the app, an action on
 * the PC. onOk runs only after the phone confirmed the person.
 */
fun confirmPerson(activity: FragmentActivity, title: String, subtitle: String?, onOk: () -> Unit) {
    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onOk()
    })
    val authenticators = if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .apply { if (subtitle != null) setSubtitle(subtitle) }
        .setAllowedAuthenticators(authenticators)
        .build()
    prompt.authenticate(info)
}
