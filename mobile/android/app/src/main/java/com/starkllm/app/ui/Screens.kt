package com.starkllm.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Scaffold
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.Screen
import com.starkllm.app.Shared
import com.starkllm.app.UiState
import com.starkllm.app.data.Problem
import kotlinx.coroutines.launch

internal val CardShape = RoundedCornerShape(14.dp)

@Composable
fun StarkApp(vm: AppViewModel, activity: FragmentActivity, shared: Shared?, onSharedDone: () -> Unit, focusAsk: Int, onExit: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    BackHandler {
        if (drawer.isOpen) scope.launch { drawer.close() } else if (!vm.back()) onExit()
    }
    val openDrawer: () -> Unit = { scope.launch { drawer.open() } }
    val topLevel = state.screen in setOf(Screen.Home, Screen.Workspaces, Screen.Deadlines, Screen.ThisPc, Screen.Settings, Screen.Guide)
    if (!state.introSeen && state.link == null) {
        IntroScreen(onDone = vm::introDone)
        return
    }
    val takePhoto = rememberPhotoCamera(vm)
    val posture = rememberPosture(activity)
    CompositionLocalProvider(LocalTakePhoto provides takePhoto, LocalPosture provides posture) {
        Box(Modifier.fillMaxSize()) {
            // the theme's background (and pattern) behind every screen, as on the PC
            ThemeBackground(LocalStarkTheme.current)
            ModalNavigationDrawer(
                drawerState = drawer,
                gesturesEnabled = topLevel && state.link != null,
                drawerContent = {
                    if (state.link != null) Drawer(state, vm) { scope.launch { drawer.close() } }
                },
            ) {
                AnimatedContent(
                    targetState = state.screen,
                    contentKey = { s ->
                        when (s) {
                            is Screen.Chat -> "chat-${s.nonce}"
                            is Screen.Chats -> "chats-${s.workspace.id}"
                            else -> s.toString()
                        }
                    },
                    transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(140)) },
                    label = "screens",
                ) { screen ->
                    when (screen) {
                        Screen.Pair -> PairScreen(state, vm)
                        Screen.Home -> HomeScreen(state, vm, activity, openDrawer, focusAsk)
                        Screen.Workspaces -> WorkspacesScreen(state, vm, openDrawer)
                        is Screen.Chats -> ChatsScreen(state, vm, screen)
                        is Screen.Chat -> ChatScreen(state, vm, (state.screen as? Screen.Chat)?.takeIf { it.nonce == screen.nonce } ?: screen, activity)
                        Screen.Deadlines -> DeadlinesScreen(state, vm, openDrawer)
                        Screen.ThisPc -> ThisPcScreen(state, vm, activity, openDrawer)
                        Screen.Settings -> SettingsScreen(state, vm, activity, openDrawer)
                        Screen.Guide -> GuideScreen(openDrawer)
                    }
                }
            }
        }
    }
    if (shared != null) SharedDialog(state, vm, shared, onSharedDone)
    state.info?.let { info ->
        LaunchedEffect(info) {
            android.widget.Toast.makeText(activity, activity.getString(info.text, info.arg), android.widget.Toast.LENGTH_LONG).show()
            vm.dismissInfo()
        }
    }
}

// ---- the drawer

