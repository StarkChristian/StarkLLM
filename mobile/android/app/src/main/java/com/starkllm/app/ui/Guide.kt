package com.starkllm.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.starkllm.app.R

/** The topics of the guide: title and text (lines starting with "• " become a list) */
private val TOPICS = listOf(
    R.string.help_connect_title to R.string.help_connect,
    R.string.help_ask_title to R.string.help_ask,
    R.string.help_add_title to R.string.help_add,
    R.string.help_dictate_title to R.string.help_dictate,
    R.string.help_deadlines_title to R.string.help_deadlines,
    R.string.help_pcs_title to R.string.help_pcs,
    R.string.help_privacy_title to R.string.help_privacy,
    R.string.help_trouble_title to R.string.help_trouble,
)

private val TOPIC_ICONS = listOf(
    StarkIcons.QrScan, StarkIcons.Chat, StarkIcons.UploadFile, StarkIcons.Mic,
    StarkIcons.Calendar, StarkIcons.Computer, StarkIcons.Shield, StarkIcons.Help,
)

@Composable
internal fun GuideScreen(openDrawer: () -> Unit) {
    var open by rememberSaveable { mutableIntStateOf(0) }
    StarkScaffold(topBar = { Bar(stringResource(R.string.nav_guide), onMenu = openDrawer) }) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Lucy(Modifier.width(92.dp), waving = true, description = stringResource(R.string.lucy))
                    Surface(
                        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 16.dp, bottomStart = 4.dp),
                        color = MaterialTheme.colorScheme.surfaceContainer,
                        modifier = Modifier.padding(start = 12.dp),
                    ) {
                        Text(stringResource(R.string.help_hello), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
                    }
                }
            }
            itemsIndexed(TOPICS) { i, (title, body) ->
                val expanded = open == i
                Surface(
                    onClick = { open = if (expanded) -1 else i },
                    shape = CardShape,
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer),
                                contentAlignment = Alignment.Center,
                            ) { Icon(TOPIC_ICONS[i], null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer) }
                            Text(stringResource(title), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
                            Icon(if (expanded) StarkIcons.ExpandLess else StarkIcons.ExpandMore, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        AnimatedVisibility(expanded, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                            GuideText(stringResource(body), Modifier.padding(top = 10.dp, start = 46.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GuideText(text: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        text.split('\n').filter { it.isNotBlank() }.forEach { line ->
            if (line.startsWith("• ")) {
                Row {
                    Text("•", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(14.dp))
                    Text(line.removePrefix("• "), style = MaterialTheme.typography.bodyMedium)
                }
            } else {
                Text(line, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** First start: three short pages with Lucy, then the pairing */
@Composable
fun IntroScreen(onDone: () -> Unit) {
    var page by rememberSaveable { mutableIntStateOf(0) }
    val pages = listOf(
        R.string.intro1_title to R.string.intro1_body,
        R.string.intro2_title to R.string.intro2_body,
        R.string.intro3_title to R.string.intro3_body,
    )
    val theme = LocalStarkTheme.current
    Box(Modifier.fillMaxSize()) {
        ThemeBackground(theme)
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (page < pages.size - 1) TextButton(onClick = onDone) { Text(stringResource(R.string.intro_skip)) }
                else Spacer(Modifier.height(48.dp))
            }
            AnimatedContent(
                targetState = page,
                transitionSpec = { (slideInHorizontally { it / 3 } + fadeIn()) togetherWith (slideOutHorizontally { -it / 3 } + fadeOut()) },
                modifier = Modifier.weight(1f),
                label = "intro",
            ) { p ->
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Lucy(Modifier.width(190.dp), waving = p == 0, description = stringResource(R.string.lucy))
                    Spacer(Modifier.height(28.dp))
                    Text(stringResource(pages[p].first), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onBackground)
                    Text(stringResource(pages[p].second), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalArrangement = Arrangement.Center) {
                pages.indices.forEach { i ->
                    Box(Modifier.padding(4.dp).size(width = if (i == page) 22.dp else 8.dp, height = 8.dp).clip(CircleShape)
                        .background(if (i == page) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant))
                }
            }
            Button(
                onClick = { if (page < pages.size - 1) page++ else onDone() },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                contentPadding = PaddingValues(),
            ) {
                Box(Modifier.fillMaxSize().background(textGradientOf(theme)), contentAlignment = Alignment.Center) {
                    Text(stringResource(if (page < pages.size - 1) R.string.intro_next else R.string.intro_start),
                        style = MaterialTheme.typography.labelLarge, color = onGradientOf(theme))
                }
            }
        }
    }
}
