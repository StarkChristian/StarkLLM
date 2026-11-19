package com.starkllm.app.data

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InputStreamReader
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/**
 * Why a request failed, in words the screens can show (strings.xml). removesPairing: the phone forgets the PC. Only the
 * paired PC itself can say that, over the pinned connection with the phone's token ("not-paired"); a device with
 * another certificate (WRONG_PC) cannot, or anyone in the Wi-Fi could unpair the phone.
 */
enum class Problem(val removesPairing: Boolean = false) {
    UNREACHABLE, WRONG_PC, CODE_CLOSED, WRONG_CODE, TOO_MANY_DEVICES, UNPAIRED(removesPairing = true), PC_OFFLINE, NOT_SIGNED_IN, NOT_ALLOWED, SERVER
}

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

    /**
     * Runs the request on the first address that answers with the pinned certificate. Throws ApiException: WRONG_PC when
     * only devices with another certificate answered (none of the PC's addresses is the paired PC now), else UNREACHABLE.
     */
    private fun execute(method: String, path: String, body: RequestBody? = null, register: (Call) -> Unit = {}): Response {
        val order = listOfNotNull(current) + (addresses - setOfNotNull(current))
        var last: Exception? = null
        var otherDevice: SSLException? = null
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
                if (call.isCanceled()) throw e
                // the certificate is not the pinned one: another device has this address now (another network, a
                // router that gave the address away); nothing was sent to it. The PC may still be at its other address.
                if (isPinMismatch(e)) otherDevice = e else last = e      // or closed during the handshake
            } catch (e: IOException) {
                if (call.isCanceled()) throw e
                last = e
                // a read once more on the same address (a connection closed by the PC in between); never a question
                if (method == "GET") {
                    val again = client.newCall(build(address, method, path, body))
                    register(again)
                    try {
                        val res = again.execute()
                        current = address
                        return res
                    } catch (e2: IOException) {
                        if (again.isCanceled()) throw e2
                        last = e2
                    }
                }
            }
        }
        if (otherDevice != null) throw ApiException(Problem.WRONG_PC, otherDevice.message.orEmpty())
        throw ApiException(Problem.UNREACHABLE, last?.message.orEmpty())
    }

    private fun isPinMismatch(e: SSLException) = generateSequence<Throwable>(e) { it.cause }.any { it is CertificateException }

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
                code == "not-allowed" -> Problem.NOT_ALLOWED
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

    suspend fun models(): List<String> = get("/api/v1/chat/models", ModelList.serializer()).models.filter(::isChatModel)

    suspend fun deadlines(): Deadlines = get("/api/v1/dashboard/deadlines", Deadlines.serializer())

    suspend fun setDeadlineDone(key: String, done: Boolean) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DoneRequest.serializer(), DoneRequest(key, done)).toRequestBody(JSON_TYPE)
        check(execute("PUT", "/api/v1/dashboard/deadlines/done", body)).close()
    }

    suspend fun home(): Home = get("/api/v1/dashboard/home", Home.serializer())

    suspend fun inboxCount(): Int = get("/api/v1/dashboard/inbox/count", InboxCount.serializer()).newCount

    suspend fun engineStatus(): EngineStatus = get("/api/v1/dashboard/system-status", EngineStatus.serializer())

    suspend fun pcStatus(): PcStatus = get("/phone/v1/status", PcStatus.serializer())

    suspend fun action(name: String): ActionResult = post("/phone/v1/actions/$name", "{}", ActionResult.serializer())

    /** A photo or document into a workspace; the PC reads it (OCR for photos) like any other upload. */
    suspend fun upload(workspaceId: Int, fileName: String, file: RequestBody): UploadResult = withContext(Dispatchers.IO) {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", fileName, file).build()
        check(execute("POST", "/api/v1/documents/$workspaceId/upload", form)).use { json.decodeFromString(UploadResult.serializer(), it.body.string()) }
    }

    /** Dictation: the recording is turned into text by the speech model on the PC, not by an online service. */
    suspend fun transcribe(audio: ByteArray, fileName: String, mime: String, language: String?): String = withContext(Dispatchers.IO) {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, audio.toRequestBody(mime.toMediaType()))
            .apply { if (language != null) addFormDataPart("language", language) }
            .build()
        check(execute("POST", "/api/v1/voice/transcribe", form)).use { json.decodeFromString(Transcription.serializer(), it.body.string()).text.trim() }
    }

    /**
     * Sends a question and streams the answer: onText gets the whole answer so far after every piece. Returns the chat's
     * id (new chats get one from the PC). Cancelling the coroutine stops the answer.
     */
    suspend fun ask(request: ChatRequest, onChat: (Int) -> Unit = {}, onText: (String) -> Unit): Int = coroutineScope {
        val calls = Calls()
        // "Stop": the coroutine is cancelled, but a thread blocked in a read does not notice that (and a completion
        // handler of the job runs only after the read ended). This watcher is cancelled with it at once and closes the
        // connection, which ends the read with an IOException.
        val watcher = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                calls.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) {
                val body = json.encodeToString(ChatRequest.serializer(), request).toRequestBody(JSON_TYPE)
                try {
                    check(execute("POST", "/api/v1/chat/", body, calls::add)).use { res ->
                        val chatId = res.header("X-Chat-ID")?.toIntOrNull() ?: request.chatId ?: 0
                        onChat(chatId)
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
                }
            }
        } finally {
            calls.done()            // a complete answer: nothing left to close (a finished call is not touched)
            watcher.cancel()
        }
    }

    /** The calls of one answer, so that "Stop" can close them from another thread */
    internal class Calls {
        private val calls = mutableListOf<Call>()
        private var closed = false

        @Synchronized
        fun add(call: Call) {
            if (closed) call.cancel() else calls += call
        }

        @Synchronized
        fun cancel() {
            calls.forEach { it.cancel() }
            calls.clear()
            closed = true
        }

        @Synchronized
        fun done() {
            calls.clear()
        }
    }
}
