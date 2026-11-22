package com.starkllm.app.data

import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Away from home (docs/phone-away.md): the phone reaches its PC through the StarkLLM relay. This is the plain
 * connection under the TLS of [Pinning]: a WebSocket to the relay, which passes the bytes to the PC. OkHttp does the
 * TLS handshake over it with the PC's own certificate, exactly as at home, so the relay only sees encrypted bytes.
 */
object Relay {
    /** the made-up host name of the relayed connection (never looked up: [dns] answers it) */
    const val HOST = "starkllm-relay.invalid"

    val dns = Dns { host ->
        if (host == HOST) listOf(InetAddress.getByAddress(HOST, byteArrayOf(192.toByte(), 0, 2, 1))) else Dns.SYSTEM.lookup(host)
    }

    /** only wss:// to a public name (a pairing code cannot send the phone to a device of the home network this way) */
    fun validUrl(url: String?): Boolean {
        if (url == null || !url.startsWith("wss://") || url.length > 200) return false
        val host = url.removePrefix("wss://").substringBefore('/').substringBefore(':')
        return host.contains('.') && !PairingInfo.isPrivateIpv4(host) && host.all { it.isLetterOrDigit() || it == '.' || it == '-' }
    }

    val ID = Regex("^[A-Za-z0-9_-]{22,64}$")
}

class RelaySocketFactory(private val relayUrl: String, private val id: String, private val ws: OkHttpClient) : SocketFactory() {
    override fun createSocket(): Socket = RelaySocket(relayUrl, id, ws)
    override fun createSocket(host: String?, port: Int): Socket = createSocket().also { it.connect(InetSocketAddress.createUnresolved(host, port)) }
    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = createSocket(host, port)
    override fun createSocket(host: InetAddress?, port: Int): Socket = createSocket().also { it.connect(InetSocketAddress(host, port)) }
    override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = createSocket(address, port)
}

/** the relay's answer when the PC is not there: off, not allowed away from home, or not running */
class RelayClosedException(val status: Int, message: String) : IOException(message)

private val EOF = ByteArray(0)

class RelaySocket(private val relayUrl: String, private val id: String, private val client: OkHttpClient) : Socket() {
    private val incoming = LinkedBlockingQueue<ByteArray>()
    private val ready = CountDownLatch(1)
    @Volatile private var ws: WebSocket? = null
    @Volatile private var failure: IOException? = null
    @Volatile private var connected = false
    @Volatile private var closed = false
    private var timeout = 0

    override fun connect(endpoint: SocketAddress?) = connect(endpoint, 0)

    override fun connect(endpoint: SocketAddress?, timeout: Int) {
        val request = Request.Builder().url("${relayUrl.trimEnd('/')}/v1/phone?id=$id").build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("\"ready\"")) ready.countDown()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (bytes.size > 0) incoming.put(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                end(null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end(null)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val status = response?.code ?: 0
                response?.close()
                end(if (status > 0) RelayClosedException(status, "relay $status") else IOException(t.message ?: "relay", t))
            }
        })
        val wait = if (timeout > 0) timeout.toLong() else 20_000L
        if (!ready.await(wait, TimeUnit.MILLISECONDS)) {
            ws?.cancel()
            throw failure ?: SocketTimeoutException("The relay did not connect the PC in time")
        }
        failure?.let { throw it }
        connected = true
    }

    private fun end(e: IOException?) {
        if (e != null && failure == null) failure = e
        ready.countDown()
        incoming.offer(EOF)
    }

    private val input = object : InputStream() {
        private var current: ByteArray? = null
        private var pos = 0

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            while (current == null || pos >= current!!.size) {
                val next = (if (timeout > 0) incoming.poll(timeout.toLong(), TimeUnit.MILLISECONDS) else incoming.take())
                    ?: throw SocketTimeoutException("Read timed out")
                if (next === EOF) { incoming.offer(EOF); return -1 }
                current = next
                pos = 0
            }
            val c = current!!
            val n = minOf(len, c.size - pos)
            System.arraycopy(c, pos, b, off, n)
            pos += n
            return n
        }

        override fun available(): Int = (current?.size ?: 0) - pos
    }

    private val output = object : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
        override fun write(b: ByteArray, off: Int, len: Int) {
            if (len == 0) return
            val socket = ws ?: throw IOException("not connected")
            if (closed || !socket.send(b.toByteString(off, len))) throw IOException("The relay connection is closed")
        }
    }

    override fun getInputStream(): InputStream = input
    override fun getOutputStream(): OutputStream = output
    override fun isConnected() = connected
    override fun isClosed() = closed
    override fun isInputShutdown() = closed
    override fun isOutputShutdown() = closed
    override fun getSoTimeout() = timeout
    override fun setSoTimeout(timeout: Int) { this.timeout = timeout }
    override fun getInetAddress(): InetAddress = InetAddress.getByAddress(Relay.HOST, byteArrayOf(192.toByte(), 0, 2, 1))
    override fun getPort() = 443
    override fun shutdownInput() {}
    override fun shutdownOutput() {}
    override fun setTcpNoDelay(on: Boolean) {}
    override fun setKeepAlive(on: Boolean) {}

    override fun close() {
        if (closed) return
        closed = true
        ws?.close(1000, null)
        incoming.offer(EOF)
    }
}
