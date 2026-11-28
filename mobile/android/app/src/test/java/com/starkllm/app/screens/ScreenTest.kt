package com.starkllm.app.screens

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.starkllm.app.AppViewModel
import com.starkllm.app.ScreensTestActivity
import com.starkllm.app.ui.LocalPosture
import com.starkllm.app.ui.LocalStarkTheme
import com.starkllm.app.ui.Posture
import com.starkllm.app.ui.StarkTheme
import com.starkllm.app.ui.ThemeBackground
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * One screen of the app with demo data, on the JVM (Robolectric), at a phone's size, text size and posture. The
 * screenshots go to build/outputs/screens (CI keeps them with the test reports).
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [36])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
abstract class ScreenTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private var scenario: ActivityScenario<ScreensTestActivity>? = null
    lateinit var activity: ScreensTestActivity
    lateinit var vm: AppViewModel

    @After
    fun close() {
        scenario?.close()
    }

    /** [device]: Android resource qualifiers (size, density, language); [fontScale]: the phone's text size (1.3 = 130 %) */
    fun show(
        device: String = FLIP5,
        fontScale: Float = 1.3f,
        theme: String = "dark",
        posture: Posture = Posture(),
        content: @Composable (ScreensTestActivity, AppViewModel) -> Unit,
    ) {
        RuntimeEnvironment.setQualifiers(device)
        RuntimeEnvironment.setFontScale(fontScale)
        scenario = ActivityScenario.launch(ScreensTestActivity::class.java).onActivity { a ->
            activity = a
            vm = AppViewModel(a.application)
            a.setContent {
                StarkTheme(themeId = theme) {
                    CompositionLocalProvider(LocalPosture provides posture) {
                        Box(Modifier.fillMaxSize()) {
                            ThemeBackground(LocalStarkTheme.current)
                            content(a, vm)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    fun screenshot(name: String) {
        val dir = File(System.getProperty("screens.out") ?: "build/outputs/screens").apply { mkdirs() }
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** TalkBack: everything that can be tapped says what it is (a text or a description), or is a text field */
    fun assertEveryTapTargetIsLabelled() {
        val nodes = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick)).fetchSemanticsNodes()
        val silent = nodes.filter { n ->
            val c = n.config
            c.getOrNull(SemanticsProperties.ContentDescription).orEmpty().all { it.isBlank() } &&
                c.getOrNull(SemanticsProperties.Text).orEmpty().all { it.isBlank() } &&
                c.getOrNull(SemanticsProperties.EditableText) == null
        }
        assertTrue("tap targets without a label at ${silent.map { it.boundsInRoot }}", silent.isEmpty())
    }

    /** texts that do not fit (cut off with "…" or clipped), with the test tag of the element they are in */
    fun cutTexts(): List<String> {
        val nodes = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.GetTextLayoutResult), useUnmergedTree = true).fetchSemanticsNodes()
        return nodes.mapNotNull { n ->
            val results = mutableListOf<TextLayoutResult>()
            n.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
            val r = results.firstOrNull() ?: return@mapNotNull null
            // cut: more lines than allowed, ended with "…", or a line wider than the text's box. (didOverflowWidth does
            // not tell under Robolectric: its paragraphs report the whole width they were offered.)
            val cut = r.multiParagraph.didExceedMaxLines || (0 until r.lineCount).any { r.isLineEllipsized(it) || r.getLineRight(it) > r.size.width + 1 }
            if (!cut) return@mapNotNull null
            val tag = generateSequence(n) { it.parent }.firstNotNullOfOrNull { it.config.getOrNull(SemanticsProperties.TestTag) }
            "${tag ?: "-"}: ${r.layoutInput.text}"
        }
    }

    fun nodesWithText(text: String): List<SemanticsNode> =
        compose.onAllNodes(SemanticsMatcher("text $text") { n -> n.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text.contains(text) } },
            useUnmergedTree = true).fetchSemanticsNodes()

    companion object {
        /** The owner's Galaxy Z Flip5: 1080 px wide at 510 dpi (a larger display zoom), German */
        const val FLIP5 = "de-w339dp-h829dp-port-510dpi"
        /** The largest display zoom of the Flip5 (about 600 dpi) */
        const val FLIP5_LARGEST = "de-w288dp-h704dp-port-600dpi"
        /** The Flip5's cover screen (Flex Window): 720 x 748 px */
        const val COVER = "de-w340dp-h352dp-port-340dpi"
        /** Android's largest text size */
        const val LARGEST_TEXT = 2.0f
    }
}
