package com.starkllm.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.Screen
import com.starkllm.app.UiState
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.Problem

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
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Warning, contentDescription = null)
            Text(text, Modifier.weight(1f).padding(horizontal = 12.dp), style = MaterialTheme.typography.bodyMedium)
            IconButton(onClick = vm::dismissNotice) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Bar(title: String, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = { Text(title, maxLines = 1) },
        navigationIcon = {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        },
        actions = { actions() },
    )
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
    Scaffold(topBar = { Bar(stringResource(R.string.app_name)) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            NoticeCard(state, vm)
            val scanned = state.scanned
            when {
                scanned != null -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(stringResource(R.string.confirm_pair_title, scanned.pcName), style = MaterialTheme.typography.headlineSmall)
                    Text(stringResource(R.string.confirm_pair_body, scanned.addresses.joinToString(", ")), style = MaterialTheme.typography.bodyLarge)
                    if (state.busy) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text(stringResource(R.string.pairing_progress))
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button(onClick = vm::confirmPairing) { Text(stringResource(R.string.pair_button)) }
                            OutlinedButton(onClick = vm::cancelPairing) { Text(stringResource(R.string.cancel)) }
                        }
                    }
                }
                scanning -> Column(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxWidth().aspectRatio(1f).padding(16.dp).clip(RoundedCornerShape(16.dp))) {
                        QrScanner(
                            onCode = { code ->
                                vm.scanned(code)
                                if (vm.state.value.scanned != null) {
                                    scanning = false
                                }
                            },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    Text(stringResource(R.string.scan_hint), Modifier.padding(horizontal = 24.dp), textAlign = TextAlign.Center)
                    TextButton(onClick = { scanning = false }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(stringResource(R.string.cancel)) }
                }
                else -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineSmall)
                    Text(stringResource(R.string.pair_intro), style = MaterialTheme.typography.bodyLarge)
                    Text(stringResource(R.string.privacy_note), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (denied) Text(stringResource(R.string.camera_permission_needed), color = MaterialTheme.colorScheme.error)
                    Button(onClick = startScan) { Text(stringResource(R.string.scan_button)) }
                }
            }
        }
    }
}

// ---- workspaces

@Composable
private fun WorkspacesScreen(state: UiState, vm: AppViewModel) {
    Scaffold(topBar = {
        Bar(state.link?.pcName ?: stringResource(R.string.app_name)) {
            IconButton(onClick = vm::refreshWorkspaces) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
            IconButton(onClick = vm::openPairedPc) { Icon(Icons.Filled.Info, stringResource(R.string.paired_pc)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            NoticeCard(state, vm)
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(stringResource(R.string.workspaces), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
            val list = state.workspaces
            if (list != null && list.isEmpty()) Text(stringResource(R.string.no_workspaces), Modifier.padding(16.dp))
            LazyColumn {
                items(list.orEmpty(), key = { it.id }) { ws ->
                    ListItem(headlineContent = { Text(ws.name) }, modifier = Modifier.clickable { vm.openWorkspace(ws) })
                    HorizontalDivider()
                }
            }
        }
    }
}

// ---- chats of a workspace

@Composable
private fun ChatsScreen(state: UiState, vm: AppViewModel, screen: Screen.Chats) {
    var toDelete by remember { mutableStateOf<com.starkllm.app.data.ChatSummary?>(null) }
    Scaffold(
        topBar = { Bar(screen.workspace.name, onBack = { vm.back() }) },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = { vm.newChat(screen.workspace) }, icon = { Icon(Icons.Filled.Add, null) }, text = { Text(stringResource(R.string.new_chat)) })
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            NoticeCard(state, vm)
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            val list = state.chats
            if (list != null && list.isEmpty()) Text(stringResource(R.string.no_chats), Modifier.padding(16.dp))
            LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
                items(list.orEmpty(), key = { it.id }) { chat ->
                    ListItem(
                        headlineContent = { Text(chat.title.ifBlank { stringResource(R.string.new_chat) }, maxLines = 2) },
                        trailingContent = {
                            IconButton(onClick = { toDelete = chat }) { Icon(Icons.Filled.Delete, stringResource(R.string.delete_chat)) }
                        },
                        modifier = Modifier.clickable { vm.openChat(screen.workspace, chat) },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
    toDelete?.let { chat ->
        AlertDialog(
            onDismissRequest = { toDelete = null },
            title = { Text(stringResource(R.string.delete_chat)) },
            text = { Text(stringResource(R.string.delete_chat_confirm, chat.title)) },
            confirmButton = { TextButton(onClick = { vm.deleteChat(screen.workspace, chat); toDelete = null }) { Text(stringResource(R.string.delete)) } },
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
    Scaffold(topBar = { Bar(screen.title.ifBlank { stringResource(R.string.new_chat) }, onBack = { vm.back() }) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
            NoticeCard(state, vm)
            if (state.busy && state.lines.isEmpty()) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (state.lines.isEmpty() && !state.busy) {
                    item { Text(stringResource(R.string.empty_chat_hint), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp)) }
                }
                itemsIndexed(state.lines) { _, line -> Bubble(line) }
            }
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text(stringResource(R.string.message_hint)) },
                    modifier = Modifier.weight(1f),
                    maxLines = 5,
                )
                Spacer(Modifier.size(8.dp))
                if (state.answering) {
                    FilledIconButton(onClick = vm::stop) { Icon(Icons.Filled.Close, stringResource(R.string.stop)) }
                } else {
                    FilledIconButton(onClick = { vm.ask(input); input = "" }, enabled = input.isNotBlank()) {
                        Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send))
                    }
                }
            }
        }
    }
}

@Composable
private fun Bubble(line: ChatLine) {
    val mine = line.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Surface(
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = if (mine) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.widthIn(max = 560.dp),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (line.text.isEmpty() && line.streaming) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        Text(stringResource(R.string.thinking), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    SelectionContainer { Text(line.text, style = MaterialTheme.typography.bodyLarge) }
                }
                if (line.failed) Text(stringResource(R.string.answer_failed), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (!mine && line.sources.documents.isNotEmpty()) {
            Text(
                stringResource(R.string.sources, line.sources.documents.joinToString(", ")),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 6.dp, top = 4.dp),
            )
        }
        if (!mine && line.sources.unverifiedQuotes.isNotEmpty()) {
            Column(
                Modifier.padding(top = 6.dp).widthIn(max = 560.dp).clip(RoundedCornerShape(10.dp)).background(AmberBackground).padding(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Warning, null, tint = Amber, modifier = Modifier.size(16.dp))
                    Text(stringResource(R.string.unverified_quotes), Modifier.padding(start = 6.dp), color = Amber, style = MaterialTheme.typography.bodySmall)
                }
                line.sources.unverifiedQuotes.forEach { q ->
                    Text("“$q”", color = Amber, fontStyle = FontStyle.Italic, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
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
        Column(Modifier.padding(pad).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (link != null) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.paired_with, link.pcName), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(stringResource(R.string.pc_addresses, link.addresses.joinToString(", "), link.port), style = MaterialTheme.typography.bodyMedium)
                        state.hello?.version?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.pc_version, it), style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
            Text(stringResource(R.string.privacy_note), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { confirm = true }) { Text(stringResource(R.string.unpair)) }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.unpair)) },
            text = { Text(stringResource(R.string.unpair_confirm)) },
            confirmButton = { TextButton(onClick = { confirm = false; vm.unpair() }) { Text(stringResource(R.string.unpair)) } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
