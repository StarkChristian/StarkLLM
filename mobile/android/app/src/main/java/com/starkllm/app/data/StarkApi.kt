package com.starkllm.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InputStreamReader
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/** Why a request failed, in words the screens can show (strings.xml) */
enum class Problem { UNREACHABLE, WRONG_PC, CODE_CLOSED, WRONG_CODE, TOO_MANY_DEVICES, UNPAIRED, PC_OFFLINE, NOT_SIGNED_IN, SERVER }

class ApiException(val problem: Problem, val detail: String = "") : IOException("$problem $detail")

private val JSON_TYPE = "application/json".toMediaType()
const val DEVICE_HEADER = "X-StarkLLM-Device"

/**
 * StarkLLM on the paired PC, through its phone link (desktop/phonelink.js). Tries the PC's addresses in turn (the one
 * that answered last first), always over the pinned TLS connection.
 */
class StarkApi(
    private val addresses: List<String>,
    private val port: Int,
    fingerprint: String,
    private val token: String?,
    base: OkHttpClient = OkHttpClient(),
    private val onAddressWorked: (String) -> Unit = {},
) {
    private val client = Pinning.client(fingerprint, base)
    @Volatile private var current: String? = null

    constructor(link: Link, base: OkHttpClient = OkHttpClient(), onAddressWorked: (String) -> Unit = {}) :
        this(link.addresses, link.port, link.fingerprint, link.token, base, onAddressWorked)

    private fun url(address: String, path: String) = "https://$address:$port$path"

    private fun build(address: String, method: String, path: String, body: RequestBody?): Request =
        Request.Builder().url(url(address, path)).method(method, body).apply {
            if (token != null) header(DEVICE_HEADER, token)
            header("Accept", "application/json")
        }.build()

    /** Runs the request on the first address that answers. Throws ApiException. */
    private fun execute(method: String, path: String, body: RequestBody? = null, register: (Call) -> Unit = {}): Response {
        val order = listOfNotNull(current) + (addresses - setOfNotNull(current))
        var last: Exception? = null
        for (address in order) {
            val call = client.newCall(build(address, method, path, body))
            register(call)
            try {
                val res = call.execute()
                if (current != address) {
                    current = address
                    onAddressWorked(address)
                }
                return res
            } catch (e: SSLException) {
                // the certificate is not the pinned one: a device that is not the paired PC (or a PC with a new certificate)
                if (generateSequence<Throwable>(e) { it.cause }.any { it is CertificateException }) {
                    throw ApiException(Problem.WRONG_PC, e.message.orEmpty())
                }
                if (call.isCanceled()) throw e
                last = e                                // closed during the handshake: try the next address
            } catch (e: IOException) {
                if (call.isCanceled()) throw e
                last = e
            }
        }
        throw ApiException(Problem.UNREACHABLE, last?.message.orEmpty())
    }

    private fun check(res: Response): Response {
        if (res.isSuccessful) return res
        val text = runCatching { res.body.string() }.getOrDefault("")
        val code = runCatching { ((json.parseToJsonElement(text) as JsonObject)["error"] as JsonPrimitive).contentOrNull }.getOrNull()
        res.close()
        throw ApiException(
            when {
                code == "not-paired" -> Problem.UNPAIRED
                code == "offline" -> Problem.PC_OFFLINE
                code == "pairing-closed" -> Problem.CODE_CLOSED
                code == "wrong-code" -> Problem.WRONG_CODE
                code == "too-many-devices" -> Problem.TOO_MANY_DEVICES
                res.code == 401 -> Problem.NOT_SIGNED_IN
                else -> Problem.SERVER
            },
            "${res.code} ${code ?: text.take(200)}",
        )
    }

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        check(execute("GET", path)).use { json.decodeFromString(serializer, it.body.string()) }
    }

    private suspend fun <T> post(path: String, body: String, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        check(execute("POST", path, body.toRequestBody(JSON_TYPE))).use { json.decodeFromString(serializer, it.body.string()) }
    }

    suspend fun pair(code: String, deviceName: String): PairResponse =
        post("/phone/v1/pair", json.encodeToString(PairRequest.serializer(), PairRequest(code, deviceName)), PairResponse.serializer())

    suspend fun hello(): Hello = get("/phone/v1/hello", Hello.serializer())

    suspend fun workspaces(): List<Workspace> = get("/api/v1/workspaces/", ListSerializer(Workspace.serializer()))

    suspend fun chats(workspaceId: Int): List<ChatSummary> = get("/api/v1/chat/sessions/$workspaceId", ListSerializer(ChatSummary.serializer()))

    suspend fun session(chatId: Int): Session = get("/api/v1/chat/session/$chatId", Session.serializer())

    suspend fun newChat(workspaceId: Int): NewChat = post("/api/v1/chat/sessions/$workspaceId", "{}", NewChat.serializer())

    suspend fun deleteChat(chatId: Int) = withContext(Dispatchers.IO) {
        check(execute("DELETE", "/api/v1/chat/session/$chatId")).close()
    }

    /**
     * Sends a question and streams the answer: onText gets the whole answer so far after every piece. Returns the chat's
     * id (new chats get one from the PC). Cancelling the coroutine stops the answer.
     */
    suspend fun ask(request: ChatRequest, onText: (String) -> Unit): Int = withContext(Dispatchers.IO) {
        var call: Call? = null
        val body = json.encodeToString(ChatRequest.serializer(), request).toRequestBody(JSON_TYPE)
        // "Stop": the coroutine is cancelled; closing the call ends the blocking read below
        val stop = currentCoroutineContext()[Job]?.invokeOnCompletion { if (it != null) call?.cancel() }
        try {
            check(execute("POST", "/api/v1/chat/", body) { call = it }).use { res ->
                val chatId = res.header("X-Chat-ID")?.toIntOrNull() ?: request.chatId ?: 0
                val text = StringBuilder()
                InputStreamReader(res.body.byteStream(), Charsets.UTF_8).use { reader ->
                    val buf = CharArray(1024)
                    while (true) {
                        val n = reader.read(buf)
                        if (n < 0) break
                        text.appendRange(buf, 0, n)
                        onText(text.toString())
                    }
                }
                chatId
            }
        } catch (e: IOException) {
            currentCoroutineContext().ensureActive()     // stopped: a CancellationException, not an error
            throw e
        } finally {
            stop?.dispose()
        }
    }
}
