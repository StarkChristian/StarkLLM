package com.starkllm.app.screens

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.starkllm.app.Answered
import com.starkllm.app.R
import com.starkllm.app.ui.HomeScreen
import com.starkllm.app.ui.Posture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeScreenTest : ScreenTest() {
    private fun home(state: com.starkllm.app.UiState = Demo.state(), device: String = FLIP5, fontScale: Float = 1.3f, posture: Posture = Posture()) =
        show(device = device, fontScale = fontScale, posture = posture) { a, vm -> HomeScreen(state, vm, a, openDrawer = {}, focusAsk = 0) }

    @Test
    fun newDocumentsNameSenderKindAndAmountAndTheFileOnlyWithoutThem() {
        home()
        val invoice = activity.getString(R.string.kind_invoice)
        // the amount of the Stadtwerke letter comes from its deadline, the water bill's from the PC (letter_amount)
        compose.onNodeWithText("Stadtwerke Musterstadt · $invoice · 486,00 EUR").assertExists()
        compose.onNodeWithText("Sampleton Water Ltd · $invoice · 63.40 GBP").assertExists()
        compose.onNodeWithText("IMG_4711.jpg").assertExists()
        assertTrue(nodesWithText("Stadtwerke-Rechnung.pdf").isEmpty())
        screenshot("home")
    }

    @Test
    fun deadlinesSayHowUrgentTheyAreAndTakeTwoLinesAtTheOwnersTextSize() {
        home()
        assertEquals(3, compose.onAllNodesWithTag("deadline-row", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertTrue(nodesWithText(activity.getString(R.string.deadline_overdue)).isNotEmpty())
        assertTrue(nodesWithText(activity.getString(R.string.deadline_today)).isNotEmpty())
        assertDeadlineRowsKeepDateAndAmount()
        val cut = cutTexts().filter { it.startsWith("document-row") }
        assertTrue("cut off at 130 %: $cut", cut.isEmpty())
    }

    /** every row: the date on its first line, sender · amount on the second; only a long sender may end with "…" */
    private fun assertDeadlineRowsKeepDateAndAmount() {
        val cut = cutTexts()
        assertTrue("date or amount cut: $cut", cut.none { it.startsWith("deadline-when") || it.startsWith("deadline-amount") })
        val whens = compose.onAllNodesWithTag("deadline-when", useUnmergedTree = true).fetchSemanticsNodes()
        val whos = compose.onAllNodesWithTag("deadline-who", useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(3, whens.size)
        whens.zip(whos).forEach { (w, s) -> assertTrue("sender on the line under the date", s.boundsInRoot.top >= w.boundsInRoot.bottom - 1) }
        assertTrue(nodesWithText("486,00 EUR").isNotEmpty())
    }

    @Test
    fun aLargeButtonPhotographsALetter() {
        home()
        compose.onNodeWithTag("photo-letter").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText(activity.getString(R.string.home_photo), useUnmergedTree = true).assertExists()
    }

    @Test
    fun thePhotoButtonIsOffWhenThePcAllowsOnlyQuestions() {
        home(Demo.state(level = "ask"))
        compose.onNodeWithTag("photo-letter").assertIsNotEnabled()
    }

    @Test
    fun waitingQuestionsAreShownWithCancelAndAnsweredOnesCanBeOpened() {
        home(Demo.state(online = false, queue = Demo.queue,
            answered = listOf(Answered("a1", Demo.workspace, 9, "Welche Frist nennt die Hausverwaltung?"))))
        compose.onNodeWithTag("queue").assertIsDisplayed()
        compose.onNodeWithText(Demo.queue[0].text).assertExists()
        assertEquals(2, compose.onAllNodes(SemanticsMatcher("cancel") { n ->
            n.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().contains(activity.getString(R.string.queue_cancel))
        }).fetchSemanticsNodes().size)
        assertTrue(nodesWithText(activity.getString(R.string.queue_open)).isNotEmpty())
        screenshot("home-queue")
    }

    @Test
    fun everyButtonHasALabelForTalkBack() {
        home(Demo.state(queue = Demo.queue, answered = listOf(Answered("a1", Demo.workspace, 9, "Frage"))))
        assertEveryTapTargetIsLabelled()
        compose.onNodeWithContentDescription(activity.getString(R.string.menu)).assertExists()
        compose.onNodeWithContentDescription(activity.getString(R.string.attach)).assertExists()
        compose.onNodeWithContentDescription(activity.getString(R.string.hold_to_talk), useUnmergedTree = true).assertExists()
    }

    @Test
    fun theLargestTextAndDisplaySizeCutNoButtonOrHeading() {
        home(device = FLIP5_LARGEST, fontScale = LARGEST_TEXT)
        val cut = cutTexts()
        println("home, largest text and display size, cut texts: $cut")
        screenshot("home-largest-text")
        val important = listOf(R.string.home_photo, R.string.nav_deadlines, R.string.recent_documents, R.string.suggestion_1,
            R.string.suggestion_2, R.string.suggestion_3).map { activity.getString(it) }
        assertTrue("cut: $cut", cut.none { c -> important.any { c.endsWith(": $it") } })
        assertTrue("headings cut: $cut", cut.none { it.startsWith("deadline-when") || it.startsWith("deadline-amount") })
        assertDeadlineRowsKeepDateAndAmount()
    }

    @Test
    fun halfFoldedTheCardsAreAboveTheFoldAndTheQuestionFieldBelowIt() {
        // the Flip5 half folded: the fold across the middle of the screen
        val heightPx = (829 * 510 / 160f).toInt()
        val posture = Posture(tabletop = true, hingeTop = heightPx / 2 - 10, hingeBottom = heightPx / 2 + 10)
        home(posture = posture)
        val field = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText)).fetchSemanticsNodes().single()
        val photo = compose.onNodeWithTag("photo-letter").fetchSemanticsNode()
        val deadlines = nodesWithText(activity.getString(R.string.nav_deadlines)).first()
        assertTrue("question field below the fold", field.boundsInWindow.top >= posture.hingeBottom)
        assertTrue("photo button below the fold", photo.boundsInWindow.top >= posture.hingeBottom)
        assertTrue("deadlines above the fold", deadlines.boundsInWindow.bottom <= posture.hingeTop)
        screenshot("home-flex-mode")
    }

    @Test
    fun theCoverScreenShowsTheHomeWithoutTheSubtitle() {
        home(device = COVER)
        assertTrue(nodesWithText(activity.getString(R.string.home_subtitle)).isEmpty())
        compose.onNodeWithTag("photo-letter").assertExists()
        assertEveryTapTargetIsLabelled()
        screenshot("home-cover-screen")
    }
}
