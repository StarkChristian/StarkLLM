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
data class PairRequest(
    val code: String,
    val name: String,
    // the earlier pairing of this phone with the same PC: the PC replaces it instead of listing the phone twice
    val replaces: String? = null,
    @SerialName("replaces_token") val replacesToken: String? = null,
)

@Serializable
data class PairResponse(
    @SerialName("device_id") val deviceId: String,
    val token: String,
    @SerialName("pc_name") val pcName: String = "",
    val version: String = "",
    val level: String = "work",
)

@Serializable
data class Hello(
    @SerialName("pc_name") val pcName: String = "",
    val version: String = "",
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("signed_in") val signedIn: Boolean = false,
    /** what this phone may do, set on the PC (Settings > Phone): ask, work or manage; older PCs send none (= work) */
    val level: String = "work",
    /** this answer came through the StarkLLM relay: the phone is away from home (2.6) */
    @SerialName("via_relay") val viaRelay: Boolean = false,
)

@Serializable
data class Workspace(val id: Int, val name: String = "")

@Serializable
data class ChatSummary(
    val id: Int,
    val title: String = "",
    @SerialName("is_pinned") val pinned: Boolean = false,
    @SerialName("created_at") val createdAt: String = "",
)

/** A recent chat of any workspace, for the drawer */
data class RecentChat(val workspace: Workspace, val chat: ChatSummary)

@Serializable
data class Deadline(
    val key: String,
    val date: String,
    val kind: String = "deadline",
    val amount: String? = null,
    val sender: String? = null,
    val title: String? = null,
    val filename: String? = null,
    val text: String = "",
    val days: Int = 0,
    val state: String = "upcoming",          // overdue, today, soon, upcoming
    val done: Boolean = false,
    @SerialName("workspace_id") val workspaceId: Int? = null,
)

@Serializable
data class Deadlines(val today: String = "", val deadlines: List<Deadline> = emptyList())

@Serializable
data class RecentDocument(
    val id: Int,
    val filename: String = "",
    val workspace: String? = null,
    @SerialName("workspace_id") val workspaceId: Int? = null,
    val added: String? = null,
    /** what the PC read in the letter (dashboard.py, _describe_letter); none for a document that is not a letter */
    val sender: String? = null,
    @SerialName("letter_kind") val letterKind: String? = null,
    @SerialName("asked_amount") val askedAmount: String? = null,
)

@Serializable
data class Home(val today: String = "", val recent: List<RecentDocument> = emptyList())

@Serializable
data class InboxCount(@SerialName("new_count") val newCount: Int = 0)

@Serializable
data class ModelList(val models: List<String> = emptyList())

@Serializable
data class Transcription(val text: String = "")

@Serializable
data class BackupInfo(
    val enabled: Boolean = false,
    val running: Boolean = false,
    val lastSuccess: Long? = null,
    val nextDue: Long? = null,
    val lastError: BackupError? = null,
)

@Serializable
data class BackupError(val code: String = "failed", val at: Long? = null)

@Serializable
data class ProtectionInfo(val enabled: Boolean = false, val passphrase: Boolean = false)

/** GET /phone/v1/status: the desktop app's view of the PC (no paths, keys or file names) */
@Serializable
data class PcStatus(
    @SerialName("pc_name") val pcName: String = "",
    val version: String = "",
    val level: String = "work",
    val actions: List<String> = emptyList(),
    val backup: BackupInfo? = null,
    val protection: ProtectionInfo? = null,
    val offline: Boolean = false,
)

/** GET dashboard/system-status: the engine's view (models, Ollama) */
@Serializable
data class EngineStatus(
    val ollama: Part = Part(),
    @SerialName("text_model") val textModel: Part = Part(),
) {
    @Serializable
    data class Part(val status: String = "unknown", val name: String? = null, val version: String? = null)
}

@Serializable
data class ActionResult(val ok: Boolean = false, val action: String = "")

@Serializable
data class DoneRequest(val key: String, val done: Boolean)

@Serializable
data class UploadResult(val id: Int = 0, val filename: String = "", val status: String = "")

/**
 * The models the phone offers: not embedding models (they only turn text into numbers for the search and cannot answer),
 * and not Ollama's cloud models, which run on Ollama's servers: a question from the phone would leave the home (as on
 * the PC, backend/app/core/netguard.py is_cloud_model).
 */
fun isChatModel(name: String) = !name.contains("embed", ignoreCase = true) && !isCloudModel(name)

/** The same rule as is_cloud_model in backend/app/core/netguard.py: "gpt-oss:120b-cloud", "kimi-k2:1t-cloud", "x:cloud" */
fun isCloudModel(name: String): Boolean {
    val n = name.lowercase()
    return n.isNotEmpty() && (n.endsWith(":cloud") || n.endsWith("-cloud") || ":cloud" in n.substringAfterLast('/') || "-cloud" in n.substringAfterLast(':'))
}

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
    val model: String? = null,
    @SerialName("use_knowledge_base") val useKnowledgeBase: Boolean = false,
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
