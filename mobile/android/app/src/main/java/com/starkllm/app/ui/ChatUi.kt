package com.starkllm.app.ui

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.clickable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.FastOutSlowInEasing
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet

import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.Screen
import com.starkllm.app.UiState
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.ChatSummary
import com.starkllm.app.data.Deadline
import com.starkllm.app.data.Workspace
import com.starkllm.app.data.openDeadlines
import com.starkllm.app.widget.DeadlinesWidget
import java.util.Calendar

// ---- home

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeScreen(state: UiState, vm: AppViewModel, activity: FragmentActivity, openDrawer: () -> Unit, focusAsk: Int) {
    var input by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(focusAsk) { if (focusAsk > 0) runCatching { focus.requestFocus() } }
    // text shared from another app: in the field, so the user can ask about it
    LaunchedEffect(state.draft) {
        state.draft?.let {
            input = it
            vm.draftTaken()
            runCatching { focus.requestFocus() }
        }
    }
    val greeting = stringResource(
        when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
            in 5..10 -> R.string.greeting_morning
            in 11..17 -> R.string.greeting_day
            else -> R.string.greeting_evening
        }
    )
    StarkScaffold(topBar = {
        Bar(state.link?.pcName ?: stringResource(R.string.app_name),
            subtitle = state.hello?.let { stringResource(if (it.viaRelay) R.string.connected_away else R.string.connected) },
            dot = state.hello != null, onMenu = openDrawer) {
            IconButton(onClick = vm::refreshAll) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize().imePadding()) {
            NoticeCard(state, vm)
            // pull down to read everything from the PC again
            PullToRefreshBox(isRefreshing = state.busy, onRefresh = vm::refreshAll, modifier = Modifier.weight(1f)) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                Spacer(Modifier.height(12.dp))
                Text(greeting, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 4.dp))
                Text(stringResource(R.string.home_subtitle), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp))
                Spacer(Modifier.height(12.dp))
                DeadlinesCard(state, vm)
                Spacer(Modifier.height(10.dp))
                RecentDocumentsCard(state)
                Spacer(Modifier.height(14.dp))
                listOf(R.string.suggestion_1, R.string.suggestion_2, R.string.suggestion_3).forEach { res ->
                    val text = stringResource(res)
                    Surface(
                        onClick = { vm.askNew(text) },
                        enabled = state.workspace != null,
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceContainer,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    ) { Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) }
                }
                Spacer(Modifier.height(12.dp))
            }
            }
            WorkspaceChip(state, vm)
            InputBar(
                state = state, vm = vm, activity = activity,
                value = input, onChange = { input = it },
                target = state.workspace,
                // the text stays in the field when the question was not sent (another answer is still coming in)
                onSend = { if (vm.askNew(input)) input = "" },
                focus = focus,
            )
        }
    }
}

