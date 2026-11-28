package com.starkllm.app

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.starkllm.app.data.AnswerSources
import com.starkllm.app.data.ApiException
import com.starkllm.app.data.AppPrefs
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.ChatRequest
import com.starkllm.app.data.ChatSummary
import com.starkllm.app.data.Deadline
import com.starkllm.app.data.EngineStatus
import com.starkllm.app.data.Hello
import com.starkllm.app.data.Home
import com.starkllm.app.data.Link
import com.starkllm.app.data.LinkStore
import com.starkllm.app.data.PairingInfo
import com.starkllm.app.data.PcStatus
import com.starkllm.app.data.Problem
import com.starkllm.app.data.QuestionQueue
import com.starkllm.app.data.QueuedQuestion
import com.starkllm.app.data.RecentChat
import com.starkllm.app.data.SharedFiles
import com.starkllm.app.data.StarkApi
import com.starkllm.app.data.Workspace
import com.starkllm.app.data.openDeadlines
import com.starkllm.app.reminders.Reminders
import com.starkllm.app.widget.DeadlinesWidget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.RequestBody
import java.util.Locale
import java.util.UUID

sealed interface Screen {
    data object Pair : Screen
    data object Home : Screen
    data object Workspaces : Screen
    data class Chats(val workspace: Workspace) : Screen
    // nonce: this opening of the chat; an answer that is still coming in belongs to it
    data class Chat(val workspace: Workspace, val chatId: Int?, val title: String, val from: Screen, val nonce: Long = System.nanoTime()) : Screen
    data object Deadlines : Screen
    data object ThisPc : Screen
    data object Settings : Screen
    data object Guide : Screen
}

/** A problem to show; notACode is the phone's own (the camera saw another QR code). */
data class Notice(val problem: Problem?, val notACode: Boolean = false)

/** A waiting question the PC has answered meanwhile: the home screen offers to open its chat */
data class Answered(val id: String, val workspace: Workspace, val chatId: Int, val question: String)

/** A short confirmation (not an error): the text and its one argument */
data class Info(@StringRes val text: Int, val arg: String = "")

data class UiState(
    val screen: Screen = Screen.Pair,
    val links: List<Link> = emptyList(),
    val link: Link? = null,
    val hello: Hello? = null,
    val scanned: PairingInfo? = null,
    val busy: Boolean = false,
    val notice: Notice? = null,
    val info: Info? = null,
    val workspaces: List<Workspace>? = null,
    val chats: List<ChatSummary>? = null,
    val recent: List<RecentChat> = emptyList(),
    val lines: List<ChatLine> = emptyList(),
    /** the chat (Screen.Chat.nonce) whose answer is coming in; it goes on when the user leaves that chat */
    val answeringFor: Long? = null,
    val home: Home? = null,
    val inboxCount: Int? = null,
    val deadlines: List<Deadline>? = null,
    val models: List<String> = emptyList(),
    val model: String? = null,
    val workspaceId: Int = 0,
    val useKnowledgeBase: Boolean = false,
    val pc: PcStatus? = null,
    val engine: EngineStatus? = null,
    val actionRunning: String? = null,
    val uploading: Boolean = false,
    val transcribing: Boolean = false,
    /** dictated text waiting to go into the input field (taken once) */
    val dictated: String? = null,
    /** text shared from another app, waiting for the home screen's question field (taken once) */
    val draft: String? = null,
    val appLock: Boolean = false,
    val reminders: Boolean = false,
    /** the look (ui/Themes.kt), as on the PC; "system" follows the phone's dark or light mode */
    val theme: String = "system",
    val introSeen: Boolean = true,
    /** questions asked while the PC could not be reached, of this PC, oldest first (QuestionQueue) */
    val queue: List<QueuedQuestion> = emptyList(),
    /** the waiting question that is being sent right now */
    val queueSending: String? = null,
    /** waiting questions the PC answered since the app was opened */
    val answered: List<Answered> = emptyList(),
) {
    val level: String get() = hello?.level ?: "work"
    val answering: Boolean get() = answeringFor != null && (screen as? Screen.Chat)?.nonce == answeringFor
    val canSend: Boolean get() = level == "work" || level == "manage"
    val canManage: Boolean get() = level == "manage"
    val workspace: Workspace? get() = workspaces?.firstOrNull { it.id == workspaceId } ?: workspaces?.firstOrNull()
}