@Composable
private fun Drawer(state: UiState, vm: AppViewModel, close: () -> Unit) {
    var pcs by remember { mutableStateOf(false) }
    ModalDrawerSheet(drawerContainerColor = MaterialTheme.colorScheme.background, modifier = Modifier.padding(end = 56.dp)) {
        LazyColumn {
            item {
                Row(Modifier.padding(start = 20.dp, top = 20.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mark(32.dp)
                    Text("StarkLLM", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 12.dp))
                }
                Surface(
                    onClick = { pcs = !pcs },
                    shape = CardShape,
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(StarkIcons.Computer, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f).padding(start = 10.dp)) {
                            Text(state.link?.pcName.orEmpty(), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            StatusLine(state)
                        }
                        Icon(if (pcs) StarkIcons.ExpandLess else StarkIcons.ExpandMore, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (pcs) {
                    state.links.forEach { l ->
                        NavigationDrawerItem(
                            label = { Text(l.pcName, style = MaterialTheme.typography.bodyMedium) },
                            icon = { if (l.id == state.link?.id) Icon(Icons.Filled.Check, null, Modifier.size(18.dp)) else Spacer(Modifier.size(18.dp)) },
                            selected = false,
                            onClick = { pcs = false; close(); vm.switchPc(l.id) },
                            modifier = Modifier.padding(horizontal = 12.dp),
                        )
                    }
                    NavigationDrawerItem(
                        label = { Text(stringResource(R.string.add_pc), style = MaterialTheme.typography.bodyMedium) },
                        icon = { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)) },
                        selected = false,
                        onClick = { pcs = false; close(); vm.addPc() },
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
                DrawerItem(Icons.Filled.Home, stringResource(R.string.nav_home), state.screen == Screen.Home) { close(); vm.go(Screen.Home) }
                DrawerItem(StarkIcons.Folder, stringResource(R.string.workspaces), state.screen == Screen.Workspaces) { close(); vm.go(Screen.Workspaces) }
                DrawerItem(Icons.Filled.DateRange, stringResource(R.string.nav_deadlines), state.screen == Screen.Deadlines) { close(); vm.go(Screen.Deadlines) }
                DrawerItem(StarkIcons.Computer, stringResource(R.string.nav_this_pc), state.screen == Screen.ThisPc) { close(); vm.go(Screen.ThisPc) }
                DrawerItem(Icons.Filled.Settings, stringResource(R.string.nav_settings), state.screen == Screen.Settings) { close(); vm.go(Screen.Settings) }
                DrawerItem(StarkIcons.Help, stringResource(R.string.nav_guide), state.screen == Screen.Guide) { close(); vm.go(Screen.Guide) }
                if (state.recent.isNotEmpty()) {
                    HorizontalDivider(Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
                    SectionLabel(stringResource(R.string.recent))
                }
            }
            items(state.recent, key = { "${it.workspace.id}-${it.chat.id}" }) { r ->
                NavigationDrawerItem(
                    label = {
                        Column {
                            Text(r.chat.title.ifBlank { stringResource(R.string.new_chat) }, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(r.workspace.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                    },
                    selected = false,
                    onClick = { close(); vm.openChat(r.workspace, r.chat) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun DrawerItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(label, style = MaterialTheme.typography.bodyLarge) },
        icon = { Icon(icon, null, Modifier.size(20.dp)) },
        selected = selected,
        onClick = onClick,
        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent),
        modifier = Modifier.padding(horizontal = 12.dp),
    )
}

@Composable
internal fun StatusLine(state: UiState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val ok = state.hello != null
        Box(Modifier.padding(end = 6.dp).size(7.dp).clip(CircleShape).background(if (ok) Connected else MaterialTheme.colorScheme.outline))
        Text(
            if (ok) stringResource(if (state.hello?.viaRelay == true) R.string.connected_away else R.string.connected) else stringResource(R.string.not_connected),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---- small parts shared by the screens

/** The StarkLLM mark on its dark tile, as in the launcher icon */
@Composable
internal fun Mark(size: Dp) {
    // a hairline keeps the dark tile visible on the dark theme
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(Night)
            .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(size * 0.28f)),
        contentAlignment = Alignment.Center,
    ) {
        Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(size * 1.4f))
    }
}

@Composable
internal fun problemText(problem: Problem?): String = stringResource(
    when (problem) {
        Problem.UNREACHABLE -> R.string.error_unreachable
        Problem.UNREACHABLE_AWAY -> R.string.error_unreachable_away
        Problem.WRONG_PC -> R.string.error_wrong_pc
        Problem.CODE_CLOSED -> R.string.error_code_closed
        Problem.WRONG_CODE -> R.string.error_wrong_code
        Problem.TOO_MANY_DEVICES -> R.string.error_too_many
        Problem.UNPAIRED -> R.string.error_unpaired
        Problem.PC_OFFLINE -> R.string.error_pc_offline
        Problem.NOT_SIGNED_IN -> R.string.several_accounts
        Problem.NOT_ALLOWED -> R.string.error_not_allowed
        Problem.AWAY_OFF -> R.string.error_away_off
        Problem.PAIR_AT_HOME -> R.string.error_pair_at_home
        Problem.SERVER, null -> R.string.error_server
    }
)

@Composable
internal fun NoticeCard(state: UiState, vm: AppViewModel) {
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

/** Top bar: back arrow, or the menu on the main screens; a subtitle (with a "connected" dot) */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun Bar(
    title: String,
    subtitle: String? = null,
    dot: Boolean = false,
    onBack: (() -> Unit)? = null,
    onMenu: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
) {
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
            when {
                onBack != null -> IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
                onMenu != null -> IconButton(onClick = onMenu) { Icon(Icons.Filled.Menu, stringResource(R.string.menu)) }
            }
        },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Color.Transparent),
    )
}

@Composable
internal fun SectionLabel(text: String, start: Dp = 20.dp) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = start, end = 20.dp, top = 12.dp, bottom = 8.dp),
    )
}

/** A row of a list: icon on a tinted tile, text, and an end slot */
@Composable
internal fun ListCard(icon: ImageVector, title: String, subtitle: String? = null, onClick: () -> Unit, end: @Composable () -> Unit) {
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
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            end()
        }
    }
}

@Composable
internal fun EmptyHint(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}

// ---- a file shared from another app

@Composable
private fun SharedDialog(state: UiState, vm: AppViewModel, shared: Shared, onDone: () -> Unit) {
    val context = LocalContext.current
    val workspaces = state.workspaces.orEmpty()
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(stringResource(R.string.share_title), style = MaterialTheme.typography.titleLarge) },
        text = {
            Column {
                val fallback = stringResource(R.string.document_fallback)
                val name = remember(shared, fallback) { nameOf(context, shared.uri) ?: fallback }
                Text(name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                when {
                    state.link == null -> Text(stringResource(R.string.share_not_paired), style = MaterialTheme.typography.bodyMedium)
                    !state.canSend -> Text(problemText(Problem.NOT_ALLOWED), style = MaterialTheme.typography.bodyMedium)
                    workspaces.isEmpty() -> Text(stringResource(R.string.no_workspaces), style = MaterialTheme.typography.bodyMedium)
                    else -> workspaces.forEach { ws ->
                        TextButton(onClick = {
                            vm.upload(ws, name, UriBody(context, shared.uri, shared.mime))
                            onDone()
                        }) { Text(ws.name) }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDone) { Text(stringResource(R.string.cancel)) } },
    )
}

/** A screen on the theme's background (ThemeBackground under the whole app shows through) */
@Composable
internal fun StarkScaffold(
    topBar: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) = Scaffold(
    topBar = topBar, bottomBar = bottomBar, floatingActionButton = floatingActionButton,
    // transparent, so the theme's pattern shows; the text colour must then be given (it would be black)
    containerColor = Color.Transparent, contentColor = MaterialTheme.colorScheme.onBackground, content = content,
)
