package com.starkllm.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class QuestionQueueTest {
    /** stands in for the Android Keystore: "encrypts" by reversing and base64 */
    private class FakeBox : Box {
        var destroyed = false
        override fun seal(plain: String) = Base64.getEncoder().encodeToString(plain.reversed().toByteArray()) to "iv"
        override fun open(cipherText: String, iv: String): String {
            check(!destroyed)
            return String(Base64.getDecoder().decode(cipherText)).reversed()
        }
        override fun destroy() { destroyed = true }
    }

    private var stored: String? = null
    private val box = FakeBox()
    private val queue = QuestionQueue(read = { stored }, write = { stored = it }, box = box)

    private fun q(id: String, pc: String = "pc1", chat: Int? = null) = QuestionQueue.run {
        QueuedQuestion(id, pc, workspaceId = 1, workspaceName = "Briefe", chatId = chat, text = "Frage $id")
    }

    @Test
    fun questionsAreKeptSealedAndInOrder() {
        queue.add(q("a"))
        queue.add(q("b"))
        assertEquals(listOf("a", "b"), queue.all().map { it.id })
        assertFalse("the question is not stored in clear text", stored!!.contains("Frage a"))
    }

    @Test
    fun cancelFailAndUnpair() {
        queue.add(q("a"))
        queue.add(q("b", pc = "pc2"))
        queue.add(q("c"))
        queue.remove("a")
        queue.markFailed("c")
        assertEquals(listOf("c"), queue.forPc("pc1").map { it.id })
        assertTrue(queue.forPc("pc1").single().failed)
        queue.removePc("pc2")
        queue.remove("c")
        assertNull("an empty queue leaves nothing behind", stored)
    }

    @Test
    fun atMostTwentyWait() {
        repeat(QuestionQueue.MAX) { assertTrue(queue.add(q("$it"))) }
        assertFalse(queue.add(q("one more")))
        assertEquals(QuestionQueue.MAX, queue.all().size)
    }

    @Test
    fun withoutItsKeyNothingIsReadAndNothingSent() {
        queue.add(q("a"))
        box.destroy()
        assertEquals(emptyList<QueuedQuestion>(), queue.all())
    }
}