private const val RETRY_MS = 30_000L

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = LinkStore(app)
    private val prefs = AppPrefs(app)
    private val questions = QuestionQueue.of(app)
    private var flushing: Job? = null
    private var retry: Job? = null
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state
    private var api: StarkApi? = null
    private var answer: Job? = null
    private var loads = 0

    init {
        _state.update {
            it.copy(appLock = prefs.appLock, reminders = prefs.reminders, model = prefs.model, workspaceId = prefs.workspaceId,
                theme = prefs.theme, introSeen = prefs.introSeen,
                useKnowledgeBase = prefs.useKnowledgeBase)
        }
        store.current()?.let { link ->
            connect(link)
            _state.update { it.copy(link = link, links = store.all(), screen = Screen.Home, queue = questions.forPc(link.id)) }
            refreshAll()
            if (_state.value.queue.isNotEmpty()) waitForPc()
        }
    }

    private fun connect(link: Link) {
        api = StarkApi(link, onAddressWorked = { store.preferAddress(link.id, it) }, onRouteChanged = { away ->
            // the top bar says "away" from the way the last answer really came, not only from the hello at the start
            _state.update { s -> s.hello?.takeIf { it.viaRelay != away }?.let { s.copy(hello = it.copy(viaRelay = away)) } ?: s }
        })
    }

    private fun deviceName(): String =
        Settings.Global.getString(getApplication<Application>().contentResolver, "device_name")?.takeIf { it.isNotBlank() }
            ?: listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ")

    private fun failed(e: Exception) {
        android.util.Log.w("StarkLLM", "request failed", e)   // only the phone's own log (logcat); no network
        val problem = (e as? ApiException)?.problem ?: Problem.UNREACHABLE
        // only the paired PC's own "not-paired" removes the pairing; another device at its address (WRONG_PC) does not
        if (problem.removesPairing) forgetCurrent()
        val unreachable = problem == Problem.UNREACHABLE || problem == Problem.UNREACHABLE_AWAY || problem == Problem.WRONG_PC
        _state.update { it.copy(notice = Notice(problem), hello = if (unreachable) null else it.hello) }
    }

    /** Runs a request; a removed pairing sends the user back to the pairing screen. */
    private fun request(block: suspend (StarkApi) -> Unit) {
        val a = api ?: return
        viewModelScope.launch {
            loads++
            _state.update { it.copy(busy = true, notice = null) }
            try {
                block(a)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e)
            } finally {
                loads--
                if (loads == 0) _state.update { it.copy(busy = false) }
            }
        }
    }

    // ---- pairing and PCs

    fun scanned(text: String) {
        val info = PairingInfo.parse(text)
        _state.update { it.copy(scanned = info, notice = if (info == null) Notice(null, notACode = true) else null) }
    }

    fun cancelPairing() = _state.update {
        it.copy(scanned = null, notice = null, screen = if (it.link != null && it.screen == Screen.Pair) Screen.Home else it.screen)
    }

    fun confirmPairing() {
        val info = _state.value.scanned ?: return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, notice = null) }
            try {
                val earlier = store.all().firstOrNull { it.fingerprint == info.fingerprint }
                val r = StarkApi(info.addresses, info.port, info.fingerprint, token = null).pair(info.code, deviceName(), earlier)
                val link = Link(r.pcName.ifBlank { info.pcName }, info.addresses, info.port, info.fingerprint, r.deviceId, r.token, info.relayUrl, info.relayId)
                store.save(link)
                switchTo(link)
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

    private fun switchTo(link: Link) {
        answer?.cancel()
        connect(link)
        _state.update {
            UiState(link = link, links = store.all(), screen = Screen.Home, appLock = it.appLock, reminders = it.reminders, theme = it.theme,
                model = null, workspaceId = 0, useKnowledgeBase = it.useKnowledgeBase, queue = questions.forPc(link.id))
        }
        flushing?.cancel()
        retry?.cancel()
        prefs.model = null
        prefs.workspaceId = 0
        refreshAll()
        if (_state.value.queue.isNotEmpty()) waitForPc()
    }

    fun addPc() = _state.update { it.copy(screen = Screen.Pair, scanned = null, notice = null) }

    fun switchPc(id: String) {
        val link = store.all().firstOrNull { it.id == id } ?: return
        store.select(id)
        switchTo(link)
    }

    private fun forgetCurrent() {
        val id = _state.value.link?.id ?: return
        removePc(id)
    }

    fun removePc(id: String) {
        answer?.cancel()
        store.remove(id)
        questions.removePc(id)
        val next = store.current()
        if (next != null) {
            store.select(next.id)
            switchTo(next)
        } else {
            api = null
            _state.update { UiState(notice = it.notice, appLock = it.appLock, reminders = it.reminders, theme = it.theme) }
        }
    }

    // ---- loading

    fun refreshAll() = request { a ->
        val hello = a.hello()
        _state.update { it.copy(hello = hello) }
        if (!hello.signedIn) {
            _state.update { it.copy(notice = Notice(Problem.NOT_SIGNED_IN)) }
            return@request
        }
        val list = a.workspaces()
        _state.update { it.copy(workspaces = list) }
        sendWaiting()
        viewModelScope.launch { runCatching { loadDashboard(a) } }
        viewModelScope.launch { runCatching { _state.update { it.copy(models = a.models()) } } }
        loadRecent(a, list)
    }

    private suspend fun loadDashboard(a: StarkApi) {
        val home = runCatching { a.home() }.getOrNull()
        val count = runCatching { a.inboxCount() }.getOrNull()
        val deadlines = runCatching { a.deadlines() }.getOrNull()
        _state.update { it.copy(home = home ?: it.home, inboxCount = count ?: it.inboxCount, deadlines = deadlines?.deadlines ?: it.deadlines) }
        if (deadlines != null) {
            prefs.cachedDeadlines = openDeadlines(deadlines.deadlines)
            DeadlinesWidget.update(getApplication())
        }
    }

    /** the newest chats of all workspaces (at most 8 workspaces are asked) */
    private suspend fun loadRecent(a: StarkApi, workspaces: List<Workspace>) {
        val lists = coroutineScope {
            workspaces.take(8).map { ws -> async { runCatching { a.chats(ws.id).map { RecentChat(ws, it) } }.getOrDefault(emptyList()) } }.awaitAll()
        }
        val recent = lists.flatten().sortedByDescending { it.chat.createdAt }.take(8)
        _state.update { it.copy(recent = recent) }
    }

    // ---- navigation

    fun go(screen: Screen) {
        _state.update { it.copy(screen = screen, notice = null) }
        when (screen) {
            Screen.Deadlines -> request { a -> loadDashboard(a) }
            Screen.ThisPc -> refreshPc()
            Screen.Workspaces, Screen.Home -> if (_state.value.workspaces == null) refreshAll()
            else -> Unit
        }
    }

    fun openWorkspace(ws: Workspace) {
        _state.update { it.copy(screen = Screen.Chats(ws), chats = null) }
        refreshChats(ws)
    }

    fun refreshChats(ws: Workspace) = request { a -> _state.update { it.copy(chats = a.chats(ws.id)) } }

    fun openChat(ws: Workspace, chat: ChatSummary) {
        val from = _state.value.screen.let { if (it is Screen.Chat) it.from else it }
        _state.update { it.copy(screen = Screen.Chat(ws, chat.id, chat.title, from), lines = emptyList()) }
        request { a -> loadChat(a, chat.id) }
    }

    fun newChat(ws: Workspace) = _state.update {
        it.copy(screen = Screen.Chat(ws, null, "", it.screen.let { s -> if (s is Screen.Chat) s.from else s }), lines = emptyList())
    }

    fun deleteChat(ws: Workspace, chat: ChatSummary) = request { a ->
        a.deleteChat(chat.id)
        _state.update { s -> s.copy(chats = s.chats?.filter { it.id != chat.id }, recent = s.recent.filter { it.chat.id != chat.id }) }
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

    fun dismissNotice() = _state.update { it.copy(notice = null) }
    fun dismissInfo() = _state.update { it.copy(info = null) }

    // ---- choices for asking

    fun setWorkspace(id: Int) {
        prefs.workspaceId = id
        _state.update { it.copy(workspaceId = id) }
    }

    fun setModel(name: String?) {
        prefs.model = name
        _state.update { it.copy(model = name) }
    }

    fun setKnowledgeBase(on: Boolean) {
        prefs.useKnowledgeBase = on
        _state.update { it.copy(useKnowledgeBase = on) }
    }

    // ---- asking

    /**
     * From the home screen: a new chat in the chosen workspace. false: the question was not sent (another answer is
     * still coming in, no PC, no workspace); the screen stays and the field keeps the text.
     */
    fun askNew(text: String): Boolean {
        val ws = _state.value.workspace ?: return false
        if (!mayAsk(text)) return false
        _state.update { it.copy(screen = Screen.Chat(ws, null, "", Screen.Home), lines = emptyList()) }
        return ask(text)
    }

    private fun mayAsk(text: String): Boolean {
        if (text.isBlank() || api == null) return false
        if (_state.value.answeringFor != null) {
            _state.update { it.copy(info = Info(R.string.answer_running)) }
            return false
        }
        return true
    }

    /** false: the question was not sent, and the field keeps it */
    fun ask(text: String): Boolean {
        val question = text.trim()
        val screen = _state.value.screen as? Screen.Chat ?: return false
        val a = api ?: return false
        if (!mayAsk(question)) return false
        val s0 = _state.value
        val nonce = screen.nonce
        // changes of the chat on the screen, only while it is still the chat of this answer
        fun here(change: (UiState) -> UiState) = _state.update { s -> if ((s.screen as? Screen.Chat)?.nonce == nonce) change(s) else s }
        _state.update {
            it.copy(answeringFor = nonce, notice = null,
                lines = it.lines + ChatLine("user", question) + ChatLine("assistant", "", streaming = true))
        }
        AnswerService.start(getApplication())
        // the PC answered at all: a failure after this is a cut-off answer, not a question to keep for later
        var reached = false
        val request = ChatRequest(screen.workspace.id, screen.chatId, question, language = Locale.getDefault().language,
            model = s0.model?.takeIf { it in s0.models }, useKnowledgeBase = s0.useKnowledgeBase)
        answer = viewModelScope.launch {
            try {
                val chatId = a.ask(request, onChat = { id ->
                    reached = true
                    here { s -> s.copy(screen = (s.screen as Screen.Chat).let { sc -> if (sc.chatId == null) sc.copy(chatId = id) else sc }) }
                }) { sofar ->
                    reached = true
                    here { s -> s.copy(lines = s.lines.dropLast(1) + ChatLine("assistant", sofar, streaming = true)) }
                }
                // the source line and the quotation check are saved with the answer once it is complete
                if ((_state.value.screen as? Screen.Chat)?.nonce == nonce) {
                    runCatching { loadChat(a, chatId) }
                        .onFailure { here { s -> s.copy(lines = s.lines.map { l -> l.copy(streaming = false) }) } }
                }
                runCatching { _state.value.workspaces?.let { loadRecent(a, it) } }
            } catch (e: CancellationException) {
                here { s -> s.copy(lines = s.lines.map { l -> l.copy(streaming = false) }) }
                throw e
            } catch (e: Exception) {
                if (!reached && keepsForLater(e) && keep(screen, request)) {
                    // the question waits on the phone; the chat shows what it showed before it was asked
                    here { s ->
                        val lines = s.lines.dropLast(2)
                        if (screen.chatId == null && lines.isEmpty()) s.copy(lines = lines, screen = screen.from) else s.copy(lines = lines)
                    }
                    _state.update { it.copy(hello = null, info = Info(R.string.queue_saved)) }
                    waitForPc()
                } else {
                    failed(e)
                    here { s ->
                        val lines = if (s.lines.isEmpty()) s.lines else s.lines.dropLast(1) + s.lines.last().copy(streaming = false, failed = true)
                        s.copy(lines = lines)
                    }
                }
            } finally {
                _state.update { it.copy(answeringFor = null) }
                AnswerService.stop(getApplication())
            }
        }
        return true
    }

    fun stop() {
        answer?.cancel()
    }

    // ---- questions that wait for the PC

    /** the PC could not be reached at all (not: it refused, or another device answered at its address) */
    private fun keepsForLater(e: Exception): Boolean =
        (e as? ApiException)?.problem in setOf(Problem.UNREACHABLE, Problem.UNREACHABLE_AWAY, Problem.PC_OFFLINE)

    /** false: there is no PC, or the queue is full (the question is then shown as cut off, as before) */
    private fun keep(screen: Screen.Chat, request: ChatRequest): Boolean {
        val link = _state.value.link ?: return false
        val q = QueuedQuestion(
            id = UUID.randomUUID().toString(), pcId = link.id, workspaceId = request.workspaceId, workspaceName = screen.workspace.name,
            chatId = request.chatId, text = request.message, model = request.model, useKnowledgeBase = request.useKnowledgeBase,
            language = request.language, askedAt = System.currentTimeMillis(),
        )
        if (!questions.add(q)) return false
        _state.update { it.copy(queue = questions.forPc(link.id)) }
        return true
    }

    fun cancelQueued(id: String) {
        if (_state.value.queueSending == id) return      // on its way already: the answer comes as usual
        questions.remove(id)
        _state.update { s -> s.copy(queue = s.link?.let { questions.forPc(it.id) }.orEmpty()) }
    }

    fun openAnswered(a: Answered) {
        _state.update { s -> s.copy(answered = s.answered.filter { it.id != a.id }) }
        openChat(a.workspace, ChatSummary(a.chatId, a.question))
    }

    fun dismissAnswered(id: String) = _state.update { s -> s.copy(answered = s.answered.filter { it.id != id }) }

    /**
     * While questions wait and the app is open: asks the PC every half minute whether it can be reached again (only the
     * small hello, to the paired PC); then everything is read again and the questions are sent.
     */
    private fun waitForPc() {
        if (retry?.isActive == true) return
        retry = viewModelScope.launch {
            while (isActive && _state.value.queue.any { !it.failed }) {
                delay(RETRY_MS)
                if (_state.value.hello != null) {
                    sendWaiting()
                    continue
                }
                val a = api ?: break
                val hello = runCatching { a.hello() }.getOrNull() ?: continue
                _state.update { it.copy(hello = hello, notice = null) }
                refreshAll()
            }
        }
    }

    /** Sends the waiting questions of this PC, one after the other; stops when the PC cannot be reached again */
    private fun sendWaiting() {
        val link = _state.value.link ?: return
        if (flushing?.isActive == true) return
        if (questions.forPc(link.id).none { !it.failed }) return
        flushing = viewModelScope.launch {
            for (q in questions.forPc(link.id).filter { !it.failed }) {
                val a = api ?: break
                if (_state.value.link?.id != q.pcId) break
                // one answer at a time: the PC's model is busy while another answer is coming in
                while (_state.value.answeringFor != null) delay(1_000)
                // cancelled meanwhile (the list above is the one from the start)
                if (questions.all().none { it.id == q.id }) continue
                _state.update { it.copy(queueSending = q.id) }
                try {
                    val request = ChatRequest(q.workspaceId, q.chatId, q.text, language = q.language, model = q.model,
                        useKnowledgeBase = q.useKnowledgeBase)
                    val chatId = a.ask(request) { }
                    questions.remove(q.id)
                    val ws = _state.value.workspaces?.firstOrNull { it.id == q.workspaceId } ?: Workspace(q.workspaceId, q.workspaceName)
                    _state.update { s ->
                        s.copy(queue = questions.forPc(link.id), answered = s.answered + Answered(q.id, ws, chatId, q.text))
                    }
                    // the chat that is open on the screen shows the answer at once
                    val open = _state.value.screen as? Screen.Chat
                    if (open != null && open.chatId == chatId && _state.value.answeringFor == null) runCatching { loadChat(a, chatId) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (keepsForLater(e)) {
                        _state.update { it.copy(hello = null) }
                        waitForPc()
                        break
                    }
                    questions.markFailed(q.id)
                    _state.update { it.copy(queue = questions.forPc(link.id)) }
                } finally {
                    _state.update { it.copy(queueSending = null) }
                }
            }
            runCatching { _state.value.workspaces?.let { loadRecent(a = api ?: return@runCatching, workspaces = it) } }
        }
    }

    // ---- sending documents and photos

    /** onDone: after the upload, sent or not (a photo taken for it is deleted then) */
    fun upload(ws: Workspace, fileName: String, body: RequestBody, onDone: () -> Unit = {}) {
        val a = api ?: return onDone()
        viewModelScope.launch {
            _state.update { it.copy(uploading = true, notice = null, info = null) }
            try {
                a.upload(ws.id, fileName, body)
                _state.update { it.copy(info = Info(R.string.uploaded, ws.name)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e)
            } finally {
                _state.update { it.copy(uploading = false) }
                onDone()
            }
        }
    }

    // ---- dictation

    fun transcribe(audio: ByteArray, fileName: String, mime: String) {
        val a = api ?: return
        viewModelScope.launch {
            _state.update { it.copy(transcribing = true, notice = null) }
            try {
                val text = a.transcribe(audio, fileName, mime, Locale.getDefault().language)
                if (text.isBlank()) _state.update { it.copy(info = Info(R.string.dictation_empty)) }
                else _state.update { it.copy(dictated = text) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e)
            } finally {
                _state.update { it.copy(transcribing = false) }
            }
        }
    }

    fun dictationTaken() = _state.update { it.copy(dictated = null) }

    // ---- shared from another app

    /** Text shared to StarkLLM: the home screen's field gets it, for a question about it (nothing is sent yet) */
    fun sharedText(text: String) {
        if (_state.value.link == null) {
            _state.update { it.copy(info = Info(R.string.share_not_paired)) }
            return
        }
        go(Screen.Home)
        _state.update { it.copy(draft = text.take(SharedFiles.MAX_TEXT)) }
    }

    fun draftTaken() = _state.update { it.copy(draft = null) }

    fun refuseShared() = _state.update { it.copy(info = Info(R.string.share_refused)) }

    // ---- deadlines

    // the card moves only after the PC agreed (moving it first and back left a refused one above the visible list)
    fun setDone(d: Deadline, done: Boolean) = request { a ->
        try {
            a.setDeadlineDone(d.key, done)
        } catch (e: Exception) {
            runCatching { loadDashboard(a) }        // the PC is the authority
            throw e
        }
        _state.update { s -> s.copy(deadlines = s.deadlines?.map { if (it.key == d.key) it.copy(done = done) else it }) }
        prefs.cachedDeadlines = openDeadlines(_state.value.deadlines.orEmpty())
        DeadlinesWidget.update(getApplication())
    }

    // ---- this PC

    fun refreshPc() = request { a ->
        // a PC with the first phone link (StarkLLM before the levels) has no status page: the screen shows what it knows
        val pc = try {
            a.pcStatus()
        } catch (e: ApiException) {
            if (e.problem != Problem.SERVER) throw e
            null
        }
        if (pc != null) _state.update { it.copy(pc = pc, hello = it.hello?.copy(level = pc.level)) }
        runCatching { a.engineStatus() }.getOrNull()?.let { e -> _state.update { it.copy(engine = e) } }
    }

    /** runs after the fingerprint was confirmed on the phone (ThisPcScreen) */
    fun runAction(name: String) {
        val a = api ?: return
        viewModelScope.launch {
            _state.update { it.copy(actionRunning = name, notice = null, info = null) }
            try {
                val r = a.action(name)
                _state.update {
                    it.copy(info = Info(if (name == "go-offline") R.string.action_offline_done else if (r.ok) R.string.action_backup_done else R.string.action_backup_failed))
                }
                if (name != "go-offline") runCatching { _state.update { it.copy(pc = a.pcStatus()) } }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e)
            } finally {
                _state.update { it.copy(actionRunning = null) }
            }
        }
    }

    // ---- settings of the phone

    fun setAppLock(on: Boolean) {
        prefs.appLock = on
        _state.update { it.copy(appLock = on) }
        DeadlinesWidget.update(getApplication())      // the widget shows only a count while the lock is on
    }

    fun setTheme(id: String) {
        prefs.theme = id
        _state.update { it.copy(theme = id) }
    }

    fun introDone() {
        prefs.introSeen = true
        _state.update { it.copy(introSeen = true) }
    }

    fun setReminders(on: Boolean) {
        prefs.reminders = on
        _state.update { it.copy(reminders = on) }
        if (on) Reminders.schedule(getApplication()) else Reminders.cancel(getApplication())
    }

    // ---- back

    /** false: nothing to go back to (the system closes the app) */
    fun back(): Boolean {
        val s = _state.value
        when (val screen = s.screen) {
            // the answer goes on (as in the PC's app): the chat shows it when it is opened again
            is Screen.Chat -> {
                when (val from = screen.from) {
                    is Screen.Chats -> {
                        _state.update { it.copy(screen = from) }
                        refreshChats(from.workspace)
                    }
                    else -> _state.update { it.copy(screen = from) }
                }
            }
            is Screen.Chats -> _state.update { it.copy(screen = Screen.Workspaces) }
            Screen.Workspaces, Screen.Deadlines, Screen.ThisPc, Screen.Settings, Screen.Guide -> _state.update { it.copy(screen = Screen.Home) }
            Screen.Pair -> when {
                s.scanned != null -> cancelPairing()
                s.link != null -> _state.update { it.copy(screen = Screen.Home) }
                else -> return false
            }
            Screen.Home -> return false
        }
        return true
    }
}
