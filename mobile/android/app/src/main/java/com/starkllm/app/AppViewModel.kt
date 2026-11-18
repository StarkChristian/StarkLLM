package com.starkllm.app

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.starkllm.app.data.AnswerSources
import com.starkllm.app.data.ApiException
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.ChatRequest
import com.starkllm.app.data.ChatSummary
import com.starkllm.app.data.Hello
import com.starkllm.app.data.Link
import com.starkllm.app.data.LinkStore
import com.starkllm.app.data.PairingInfo
import com.starkllm.app.data.Problem
import com.starkllm.app.data.StarkApi
import com.starkllm.app.data.Workspace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.Locale

sealed interface Screen {
    data object Pair : Screen
    data object Workspaces : Screen
    data class Chats(val workspace: Workspace) : Screen
    data class Chat(val workspace: Workspace, val chatId: Int?, val title: String) : Screen
    data object PairedPc : Screen
}

/** A problem to show; NOT_A_CODE is the phone's own (the camera saw another QR code). */
data class Notice(val problem: Problem?, val notACode: Boolean = false)

data class UiState(
    val screen: Screen = Screen.Pair,
    val link: Link? = null,
    val hello: Hello? = null,
    val scanned: PairingInfo? = null,
    val busy: Boolean = false,
    val notice: Notice? = null,
    val workspaces: List<Workspace>? = null,
    val chats: List<ChatSummary>? = null,
    val lines: List<ChatLine> = emptyList(),
    val answering: Boolean = false,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = LinkStore(app)
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state
    private var api: StarkApi? = null
    private var answer: Job? = null

    init {
        store.load()?.let { link ->
            connect(link)
            _state.update { it.copy(link = link, screen = Screen.Workspaces) }
            refreshWorkspaces()
        }
    }

    private fun connect(link: Link) {
        api = StarkApi(link, onAddressWorked = store::preferAddress)
    }

    private fun deviceName(): String =
        Settings.Global.getString(getApplication<Application>().contentResolver, "device_name")?.takeIf { it.isNotBlank() }
            ?: listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ")

    /** Runs a request; a removed pairing sends the user back to the pairing screen. */
    private fun request(block: suspend (StarkApi) -> Unit) {
        val a = api ?: return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, notice = null) }
            try {
                block(a)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.problem == Problem.UNPAIRED || e.problem == Problem.WRONG_PC) forget()
                _state.update { it.copy(notice = Notice(e.problem)) }
            } catch (e: Exception) {
                _state.update { it.copy(notice = Notice(Problem.UNREACHABLE)) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    // ---- pairing

    fun scanned(text: String) {
        val info = PairingInfo.parse(text)
        _state.update { it.copy(scanned = info, notice = if (info == null) Notice(null, notACode = true) else null) }
    }

    fun cancelPairing() = _state.update { it.copy(scanned = null, notice = null) }

    fun confirmPairing() {
        val info = _state.value.scanned ?: return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, notice = null) }
            try {
                val r = StarkApi(info.addresses, info.port, info.fingerprint, token = null).pair(info.code, deviceName())
                val link = Link(r.pcName.ifBlank { info.pcName }, info.addresses, info.port, info.fingerprint, r.deviceId, r.token)
                store.save(link)
                connect(link)
                _state.update { it.copy(link = link, scanned = null, screen = Screen.Workspaces) }
                refreshWorkspaces()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(notice = Notice(e.problem), scanned = null) }
            } catch (e: Exception) {
                _state.update { it.copy(notice = Notice(Problem.UNREACHABLE), scanned = null) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private fun forget() {
        answer?.cancel()
        store.clear()
        api = null
        _state.update { UiState(notice = it.notice) }
    }

    fun unpair() = forget()

    // ---- workspaces and chats

    fun refreshWorkspaces() = request { a ->
        val hello = a.hello()
        _state.update { it.copy(hello = hello) }
        if (!hello.signedIn) {
            _state.update { it.copy(notice = Notice(Problem.NOT_SIGNED_IN)) }
            return@request
        }
        val list = a.workspaces()
        _state.update { it.copy(workspaces = list) }
    }

    fun openWorkspace(ws: Workspace) {
        _state.update { it.copy(screen = Screen.Chats(ws), chats = null) }
        refreshChats(ws)
    }

    fun refreshChats(ws: Workspace) = request { a ->
        val list = a.chats(ws.id)
        _state.update { it.copy(chats = list) }
    }

    fun openChat(ws: Workspace, chat: ChatSummary) {
        _state.update { it.copy(screen = Screen.Chat(ws, chat.id, chat.title), lines = emptyList()) }
        request { a -> loadChat(a, chat.id) }
    }

    fun newChat(ws: Workspace) = _state.update { it.copy(screen = Screen.Chat(ws, null, ""), lines = emptyList()) }

    fun deleteChat(ws: Workspace, chat: ChatSummary) = request { a ->
        a.deleteChat(chat.id)
        _state.update { s -> s.copy(chats = s.chats?.filter { it.id != chat.id }) }
    }

    private suspend fun loadChat(a: StarkApi, chatId: Int) {
        val session = a.session(chatId)
        val lines = session.messages.filter { it.role == "user" || it.role == "assistant" }
            .map { ChatLine(it.role, it.content, AnswerSources.from(it.sources)) }
        _state.update { s ->
            val screen = s.screen
            if (screen is Screen.Chat && screen.chatId == chatId) s.copy(lines = lines, screen = screen.copy(title = session.title)) else s
        }
    }

    fun openPairedPc() = _state.update { it.copy(screen = Screen.PairedPc) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    // ---- asking

    fun ask(text: String) {
        val question = text.trim()
        val screen = _state.value.screen as? Screen.Chat ?: return
        val a = api ?: return
        if (question.isEmpty() || _state.value.answering) return
        _state.update {
            it.copy(answering = true, notice = null,
                lines = it.lines + ChatLine("user", question) + ChatLine("assistant", "", streaming = true))
        }
        answer = viewModelScope.launch {
            var chatId = screen.chatId
            try {
                chatId = a.ask(ChatRequest(screen.workspace.id, screen.chatId, question, language = Locale.getDefault().language)) { sofar ->
                    _state.update { s -> s.copy(lines = s.lines.dropLast(1) + ChatLine("assistant", sofar, streaming = true)) }
                }
                _state.update { s ->
                    val sc = s.screen
                    s.copy(screen = if (sc is Screen.Chat && sc.chatId == null) sc.copy(chatId = chatId) else sc)
                }
                // the source line and the quotation check are saved with the answer once it is complete
                runCatching { loadChat(a, chatId) }
                    .onFailure { _ -> _state.update { s -> s.copy(lines = s.lines.map { l -> l.copy(streaming = false) }) } }
            } catch (e: CancellationException) {
                _state.update { s -> s.copy(lines = s.lines.map { l -> l.copy(streaming = false) }) }
                throw e
            } catch (e: Exception) {
                val problem = (e as? ApiException)?.problem ?: Problem.UNREACHABLE
                if (problem == Problem.UNPAIRED || problem == Problem.WRONG_PC) forget()
                _state.update { s ->
                    val lines = if (s.lines.isEmpty()) s.lines else s.lines.dropLast(1) + s.lines.last().copy(streaming = false, failed = true)
                    s.copy(notice = Notice(problem), lines = lines)
                }
            } finally {
                _state.update { it.copy(answering = false) }
            }
        }
    }

    fun stop() {
        answer?.cancel()
    }

    // ---- back

    /** false: nothing to go back to (the system closes the app) */
    fun back(): Boolean {
        val s = _state.value
        when (val screen = s.screen) {
            is Screen.Chat -> {
                stop()
                _state.update { it.copy(screen = Screen.Chats(screen.workspace)) }
                refreshChats(screen.workspace)
            }
            is Screen.Chats, Screen.PairedPc -> _state.update { it.copy(screen = Screen.Workspaces) }
            Screen.Pair -> if (s.scanned != null) cancelPairing() else return false
            Screen.Workspaces -> return false
        }
        return true
    }
}
