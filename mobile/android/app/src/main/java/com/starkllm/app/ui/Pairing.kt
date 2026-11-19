package com.starkllm.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.UiState

@Composable
internal fun PairScreen(state: UiState, vm: AppViewModel) {
    val context = LocalContext.current
    var scanning by rememberSaveable { mutableStateOf(false) }
    var denied by rememberSaveable { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        scanning = granted
        denied = !granted
    }
    val startScan: () -> Unit = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            scanning = true
        } else {
            permission.launch(Manifest.permission.CAMERA)
        }
    }
    val scanned = state.scanned
    when {
        scanning && scanned == null -> ScanView(
            onCode = { code ->
                vm.scanned(code)
                if (vm.state.value.scanned != null) {
                    scanning = false
                }
            },
            onCancel = { scanning = false },
            notACode = state.notice?.notACode == true,
        )
        scanned != null -> ConfirmPair(state, vm, scanned.pcName, scanned.addresses.joinToString(", "))
        else -> StarkScaffold(
            topBar = { if (state.link != null) Bar(stringResource(R.string.add_pc), onBack = { vm.back() }) },
            bottomBar = {
                Column(Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp)) {
                    if (denied) {
                        Text(stringResource(R.string.camera_permission_needed), color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 8.dp))
                    }
                    Button(onClick = startScan, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(14.dp)) {
                        Icon(StarkIcons.QrScan, null, Modifier.size(20.dp))
                        Text(stringResource(R.string.scan_button), Modifier.padding(start = 10.dp), style = MaterialTheme.typography.labelLarge)
                    }
                }
            },
        ) { pad ->
            Column(
                Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            ) {
                Spacer(Modifier.height(if (state.link != null) 8.dp else 28.dp))
                Mark(56.dp)
                Spacer(Modifier.height(18.dp))
                Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineSmall)
                Text(stringResource(R.string.pair_subtitle), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                NoticeCard(state, vm)
                Spacer(Modifier.height(18.dp))
                Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Step(1, stringResource(R.string.pair_step1))
                        Step(2, stringResource(R.string.pair_step2))
                        Step(3, stringResource(R.string.pair_step3))
                    }
                }
                Row(Modifier.padding(top = 16.dp, bottom = 24.dp), verticalAlignment = Alignment.Top) {
                    Icon(Icons.Filled.Lock, null, Modifier.padding(top = 2.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(R.string.privacy_note), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(24.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) { Text("$n", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimaryContainer) }
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 12.dp, top = 2.dp))
    }
}

@Composable
private fun ScanView(onCode: (String) -> Unit, onCancel: () -> Unit, notACode: Boolean) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        QrScanner(onCode = onCode, modifier = Modifier.fillMaxSize())
        Box(Modifier.align(Alignment.Center).size(240.dp).border(BorderStroke(2.dp, Color.White.copy(alpha = 0.9f)), RoundedCornerShape(24.dp)))
        IconButton(
            onClick = onCancel,
            modifier = Modifier.statusBarsPadding().padding(8.dp),
            colors = IconButtonDefaults.iconButtonColors(containerColor = Color.Black.copy(alpha = 0.45f), contentColor = Color.White),
        ) { Icon(Icons.Filled.Close, stringResource(R.string.cancel)) }
        Surface(
            color = Color.Black.copy(alpha = 0.6f),
            contentColor = Color.White,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(24.dp),
        ) {
            Text(
                stringResource(if (notACode) R.string.not_a_starkllm_code else R.string.scan_hint),
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun ConfirmPair(state: UiState, vm: AppViewModel, pcName: String, addresses: String) {
    StarkScaffold(
        bottomBar = {
            Column(Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(stringResource(R.string.pairing_progress), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Button(onClick = vm::confirmPairing, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(14.dp)) {
                        Text(stringResource(R.string.pair_button), style = MaterialTheme.typography.labelLarge)
                    }
                    TextButton(onClick = vm::cancelPairing, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.cancel)) }
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize().padding(horizontal = 20.dp)) {
            Spacer(Modifier.height(28.dp))
            Mark(56.dp)
            Spacer(Modifier.height(18.dp))
            Text(stringResource(R.string.confirm_pair_title, pcName), style = MaterialTheme.typography.headlineSmall)
            Text(stringResource(R.string.confirm_pair_body, addresses), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

/** App lock (Settings): the app's content stays hidden until the phone confirmed the person */
@Composable
fun LockScreen(activity: FragmentActivity, onUnlocked: () -> Unit) {
    val title = stringResource(R.string.lock_title)
    val unlock = { confirmPerson(activity, title, null, onUnlocked) }
    LaunchedEffect(Unit) { unlock() }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Mark(64.dp)
        Text(title, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.padding(top = 20.dp, bottom = 20.dp))
        Button(onClick = unlock, shape = RoundedCornerShape(14.dp)) {
            Icon(Icons.Filled.Lock, null, Modifier.size(18.dp))
            Text(stringResource(R.string.unlock), Modifier.padding(start = 8.dp))
        }
    }
}
