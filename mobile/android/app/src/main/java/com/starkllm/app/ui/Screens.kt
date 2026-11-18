package com.starkllm.app.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.Screen
import com.starkllm.app.UiState
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.ChatSummary
import com.starkllm.app.data.Problem

private val Night = Color(0xFF07060B)
private val CardShape = RoundedCornerShape(14.dp)

@Composable
fun StarkApp(vm: AppViewModel, onExit: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    BackHandler { if (!vm.back()) onExit() }
    when (val screen = state.screen) {
        Screen.Pair -> PairScreen(state, vm)
        Screen.Workspaces -> WorkspacesScreen(state, vm)
        is Screen.Chats -> ChatsScreen(state, vm, screen)
        is Screen.Chat -> ChatScreen(state, vm, screen)
        Screen.PairedPc -> PairedPcScreen(state, vm)
    }
}

// ---- small parts

/** The StarkLLM mark on its dark tile, as in the launcher icon */
@Composable
private fun Mark(size: Dp) {
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(Night),
        contentAlignment = Alignment.Center,
    ) {
        Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(size * 1.4f))
    }
}

@Composable
private fun problemText(problem: Problem?): String = stringResource(
    when (problem) {
        Problem.UNREACHABLE -> R.string.error_unreachable
        Problem.WRONG_PC -> R.string.error_wrong_pc
        Problem.CODE_CLOSED -> R.string.error_code_closed
        Problem.WRONG_CODE -> R.string.error_wrong_code
        Problem.TOO_MANY_DEVICES -> R.string.error_too_many
        Problem.UNPAIRED -> R.string.error_unpaired
        Problem.PC_OFFLINE -> R.string.error_pc_offline
        Problem.NOT_SIGNED_IN -> R.string.several_accounts
        Problem.SERVER, null -> R.string.error_server
    }
)

