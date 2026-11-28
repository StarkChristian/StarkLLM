package com.starkllm.app.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/**
 * A question asked while the PC could not be reached. It waits on this phone, encrypted (KeystoreBox), and goes to
 * the same PC when it answers again; the user can cancel it. It is never sent anywhere else.
 */
@Serializable
data class QueuedQuestion(
    val id: String,
    /** the PC it was asked of (Link.id): it is sent only there */
    val pcId: String,
    val workspaceId: Int,
    val workspaceName: String = "",
    /** the chat it was asked in; null: a new chat */
    val chatId: Int? = null,
    val text: String,
    val model: String? = null,
    val useKnowledgeBase: Boolean = false,
    val language: String? = null,
    val askedAt: Long = 0,
    /** the PC answered, but refused it (the workspace is gone, the phone may no longer ask): not tried again */
    val failed: Boolean = false,
)

@Serializable
private data class SealedQueue(val c: String, val iv: String)

/** The waiting questions, oldest first; at most [MAX]. Storage and encryption are given, so a test can run it on the JVM. */
class QuestionQueue(
    private val read: () -> String?,
    private val write: (String?) -> Unit,
    private val box: Box,
) {
    private val list = ListSerializer(QueuedQuestion.serializer())

    fun all(): List<QueuedQuestion> {
        val raw = read() ?: return emptyList()
        return runCatching {
            val sealed = json.decodeFromString(SealedQueue.serializer(), raw)
            json.decodeFromString(list, box.open(sealed.c, sealed.iv))
        }.getOrDefault(emptyList())     // a key that is gone (the phone was reset): nothing can be read, nothing is sent
    }

    fun forPc(pcId: String): List<QueuedQuestion> = all().filter { it.pcId == pcId }

    /** false: the queue is full */
    fun add(q: QueuedQuestion): Boolean {
        val now = all()
        if (now.size >= MAX) return false
        save(now + q)
        return true
    }

    fun remove(id: String) = save(all().filter { it.id != id })

    fun markFailed(id: String) = save(all().map { if (it.id == id) it.copy(failed = true) else it })

    /** the PC was unpaired: its questions are dropped */
    fun removePc(pcId: String) = save(all().filter { it.pcId != pcId })

    private fun save(items: List<QueuedQuestion>) {
        if (items.isEmpty()) {
            write(null)
            return
        }
        val (c, iv) = box.seal(json.encodeToString(list, items))
        write(json.encodeToString(SealedQueue.serializer(), SealedQueue(c, iv)))
    }

    companion object {
        const val MAX = 20

        fun of(context: Context): QuestionQueue {
            val prefs = context.getSharedPreferences("queue", Context.MODE_PRIVATE)
            return QuestionQueue(
                read = { prefs.getString("questions", null) },
                write = { v -> prefs.edit().apply { if (v == null) remove("questions") else putString("questions", v) }.commit() },
                box = KeystoreBox("starkllm_queue"),
            )
        }
    }
}
