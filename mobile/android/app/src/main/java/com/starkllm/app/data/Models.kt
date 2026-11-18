package com.starkllm.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

@Serializable
data class PairRequest(val code: String, val name: String)

@Serializable
data class PairResponse(
    @SerialName("device_id") val deviceId: String,
    val token: String,
    @SerialName("pc_name") val pcName: String = "",
    val version: String = "",
)

@Serializable
data class Hello(
    @SerialName("pc_name") val pcName: String = "",
    val version: String = "",
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("signed_in") val signedIn: Boolean = false,
)

@Serializable
data class Workspace(val id: Int, val name: String = "")

@Serializable
data class ChatSummary(
    val id: Int,
    val title: String = "",
    @SerialName("is_pinned") val pinned: Boolean = false,
)

@Serializable
data class NewChat(val id: Int, val title: String = "")

@Serializable
data class SessionMessage(
    val id: Int? = null,
    val role: String,
    val content: String = "",
    val sources: JsonElement? = null,
)

@Serializable
data class Session(
    @SerialName("chat_id") val chatId: Int,
    val title: String = "",
    val messages: List<SessionMessage> = emptyList(),
)

@Serializable
data class ChatRequest(
    @SerialName("workspace_id") val workspaceId: Int,
    @SerialName("chat_id") val chatId: Int? = null,
    val message: String,
    val stream: Boolean = true,
    val language: String? = null,
)

/** What an answer says about its sources (backend: chat.py, _sources_used): the documents it used, and quotations that
 * are not in the documents. */
data class AnswerSources(val documents: List<String>, val unverifiedQuotes: List<String>) {
    companion object {
        val NONE = AnswerSources(emptyList(), emptyList())

        fun from(sources: JsonElement?): AnswerSources {
            val o = sources as? JsonObject ?: return NONE
            fun strings(key: String) = (o[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            val docs = (strings("ws") + strings("kb")).map(::documentName).filter { it.isNotBlank() }.distinct()
            return AnswerSources(docs, strings("unverified_quotes"))
        }

        private val CHUNK = Regex("""\s*\((Chunk|chunk|Abschnitt)\s*\d+\)\s*$""")

        /** "folder/report.pdf (Chunk 3)" -> "report.pdf": the source line names documents, not search passages */
        fun documentName(label: String): String = CHUNK.replace(label.substringAfterLast('/').substringAfterLast('\\'), "").trim()
    }
}

/** One line of the chat as the phone shows it */
data class ChatLine(
    val role: String,
    val text: String,
    val sources: AnswerSources = AnswerSources.NONE,
    val streaming: Boolean = false,
    val failed: Boolean = false,
)
