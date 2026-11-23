package com.starkllm.app.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import android.util.Size
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
                    // 1280x720 frames: the default 640x480 made the dense pairing code readable only from one distance
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setResolutionSelector(
                            ResolutionSelector.Builder()
                                .setResolutionStrategy(
                                    ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                                )
                                .build(),
                        )
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
    val w = image.width
    val h = image.height
    // the whole frame first, then its middle square (where the user points the phone; the code fills more of it)
    val side = minOf(w, h) * 3 / 4
    val areas = listOf(intArrayOf(0, 0, w, h), intArrayOf((w - side) / 2, (h - side) / 2, side, side))
    for (a in areas) {
        val source = PlanarYUVLuminanceSource(data, plane.rowStride, h, a[0], a[1], a[2], a[3], false)
        try {
            return reader.decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text
        } catch (e: ReaderException) {
            // not found in this part: try the next one
        } finally {
            reader.reset()
        }
    }
    return null
}
