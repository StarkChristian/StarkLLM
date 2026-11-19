package com.starkllm.app.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The camera preview that reads a QR code (ZXing on the camera's brightness plane). Nothing is stored or sent: the
 * frames are only looked at, and onCode gets the text of the first QR code seen. onError: the camera cannot be used
 * (no camera, or another app has it); the back camera is preferred, a phone with only a front camera uses that one.
 */
@Composable
fun QrScanner(onCode: (String) -> Unit, onError: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latest = rememberUpdatedState(onCode)
    val latestError = rememberUpdatedState(onError)
    val found = remember { AtomicBoolean(false) }
    val analyzer = remember { Executors.newSingleThreadExecutor() }
    val providerFuture = remember { ProcessCameraProvider.getInstance(context) }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
            providerFuture.addListener({
                try {
                    val provider = providerFuture.get()
                    val camera = when {
                        provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                        provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                        else -> throw IllegalStateException("no camera")
                    }
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    val reader = QRCodeReader()
                    analysis.setAnalyzer(analyzer) { image ->
                        val text = try {
                            decode(image, reader)
                        } finally {
                            image.close()
                        }
                        if (text != null && found.compareAndSet(false, true)) {
                            ContextCompat.getMainExecutor(ctx).execute {
                                latest.value(text)
                                found.set(false)          // a wrong code: the screen keeps scanning
                            }
                        }
                    }
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, camera, preview, analysis)
                } catch (e: Exception) {
                    // no camera, a camera in use by another app, or CameraX could not start: say so instead of crashing
                    android.util.Log.w("StarkLLM", "camera for the QR code", e)
                    latestError.value()
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
    )

    DisposableEffect(Unit) {
        onDispose {
            runCatching { providerFuture.get().unbindAll() }
            analyzer.shutdown()
        }
    }
}

private val HINTS = mapOf(DecodeHintType.TRY_HARDER to true)

private fun decode(image: ImageProxy, reader: QRCodeReader): String? {
    val plane = image.planes[0]
    val buffer = plane.buffer
    val data = ByteArray(buffer.remaining()).also { buffer.get(it) }
    val source = PlanarYUVLuminanceSource(data, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
    return try {
        reader.decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text
    } catch (e: ReaderException) {
        null
    } finally {
        reader.reset()
    }
}
