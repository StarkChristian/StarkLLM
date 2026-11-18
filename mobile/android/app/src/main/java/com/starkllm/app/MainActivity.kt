package com.starkllm.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.starkllm.app.ui.StarkApp
import com.starkllm.app.ui.StarkTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) pairingLink(intent)
        setContent {
            StarkTheme {
                StarkApp(vm, onExit = { finish() })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairingLink(intent)
    }

    // Debug builds only (src/debug/AndroidManifest.xml): a starkllm://pair link opened with adb. The app still asks first.
    private fun pairingLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (BuildConfig.DEBUG && data.scheme == "starkllm" && vm.state.value.link == null) vm.scanned(data.toString())
    }
}