@Composable
private fun DeadlinesCard(state: UiState, vm: AppViewModel) {
    val context = LocalContext.current
    val open = openDeadlines(state.deadlines.orEmpty()).take(3)
    Surface(onClick = { vm.go(Screen.Deadlines) }, shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.DateRange, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                Text(stringResource(R.string.nav_deadlines), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).padding(start = 8.dp))
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (open.isEmpty()) {
                Text(stringResource(if (state.deadlines == null) R.string.loading else R.string.no_deadlines), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            }
            open.forEach { d ->
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(stateColor(d)))
                    Text(DeadlinesWidget.line(context, d).removePrefix("● "), style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
internal fun stateColor(d: Deadline): Color = when (d.state) {
    "overdue" -> MaterialTheme.colorScheme.error
    "today" -> Amber
    "soon" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun RecentDocumentsCard(state: UiState) {
    val recent = state.home?.recent.orEmpty().take(3)
    if (recent.isEmpty() && state.inboxCount == null) return
    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(StarkIcons.Document, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                Text(stringResource(R.string.recent_documents), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).padding(start = 8.dp))
                val n = state.inboxCount ?: 0
                if (n > 0) {
                    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                        Text(stringResource(R.string.inbox_new, n), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
                    }
                }
            }
            recent.forEach { doc ->
                Text(listOfNotNull(doc.filename, doc.workspace).joinToString(" · "), style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

@Composable
private fun WorkspaceChip(state: UiState, vm: AppViewModel) {
    val workspaces = state.workspaces.orEmpty()
    if (workspaces.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(start = 16.dp, top = 4.dp)) {
        Surface(onClick = { open = true }, shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
            Row(Modifier.padding(start = 10.dp, end = 6.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(StarkIcons.Folder, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
                Text(state.workspace?.name.orEmpty(), style = MaterialTheme.typography.labelMedium, maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp).widthIn(max = 220.dp), overflow = TextOverflow.Ellipsis)
                Icon(StarkIcons.ExpandMore, null, Modifier.size(16.dp))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            workspaces.forEach { ws ->
                DropdownMenuItem(
                    text = { Text(ws.name) },
                    leadingIcon = { if (ws.id == state.workspace?.id) Icon(Icons.Filled.Check, null, Modifier.size(18.dp)) },
                    onClick = { vm.setWorkspace(ws.id); open = false },
                )
            }
        }
    }
}

// ---- workspaces and chats

@Composable
internal fun WorkspacesScreen(state: UiState, vm: AppViewModel, openDrawer: () -> Unit) {
    StarkScaffold(topBar = {
        Bar(stringResource(R.string.workspaces), subtitle = state.link?.pcName, onMenu = openDrawer) {
            IconButton(onClick = vm::refreshAll) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else Spacer(Modifier.height(4.dp))
            NoticeCard(state, vm)
            val list = state.workspaces
            if (list != null && list.isEmpty()) {
                Lucy(Modifier.width(120.dp).align(Alignment.CenterHorizontally).padding(top = 24.dp), description = stringResource(R.string.lucy))
                EmptyHint(stringResource(R.string.no_workspaces))
            }
            LazyColumn(contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp)) {
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
internal fun ChatsScreen(state: UiState, vm: AppViewModel, screen: Screen.Chats) {
    var toDelete by remember { mutableStateOf<ChatSummary?>(null) }
    StarkScaffold(
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
                        if (state.canSend) {
                            IconButton(onClick = { toDelete = chat }) {
                                Icon(Icons.Filled.Delete, stringResource(R.string.delete_chat), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
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
internal fun ChatScreen(state: UiState, vm: AppViewModel, screen: Screen.Chat, activity: FragmentActivity) {
    var input by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(state.lines.size, state.lines.lastOrNull()?.text?.length) {
        if (state.lines.isNotEmpty()) listState.scrollToItem(state.lines.size - 1, Int.MAX_VALUE / 2)
    }
    StarkScaffold(topBar = {
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
                state = state, vm = vm, activity = activity,
                value = input, onChange = { input = it },
                target = screen.workspace,
                onSend = { if (vm.ask(input)) input = "" },
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
        Lucy(Modifier.width(120.dp), description = stringResource(R.string.lucy))
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
            // the question in the theme's gradient, as the send button on the PC
            val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp)
            val theme = LocalStarkTheme.current
            Box(Modifier.clip(shape).background(textGradientOf(theme))) {
                SelectionContainer {
                    Text(line.text, style = MaterialTheme.typography.bodyLarge, color = onGradientOf(theme),
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
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
                    TypingDots()
                    Text(stringResource(R.string.thinking), Modifier.padding(start = 10.dp), style = MaterialTheme.typography.bodyMedium,
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
                                Text(readableSource(name), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 5.dp).widthIn(max = 220.dp))
                            }
                        }
                    }
                }
            }
            if (line.sources.unverifiedQuotes.isNotEmpty()) {
                Column(Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(AmberBackground).padding(10.dp)) {
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
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    Icon(StarkIcons.Copy, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(R.string.copy), Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

// ---- the input: attach, dictate, send

@Composable
internal fun InputBar(
    state: UiState,
    vm: AppViewModel,
    activity: FragmentActivity,
    value: String,
    onChange: (String) -> Unit,
    target: Workspace?,
    onSend: () -> Unit,
    focus: FocusRequester? = null,
) {
    val context = LocalContext.current
    var sheet by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    val dictation = remember { Dictation(context) }
    // leaving the screen while the button is held: the recorder is released, not left holding the microphone
    DisposableEffect(dictation) { onDispose { dictation.cancel() } }
    val haptics = LocalHapticFeedback.current
    var micDenied by remember { mutableStateOf(false) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (!granted) micDenied = true }
    val holdHint = stringResource(R.string.hold_to_talk)
    LaunchedEffect(state.dictated) {
        state.dictated?.let {
            onChange(listOf(value.trim(), it).filter { s -> s.isNotEmpty() }.joinToString(" "))
            vm.dictationTaken()
        }
    }
    Column {
        if (state.uploading || state.transcribing) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                Text(stringResource(if (state.uploading) R.string.uploading else R.string.transcribing), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            }
        }
        Surface(
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(start = 4.dp, end = 6.dp, bottom = 6.dp)) {
                IconButton(onClick = { sheet = true }, modifier = Modifier.padding(bottom = 2.dp)) {
                    Icon(Icons.Filled.Add, stringResource(R.string.attach))
                }
                TextField(
                    value = value,
                    onValueChange = onChange,
                    placeholder = {
                        Text(stringResource(if (recording) R.string.recording else R.string.message_hint), style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (recording) MaterialTheme.colorScheme.error else Color.Unspecified)
                    },
                    textStyle = MaterialTheme.typography.bodyLarge,
                    maxLines = 6,
                    modifier = Modifier.weight(1f).let { m -> if (focus != null) m.focusRequester(focus) else m },
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    ),
                )
                if (value.isBlank() && !state.answering) {
                    // hold to talk: the recording goes to the PC's speech model when the button is let go
                    Box(
                        // 48 dp to touch (Android's minimum touch target); the circle drawn inside is 40 dp
                        Modifier.size(48.dp)
                            .pointerInput(Unit) {
                                detectTapGestures(onPress = {
                                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                                        return@detectTapGestures
                                    }
                                    if (!dictation.start()) return@detectTapGestures
                                    recording = true
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    val audio = try {
                                        tryAwaitRelease()
                                        dictation.stop()
                                    } finally {
                                        // also when the gesture is cut off (the screen changed): no recorder is left running
                                        recording = false
                                        dictation.cancel()
                                    }
                                    if (audio == null) {
                                        Toast.makeText(context, holdHint, Toast.LENGTH_SHORT).show()
                                    } else {
                                        vm.transcribe(audio, "dictation.ogg", "audio/ogg")
                                    }
                                })
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier.size(40.dp).clip(CircleShape)
                                .background(if (recording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.surfaceContainer),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(StarkIcons.Mic, stringResource(R.string.hold_to_talk), Modifier.size(20.dp),
                                tint = if (recording) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onSurface)
                        }
                    }
                } else if (state.answering) {
                    // Material's own size: a 40 dp button with a 48 dp touch target
                    FilledIconButton(onClick = vm::stop) { Icon(StarkIcons.Stop, stringResource(R.string.stop), Modifier.size(16.dp)) }
                } else {
                    val canSend = value.isNotBlank() && target != null
                    Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .clickable(enabled = canSend, role = Role.Button) {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                onSend()
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier.size(40.dp).clip(CircleShape)
                                .background(if (canSend) textGradientOf(LocalStarkTheme.current) else androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.surfaceContainer)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(StarkIcons.ArrowUp, stringResource(R.string.send), Modifier.size(20.dp),
                                tint = if (canSend) onGradientOf(LocalStarkTheme.current) else MaterialTheme.colorScheme.outline)
                        }
                    }
                }
            }
        }
    }
    if (sheet) AttachSheet(state, vm, target, onClose = { sheet = false })
    if (micDenied) PermissionDialog(stringResource(R.string.permission_mic)) { micDenied = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttachSheet(state: UiState, vm: AppViewModel, target: Workspace?, onClose: () -> Unit) {
    val context = LocalContext.current
    val takePhoto = LocalTakePhoto.current
    var models by remember { mutableStateOf(false) }
    val send: (Uri, String?, String) -> Unit = { uri, mime, fallback ->
        if (target != null) vm.upload(target, nameOf(context, uri) ?: fallback, UriBody(context, uri, mime))
        onClose()
    }
    val photoFallback = stringResource(R.string.photo_file_prefix) + ".jpg"
    val documentFallback = stringResource(R.string.document_fallback)
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) send(uri, null, photoFallback) }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) send(uri, null, documentFallback) }

    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text(stringResource(R.string.attach_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 4.dp, bottom = 12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                val enabled = state.canSend && target != null
                SheetTile(StarkIcons.Camera, stringResource(R.string.attach_camera), enabled, Modifier.weight(1f)) {
                    // the sheet closes; the photo is received at the top of the app (rememberPhotoCamera)
                    if (target != null) {
                        onClose()
                        takePhoto(target)
                    }
                }
                SheetTile(StarkIcons.Image, stringResource(R.string.attach_photos), enabled, Modifier.weight(1f)) {
                    pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                SheetTile(StarkIcons.UploadFile, stringResource(R.string.attach_files), enabled, Modifier.weight(1f)) {
                    pickFile.launch(arrayOf("application/pdf", "image/*", "text/*", "application/epub+zip",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"))
                }
            }
            Text(
                if (!state.canSend) problemTextNotAllowed() else stringResource(R.string.attach_hint, target?.name.orEmpty()),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 8.dp),
            )
            SheetRow(StarkIcons.Chip, stringResource(R.string.model), state.model ?: stringResource(R.string.model_default)) { models = true }
            Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(StarkIcons.Book, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(stringResource(R.string.use_kb), style = MaterialTheme.typography.bodyLarge)
                        Text(stringResource(R.string.use_kb_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = state.useKnowledgeBase, onCheckedChange = vm::setKnowledgeBase)
                }
            }
        }
    }
    if (models) {
        AlertDialog(
            onDismissRequest = { models = false },
            title = { Text(stringResource(R.string.model), style = MaterialTheme.typography.titleLarge) },
            text = {
                LazyColumn {
                    item {
                        ModelRow(stringResource(R.string.model_default), state.model == null) { vm.setModel(null); models = false }
                    }
                    items(state.models) { m -> ModelRow(m, state.model == m) { vm.setModel(m); models = false } }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { models = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun problemTextNotAllowed() = problemText(com.starkllm.app.data.Problem.NOT_ALLOWED)

@Composable
private fun ModelRow(name: String, selected: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, color = Color.Transparent, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { if (selected) Icon(Icons.Filled.Check, null, Modifier.size(18.dp)) }
            Text(name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

@Composable
private fun SheetTile(icon: ImageVector, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = modifier) {
        Column(Modifier.padding(vertical = 16.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainer), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(20.dp), tint = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline)
            }
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp),
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun SheetRow(icon: ImageVector, title: String, value: String, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Three dots that rise one after the other while the PC reads the documents */
@Composable
private fun TypingDots() {
    val motion = rememberInfiniteTransition(label = "dots")
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val lift by motion.animateFloat(
                0f, 1f,
                infiniteRepeatable(tween(420, delayMillis = i * 140, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "dot$i",
            )
            Box(
                Modifier.offset(y = (-4 * lift).dp).size(7.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.45f + 0.55f * lift)),
            )
        }
    }
}

// The engine names a source "file (locator)" in English: "letter.pdf (Page 2 (OCR))", "IMG_1.jpg (Image (OCR))",
// "notes.md (Chunk 3)", "talk.m4a (Time 00:01:05)". The locator is shown in the app's language (as on the PC).
private val SOURCE = Regex("""^(.*?\.[A-Za-z0-9]{1,8})\s*\((.*)\)\s*$""")
private val HOW = Regex("""^(.*?)\s*\((OCR|Vision)\)$""")
private val PAGE = Regex("""^Page (\d+)$""")
private val CHUNK = Regex("""^Chunk (\d+)$""")
private val TIME = Regex("""^Time (\d{2}:\d{2}:\d{2})$""")

@Composable
internal fun readableSource(label: String): String {
    val m = SOURCE.matchEntire(label.trim()) ?: return label
    var rest = m.groupValues[2].trim()
    val how = HOW.matchEntire(rest)?.let { h ->
        rest = h.groupValues[1]
        stringResource(if (h.groupValues[2] == "OCR") R.string.src_ocr else R.string.src_vision)
    }
    val where = PAGE.matchEntire(rest)?.let { stringResource(R.string.src_page, it.groupValues[1]) }
        ?: (if (rest == "Image") stringResource(R.string.src_photo) else null)
        ?: CHUNK.matchEntire(rest)?.let { stringResource(R.string.src_part, it.groupValues[1]) }
        ?: TIME.matchEntire(rest)?.let { stringResource(R.string.src_at, it.groupValues[1]) }
        ?: rest
    return "${m.groupValues[1]} · " + (if (how != null) "$where, $how" else where)
}
