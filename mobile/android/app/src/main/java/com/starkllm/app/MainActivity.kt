package com.starkllm.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat
import androidx.fragment.app.FragmentActivity
import com.starkllm.app.data.SharedFiles
import com.starkllm.app.ui.LockScreen
import com.starkllm.app.ui.Photos
import com.starkllm.app.ui.StarkApp
import com.starkllm.app.ui.StarkTheme

/** A file shared to StarkLLM from another app, waiting for the user to choose the workspace */
data class Shared(val uri: Uri, val mime: String?)

class MainActivity : FragmentActivity() {
    private val vm: AppViewModel by viewModels()
    private var locked by mutableStateOf(false)
    private var shared by mutableStateOf<Shared?>(null)
    private var focusAsk by mutableStateOf(0)
    private var stoppedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        locked = vm.state.value.appLock
        if (savedInstanceState == null) {
            // a fresh start: photos left from an earlier run (after a restore, one may still be on its way)
            Photos.clear(this)
            handle(intent)
        }
        setContent {
            val ui by vm.state.collectAsStateWithLifecycle()
            StarkTheme(themeId = ui.theme) {
                if (locked) {
                    LockScreen(this) { locked = false }
                } else {
                    StarkApp(
                        vm,
                        activity = this,
                        shared = shared,
                        onSharedDone = { shared = null },
                        focusAsk = focusAsk,
                        // back on the start screen: into the background, as Android does for apps; an answer that is
                        // still coming in goes on (closing the app would cut it off)
                        onExit = { moveTaskToBack(true) },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
    }

    // App lock: after half a minute in the background the app asks for the fingerprint again
    override fun onStart() {
        super.onStart()
        if (vm.state.value.appLock && stoppedAt > 0 && SystemClock.elapsedRealtime() - stoppedAt > 30_000) locked = true
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        when {
            intent.action == Intent.ACTION_SEND -> {
                val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                when {
                    uri != null && SharedFiles.acceptable(uri.scheme, uri.authority, Photos.authority(this)) -> shared = Shared(uri, intent.type)
                    uri != null -> vm.refuseShared()             // a file:// path, or the app's own files
                    // shared text (a passage of a web page, a message): into the question field, to ask about it
                    text != null -> vm.sharedText(text)
                }
            }
            intent.getStringExtra(EXTRA_OPEN) == OPEN_DEADLINES -> if (vm.state.value.link != null) vm.go(Screen.Deadlines)
            intent.getStringExtra(EXTRA_OPEN) == OPEN_ASK -> if (vm.state.value.link != null) {
                vm.go(Screen.Home)
                focusAsk++
            }
            // Debug builds only (src/debug/AndroidManifest.xml): a starkllm://pair link opened with adb. The app asks first.
            BuildConfig.DEBUG && intent.data?.scheme == "starkllm" -> {
                if (vm.state.value.link != null) vm.addPc()
                vm.scanned(intent.data.toString())
            }
        }
    }

    companion object {
        const val EXTRA_OPEN = "open"
        const val OPEN_DEADLINES = "deadlines"
        const val OPEN_ASK = "ask"
    }
}
