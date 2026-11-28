package com.starkllm.app.screens

import android.content.Intent
import android.provider.CalendarContract
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.starkllm.app.R
import com.starkllm.app.Screen
import com.starkllm.app.ui.ChatScreen
import com.starkllm.app.ui.DeadlinesScreen
import com.starkllm.app.ui.SettingsScreen
import com.starkllm.app.ui.ThisPcScreen
import com.starkllm.app.ui.WorkspacesScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import java.time.LocalDate
import java.time.ZoneId

class OtherScreensTest : ScreenTest() {
    @Test
    fun deadlinesOfferTheCalendarWithTheDateFilledIn() {
        show { a, vm -> DeadlinesScreen(Demo.state().copy(screen = Screen.Deadlines), vm, openDrawer = {}) }
        assertEquals(4, compose.onAllNodesWithTag("add-to-calendar").fetchSemanticsNodes().size)
        screenshot("deadlines")
        compose.onAllNodesWithTag("add-to-calendar").onFirst().performClick()
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_INSERT, intent.action)
        assertEquals(CalendarContract.Events.CONTENT_URI, intent.data)
        assertTrue(intent.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false))
        assertEquals("Stadtwerke Musterstadt Energie- und Wasserversorgung GmbH · 486,00 EUR", intent.getStringExtra(CalendarContract.Events.TITLE))
        val begin = LocalDate.parse("2026-11-20").atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        assertEquals(begin, intent.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, 0))
    }

    @Test
    fun deadlinesAtTheLargestTextKeepTheirButtonsAndDates() {
        show(device = FLIP5_LARGEST, fontScale = LARGEST_TEXT) { a, vm -> DeadlinesScreen(Demo.state().copy(screen = Screen.Deadlines), vm, openDrawer = {}) }
        val cut = cutTexts()
        println("deadlines, largest text and display size, cut texts: $cut")
        screenshot("deadlines-largest-text")
        val keep = listOf(R.string.add_to_calendar, R.string.mark_done, R.string.deadline_overdue, R.string.deadline_today).map { activity.getString(it) }
        assertTrue("cut: $cut", cut.none { c -> keep.any { c.contains(it) } })
    }

    @Test
    fun deadlinesAreLabelledForTalkBack() {
        show { a, vm -> DeadlinesScreen(Demo.state().copy(screen = Screen.Deadlines), vm, openDrawer = {}) }
        assertEveryTapTargetIsLabelled()
    }

    @Test
    fun aChatShowsItsWaitingQuestionWithCancel() {
        val state = Demo.state(online = false, queue = Demo.queue).copy(screen = Demo.chat, lines = Demo.chatLines)
        show { a, vm -> ChatScreen(state, vm, Demo.chat, a) }
        // only the question of this chat (chat 7), not the one for a new chat
        assertEquals(1, compose.onAllNodesWithTag("waiting-question").fetchSemanticsNodes().size)
        compose.onNodeWithText(Demo.queue[1].text).assertExists()
        assertEveryTapTargetIsLabelled()
        screenshot("chat-queue")
    }

    @Test
    fun thisPcSettingsAndWorkspacesAreLabelledForTalkBack() {
        show { a, vm -> ThisPcScreen(Demo.state().copy(screen = Screen.ThisPc), vm, a, openDrawer = {}) }
        assertEveryTapTargetIsLabelled()
        compose.onNodeWithTag("photo-letter", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun settingsAreLabelledForTalkBack() {
        show { a, vm -> SettingsScreen(Demo.state().copy(screen = Screen.Settings), vm, a, openDrawer = {}) }
        assertEveryTapTargetIsLabelled()
    }

    @Test
    fun workspacesAreLabelledForTalkBack() {
        show { a, vm -> WorkspacesScreen(Demo.state().copy(screen = Screen.Workspaces), vm, openDrawer = {}) }
        assertEveryTapTargetIsLabelled()
    }
}