@Composable
private fun NoticeCard(state: UiState, vm: AppViewModel) {
    val notice = state.notice ?: return
    val text = if (notice.notACode) stringResource(R.string.not_a_starkllm_code) else problemText(notice.problem)
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(text, Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
            IconButton(onClick = vm::dismissNotice) { Icon(Icons.Filled.Close, stringResource(R.string.close), Modifier.size(18.dp)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Bar(title: String, subtitle: String? = null, dot: Boolean = false, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = {
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (dot) Box(Modifier.padding(end = 6.dp).size(7.dp).clip(CircleShape).background(Connected))
                        Text(subtitle, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        },
        navigationIcon = {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
    )
}

/** A row of a list: icon on a tinted tile, text, and an end slot */
@Composable
private fun ListCard(icon: ImageVector, title: String, onClick: () -> Unit, end: @Composable () -> Unit) {
    Surface(
        onClick = onClick,
        shape = CardShape,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) { Icon(icon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer) }
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
            )
            end()
        }
    }
}

// ---- pairing

@Composable
private fun PairScreen(state: UiState, vm: AppViewModel) {
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
        else -> Scaffold(
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
                Spacer(Modifier.height(28.dp))
                Mark(64.dp)
                Spacer(Modifier.height(20.dp))
                Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineSmall)
                Text(stringResource(R.string.pair_subtitle), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                NoticeCard(state, vm)
                Spacer(Modifier.height(20.dp))
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
        Box(
            Modifier.align(Alignment.Center).size(240.dp).border(BorderStroke(2.dp, Color.White.copy(alpha = 0.9f)), RoundedCornerShape(24.dp)),
        )
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
    Scaffold(
        bottomBar = {
            Column(Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(stringResource(R.string.pairing_progress), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            Mark(64.dp)
            Spacer(Modifier.height(20.dp))
            Text(stringResource(R.string.confirm_pair_title, pcName), style = MaterialTheme.typography.headlineSmall)
            Text(stringResource(R.string.confirm_pair_body, addresses), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

// ---- workspaces

@Composable
private fun WorkspacesScreen(state: UiState, vm: AppViewModel) {
    val version = state.hello?.version?.takeIf { it.isNotBlank() }
    Scaffold(topBar = {
        Bar(
            title = state.link?.pcName ?: stringResource(R.string.app_name),
            subtitle = if (state.hello != null) stringResource(R.string.connected) + (version?.let { " · StarkLLM $it" } ?: "") else null,
            dot = state.hello != null,
        ) {
            IconButton(onClick = vm::refreshWorkspaces) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
            IconButton(onClick = vm::openPairedPc) { Icon(Icons.Filled.Info, stringResource(R.string.paired_pc)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else Spacer(Modifier.height(4.dp))
            NoticeCard(state, vm)
            SectionLabel(stringResource(R.string.workspaces))
            val list = state.workspaces
            if (list != null && list.isEmpty()) EmptyHint(stringResource(R.string.no_workspaces))
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                items(list.orEmpty(), key = { it.id }) { ws ->
                    ListCard(StarkIcons.Folder, ws.name, onClick = { vm.openWorkspace(ws) }) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}

// ---- chats of a workspace

@Composable
private fun ChatsScreen(state: UiState, vm: AppViewModel, screen: Screen.Chats) {
    var toDelete by remember { mutableStateOf<ChatSummary?>(null) }
    Scaffold(
        topBar = { Bar(screen.workspace.name, subtitle = state.link?.pcName, onBack = { vm.back() }) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { vm.newChat(screen.workspace) },
                icon = { Icon(Icons.Filled.Add, null) },
                text = { Text(stringResource(R.string.new_chat), style = MaterialTheme.typography.labelLarge) },
                shape = RoundedCornerShape(16.dp),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else Spacer(Modifier.height(4.dp))
            NoticeCard(state, vm)
            SectionLabel(stringResource(R.string.chats))
            val list = state.chats
            if (list != null && list.isEmpty()) EmptyHint(stringResource(R.string.no_chats))
            LazyColumn(contentPadding = PaddingValues(bottom = 96.dp)) {
                items(list.orEmpty(), key = { it.id }) { chat ->
                    ListCard(StarkIcons.Chat, chat.title.ifBlank { stringResource(R.string.new_chat) }, onClick = { vm.openChat(screen.workspace, chat) }) {
                        IconButton(onClick = { toDelete = chat }, modifier = Modifier.size(36.dp)) {
                            Icon(Icons.Filled.Delete, stringResource(R.string.delete_chat), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
    toDelete?.let { chat ->
        AlertDialog(
            onDismissRequest = { toDelete = null },
            title = { Text(stringResource(R.string.delete_chat), style = MaterialTheme.typography.titleLarge) },
            text = { Text(stringResource(R.string.delete_chat_confirm, chat.title), style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = { vm.deleteChat(screen.workspace, chat); toDelete = null }) {
                    Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { toDelete = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

// ---- one chat

@Composable
private fun ChatScreen(state: UiState, vm: AppViewModel, screen: Screen.Chat) {
    var input by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(state.lines.size, state.lines.lastOrNull()?.text?.length) {
        if (state.lines.isNotEmpty()) listState.scrollToItem(state.lines.size - 1, Int.MAX_VALUE / 2)
    }
    Scaffold(topBar = {
        Bar(screen.title.ifBlank { stringResource(R.string.new_chat) }, subtitle = screen.workspace.name, onBack = { vm.back() })
    }) { pad ->
        // the bar insets are in pad already: without consumeWindowInsets the keyboard height counted twice
        Column(Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize().imePadding()) {
            NoticeCard(state, vm)
            if (state.busy && state.lines.isEmpty()) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.lines.isEmpty() && !state.busy) {
                EmptyChat(Modifier.weight(1f)) { vm.ask(it) }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    itemsIndexed(state.lines) { _, line -> if (line.role == "user") Question(line) else Answer(line) }
                }
            }
            InputBar(
                value = input,
                onChange = { input = it },
                answering = state.answering,
                onSend = { vm.ask(input); input = "" },
                onStop = vm::stop,
            )
        }
    }
}

@Composable
private fun EmptyChat(modifier: Modifier, onAsk: (String) -> Unit) {
    val examples = listOf(stringResource(R.string.suggestion_1), stringResource(R.string.suggestion_2), stringResource(R.string.suggestion_3))
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Mark(48.dp)
        Text(stringResource(R.string.empty_chat_hint), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp, bottom = 18.dp))
        examples.forEach { example ->
            Surface(
                onClick = { onAsk(example) },
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) { Text(example, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) }
        }
    }
}

@Composable
private fun Question(line: ChatLine) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(Modifier.fillMaxWidth(0.85f), contentAlignment = Alignment.CenterEnd) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp),
            ) {
                SelectionContainer {
                    Text(line.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Answer(line: ChatLine) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth()) {
        Box(Modifier.padding(top = 2.dp)) { Mark(24.dp) }
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            if (line.text.isEmpty() && line.streaming) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.thinking), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                SelectionContainer { MarkdownText(line.text) }
            }
            if (line.failed) {
                Text(stringResource(R.string.answer_failed), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 6.dp))
            }
            if (line.sources.documents.isNotEmpty()) {
                FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    line.sources.documents.forEach { name ->
                        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                            Row(Modifier.padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(StarkIcons.Document, null, Modifier.size(13.dp), tint = MaterialTheme.colorScheme.primary)
                                Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 5.dp).widthIn(max = 220.dp))
                            }
                        }
                    }
                }
            }
            if (line.sources.unverifiedQuotes.isNotEmpty()) {
                Column(
                    Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(AmberBackground).padding(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.Top) {
                        Icon(Icons.Filled.Warning, null, tint = Amber, modifier = Modifier.padding(top = 1.dp).size(14.dp))
                        Text(stringResource(R.string.unverified_quotes), Modifier.padding(start = 6.dp), color = Amber, style = MaterialTheme.typography.bodySmall)
                    }
                    line.sources.unverifiedQuotes.forEach { q ->
                        Text("“$q”", color = Amber, fontStyle = FontStyle.Italic, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
            if (!line.streaming && line.text.isNotEmpty()) {
                val copied = stringResource(R.string.copied)
                TextButton(
                    onClick = {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("StarkLLM", line.text))
                        Toast.makeText(context, copied, Toast.LENGTH_SHORT).show()
                    },
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                    modifier = Modifier.padding(top = 2.dp).height(32.dp),
                ) {
                    Icon(StarkIcons.Copy, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(R.string.copy), Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun InputBar(value: String, onChange: (String) -> Unit, answering: Boolean, onSend: () -> Unit, onStop: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(end = 6.dp, bottom = 6.dp)) {
            TextField(
                value = value,
                onValueChange = onChange,
                placeholder = { Text(stringResource(R.string.message_hint), style = MaterialTheme.typography.bodyLarge) },
                textStyle = MaterialTheme.typography.bodyLarge,
                maxLines = 6,
                modifier = Modifier.weight(1f),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
            )
            if (answering) {
                FilledIconButton(onClick = onStop, modifier = Modifier.size(40.dp)) { Icon(StarkIcons.Stop, stringResource(R.string.stop), Modifier.size(16.dp)) }
            } else {
                FilledIconButton(onClick = onSend, enabled = value.isNotBlank(), modifier = Modifier.size(40.dp)) {
                    Icon(StarkIcons.ArrowUp, stringResource(R.string.send), Modifier.size(20.dp))
                }
            }
        }
    }
}

// ---- the paired PC

@Composable
private fun PairedPcScreen(state: UiState, vm: AppViewModel) {
    var confirm by remember { mutableStateOf(false) }
    val link = state.link
    Scaffold(topBar = { Bar(stringResource(R.string.paired_pc), onBack = { vm.back() }) }) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (link != null) {
                Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Mark(44.dp)
                        Column(Modifier.padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(link.pcName, style = MaterialTheme.typography.titleMedium)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (state.hello != null) Box(Modifier.padding(end = 6.dp).size(7.dp).clip(CircleShape).background(Connected))
                                Text(
                                    state.hello?.version?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.pc_version, it) } ?: stringResource(R.string.paired_with, link.pcName),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(stringResource(R.string.pc_addresses, link.addresses.joinToString(", "), link.port), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(horizontal = 4.dp)) {
                Icon(Icons.Filled.Lock, null, Modifier.padding(top = 2.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(R.string.privacy_note), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            }
            OutlinedButton(
                onClick = { confirm = true },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text(stringResource(R.string.unpair), style = MaterialTheme.typography.labelLarge) }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.unpair), style = MaterialTheme.typography.titleLarge) },
            text = { Text(stringResource(R.string.unpair_confirm), style = MaterialTheme.typography.bodyMedium) },
            confirmButton = { TextButton(onClick = { confirm = false; vm.unpair() }) { Text(stringResource(R.string.unpair), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
