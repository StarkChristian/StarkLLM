package com.starkllm.app.ui

import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton

import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.starkllm.app.AppViewModel
import com.starkllm.app.BuildConfig
import com.starkllm.app.R
import com.starkllm.app.UiState
import com.starkllm.app.data.Deadline
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// ---- deadlines

@Composable
internal fun DeadlinesScreen(state: UiState, vm: AppViewModel, openDrawer: () -> Unit) {
    val all = state.deadlines.orEmpty()
    val groups = listOf(
        R.string.state_overdue to all.filter { !it.done && it.state == "overdue" },
        R.string.state_today to all.filter { !it.done && it.state == "today" },
        R.string.state_soon to all.filter { !it.done && it.state == "soon" },
        R.string.state_upcoming to all.filter { !it.done && it.state == "upcoming" },
        R.string.state_done to all.filter { it.done },
    ).filter { it.second.isNotEmpty() }
    StarkScaffold(topBar = {
        Bar(stringResource(R.string.nav_deadlines), subtitle = state.link?.pcName, onMenu = openDrawer) {
            IconButton(onClick = { vm.go(com.starkllm.app.Screen.Deadlines) }) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else Spacer(Modifier.height(4.dp))
            NoticeCard(state, vm)
            if (state.deadlines != null && groups.isEmpty()) EmptyHint(stringResource(R.string.no_deadlines))
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                groups.forEach { (label, list) ->
                    item(key = "h$label") { SectionLabel(stringResource(label)) }
                    items(list, key = { it.key }) { d -> DeadlineCard(d, state.canSend) { vm.setDone(d, !d.done) } }
                }
                item { Text(stringResource(R.string.deadlines_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(20.dp)) }
            }
        }
    }
}

@Composable
private fun DeadlineCard(d: Deadline, canChange: Boolean, onToggle: () -> Unit) {
    val date = remember(d.date) { runCatching { LocalDate.parse(d.date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(d.date) }
    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(stateColor(d)))
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(date, style = MaterialTheme.typography.titleSmall)
                    val rel = when (d.state) {
                        "overdue" -> stringResource(R.string.deadline_overdue)
                        "today" -> stringResource(R.string.deadline_today)
                        else -> if (d.done) "" else pluralStringResource(R.plurals.deadline_in_days, d.days, d.days)
                    }
                    if (rel.isNotEmpty()) Text(" · $rel", style = MaterialTheme.typography.bodySmall, color = stateColor(d))
                }
                val what = listOfNotNull(d.sender ?: d.title, d.amount).joinToString(" · ")
                if (what.isNotEmpty()) Text(what, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 2.dp))
                Text(d.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                d.filename?.let {
                    Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(StarkIcons.Document, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 4.dp))
                    }
                }
            }
            if (canChange) {
                TextButton(onClick = onToggle, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text(stringResource(if (d.done) R.string.reopen else R.string.mark_done), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

// ---- this PC

@Composable
internal fun ThisPcScreen(state: UiState, vm: AppViewModel, activity: FragmentActivity, openDrawer: () -> Unit) {
    var confirmOffline by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val link = state.link
    val pc = state.pc
    val confirmTitle = stringResource(R.string.confirm_action)
    StarkScaffold(topBar = {
        Bar(stringResource(R.string.nav_this_pc), onMenu = openDrawer) {
            IconButton(onClick = vm::refreshPc) { Icon(Icons.Filled.Refresh, stringResource(R.string.refresh)) }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            NoticeCard(state, vm)
            if (link != null) {
                Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Mark(44.dp)
                        Column(Modifier.padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(link.pcName, style = MaterialTheme.typography.titleMedium)
                            StatusLine(state)
                            val version = pc?.version?.takeIf { it.isNotBlank() } ?: state.hello?.version
                            if (!version.isNullOrBlank()) Text(stringResource(R.string.pc_version, version), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            InfoRow(StarkIcons.Chip, stringResource(R.string.ai_model),
                state.engine?.textModel?.let { m -> listOfNotNull(m.name, statusWord(m.status)).joinToString(" · ") } ?: stringResource(R.string.loading))
            pc?.backup?.let { b ->
                val text = if (!b.enabled) stringResource(R.string.backup_off) else listOfNotNull(
                    b.lastSuccess?.let { stringResource(R.string.backup_last, relative(it)) },
                    b.nextDue?.let { stringResource(R.string.backup_next, relative(it)) },
                    b.lastError?.let { stringResource(R.string.backup_error) },
                ).joinToString(" · ").ifEmpty { stringResource(R.string.backup_on) }
                InfoRow(StarkIcons.Backup, stringResource(R.string.backup), text)
            }
            pc?.protection?.let { p ->
                InfoRow(StarkIcons.Shield, stringResource(R.string.protection), stringResource(if (p.enabled) R.string.protection_on else R.string.protection_off))
            }
            InfoRow(Icons.Filled.Lock, stringResource(R.string.this_phone_may), stringResource(levelText(state.level)))

            SectionLabel(stringResource(R.string.actions), start = 4.dp)
            if (state.canManage) {
                Button(
                    onClick = { confirmPerson(activity, confirmTitle, activity.getString(R.string.action_backup)) { vm.runAction("backup-now") } },
                    enabled = state.actionRunning == null,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    if (state.actionRunning == "backup-now") CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else Icon(StarkIcons.Backup, null, Modifier.size(18.dp))
                    Text(stringResource(R.string.action_backup), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelLarge)
                }
                OutlinedButton(
                    onClick = { confirmOffline = true },
                    enabled = state.actionRunning == null,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Icon(StarkIcons.CloudOff, null, Modifier.size(18.dp))
                    Text(stringResource(R.string.action_offline), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelLarge)
                }
            } else {
                Text(stringResource(R.string.actions_not_allowed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp))
            }

            SectionLabel(stringResource(R.string.paired_pcs), start = 4.dp)
            state.links.forEach { l ->
                ListCard(StarkIcons.Computer, l.pcName, subtitle = l.addresses.firstOrNull(), onClick = { vm.switchPc(l.id) }) {
                    if (l.id == link?.id) Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary)
                }
            }
            OutlinedButton(onClick = vm::addPc, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Icon(Icons.Filled.Add, null, Modifier.size(18.dp))
                Text(stringResource(R.string.add_pc), Modifier.padding(start = 8.dp))
            }
            TextButton(onClick = { confirmUnpair = true }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.unpair), color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(16.dp))
        }
    }
    if (confirmOffline) {
        AlertDialog(
            onDismissRequest = { confirmOffline = false },
            title = { Text(stringResource(R.string.action_offline), style = MaterialTheme.typography.titleLarge) },
            text = { Text(stringResource(R.string.action_offline_confirm), style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    confirmOffline = false
                    confirmPerson(activity, confirmTitle, activity.getString(R.string.action_offline)) { vm.runAction("go-offline") }
                }) { Text(stringResource(R.string.action_offline_go), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmOffline = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    if (confirmUnpair && link != null) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(stringResource(R.string.unpair), style = MaterialTheme.typography.titleLarge) },
            text = { Text(stringResource(R.string.unpair_confirm), style = MaterialTheme.typography.bodyMedium) },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.removePc(link.id) }) { Text(stringResource(R.string.unpair), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

private fun levelText(level: String) = when (level) {
    "ask" -> R.string.level_ask
    "manage" -> R.string.level_manage
    else -> R.string.level_work
}

@Composable
private fun statusWord(status: String) = when (status) {
    "online" -> stringResource(R.string.status_ready)
    "unknown" -> null
    else -> stringResource(R.string.status_not_ready)
}

private fun relative(millis: Long): String =
    DateUtils.getRelativeTimeSpanString(millis, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
        .replaceFirstChar { it.lowercase() }   // inside a sentence ("zuletzt vor 3 Tagen", not "Vor")

@Composable
private fun InfoRow(icon: ImageVector, title: String, value: String) {
    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.padding(start = 12.dp)) {
                Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(value, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

// ---- settings of the phone

@Composable
internal fun SettingsScreen(state: UiState, vm: AppViewModel, activity: FragmentActivity, openDrawer: () -> Unit) {
    val context = LocalContext.current
    val canLock = remember {
        BiometricManager.from(context).canAuthenticate(
            if (Build.VERSION.SDK_INT >= 30) BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
            else BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        ) == BiometricManager.BIOMETRIC_SUCCESS
    }
    var notifyDenied by remember { mutableStateOf(false) }
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.setReminders(true) else notifyDenied = true
    }
    if (notifyDenied) PermissionDialog(stringResource(R.string.permission_notifications)) { notifyDenied = false }
    val lockTitle = stringResource(R.string.app_lock)
    StarkScaffold(topBar = { Bar(stringResource(R.string.nav_settings), onMenu = openDrawer) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel(stringResource(R.string.appearance), start = 4.dp)
            ThemePicker(state.theme, vm::setTheme)
            SectionLabel(stringResource(R.string.nav_settings), start = 4.dp)
            SettingSwitch(Icons.Filled.Lock, lockTitle, stringResource(if (canLock) R.string.app_lock_hint else R.string.app_lock_unavailable),
                state.appLock, enabled = canLock) { on ->
                // turning it on is confirmed once, so nobody is locked out by a sensor that does not work
                if (on) confirmPerson(activity, lockTitle, null) { vm.setAppLock(true) } else vm.setAppLock(false)
            }
            SettingSwitch(Icons.Filled.Notifications, stringResource(R.string.reminders), stringResource(R.string.reminders_hint), state.reminders) { on ->
                if (on && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else vm.setReminders(on)
            }
            SectionLabel(stringResource(R.string.shortcuts), start = 4.dp)
            Text(stringResource(R.string.shortcuts_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 4.dp))
            SectionLabel(stringResource(R.string.about), start = 4.dp)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 4.dp)) {
                Mark(36.dp)
                Column(Modifier.padding(start = 12.dp)) {
                    Text("StarkLLM ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.about_open_source), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(Modifier.padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
                Icon(Icons.Filled.Lock, null, Modifier.padding(top = 2.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(R.string.privacy_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

@Composable
private fun SettingSwitch(icon: ImageVector, title: String, hint: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
        }
    }
}

// ---- the look (themes of the PC, ui/Themes.kt)

private val THEME_NAMES = mapOf(
    "dark" to R.string.theme_dark, "pink" to R.string.theme_pink, "black" to R.string.theme_black, "glass" to R.string.theme_glass,
    "emerald" to R.string.theme_emerald, "amber" to R.string.theme_amber, "nord" to R.string.theme_nord, "light" to R.string.theme_light,
    "doodle" to R.string.theme_doodle, "doodle-night" to R.string.theme_doodle_night, "flowers" to R.string.theme_flowers,
    "matrix" to R.string.theme_matrix, "stars" to R.string.theme_stars,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ThemePicker(selected: String, onSelect: (String) -> Unit) {
    val systemDark = isSystemInDarkTheme()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ThemeTile(themeFor(SYSTEM_THEME, systemDark), stringResource(R.string.theme_system), selected == SYSTEM_THEME, split = true) { onSelect(SYSTEM_THEME) }
        THEMES.forEach { t ->
            ThemeTile(t, stringResource(THEME_NAMES[t.id] ?: R.string.theme_dark), selected == t.id) { onSelect(t.id) }
        }
    }
}

/** A small picture of the theme: its background (and pattern), a card, a question bubble in its gradient */
@Composable
private fun ThemeTile(t: AppTheme, name: String, selected: Boolean, split: Boolean = false, onClick: () -> Unit) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Column(Modifier.width(90.dp).clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.fillMaxWidth().height(62.dp).clip(RoundedCornerShape(14.dp))
                .border(if (selected) 2.dp else 1.dp, border, RoundedCornerShape(14.dp)),
        ) {
            if (split) {
                Row(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f).fillMaxHeight().background(THEMES.first { it.id == "light" }.bg))
                    Box(Modifier.weight(1f).fillMaxHeight().background(THEMES.first().bg))
                }
            } else {
                ThemeBackground(t, Modifier.fillMaxSize())
            }
            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Box(Modifier.size(width = 48.dp, height = 10.dp).clip(RoundedCornerShape(4.dp)).background(if (split) THEMES.first().card else t.card))
                Box(Modifier.align(Alignment.End).size(width = 36.dp, height = 10.dp).clip(RoundedCornerShape(4.dp)).background(gradientOf(t)))
                Box(Modifier.size(width = 56.dp, height = 10.dp).clip(RoundedCornerShape(4.dp)).background(if (split) THEMES.first { it.id == "light" }.card else t.card))
            }
            if (selected) {
                Box(Modifier.align(Alignment.TopEnd).padding(5.dp).size(18.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Check, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onPrimary)
                }
            }
        }
        Text(name, style = MaterialTheme.typography.labelSmall, maxLines = 2, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 5.dp, bottom = 2.dp))
    }
}
