package com.starkllm.app.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetAddress

/** The phone's side of the phone link against a test server with its own self-signed certificate, like the PC. */
class PinnedApiTest {
    private val pcCertificate = HeldCertificate.Builder().commonName("StarkLLM phone link (test)").build()
    private val server = MockWebServer()
    private val pin = Pinning.fingerprintOf(pcCertificate.certificate)

    @Before
    fun start() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(pcCertificate).build().sslSocketFactory())
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    @After
    fun stop() = server.close()

    private fun api(token: String? = "TOKEN", addresses: List<String> = listOf("127.0.0.1"), fingerprint: String = pin) =
        StarkApi(addresses, server.port, fingerprint, token)

    private fun reply(body: String, code: Int = 200, vararg headers: Pair<String, String>) =
        server.enqueue(MockResponse.Builder().code(code).body(body).apply { headers.forEach { addHeader(it.first, it.second) } }.build())

    @Test
    fun thePairedPcIsReachedWithTheDeviceToken() = runBlocking {
        reply("""[{"id":3,"name":"Books","system_prompt":null,"created_at":"2026-11-18T20:00:00"}]""")
        assertEquals(listOf(Workspace(3, "Books")), api().workspaces())
        val r = server.takeRequest()
        assertEquals("TOKEN", r.headers[DEVICE_HEADER])
        assertEquals("/api/v1/workspaces/", r.url.encodedPath)
    }

    @Test
    fun anotherCertificateIsRefusedBeforeAnythingIsSent() = runBlocking {
        reply("[]")
        val other = Pinning.fingerprintOf(HeldCertificate.Builder().build().certificate)
        try {
            api(fingerprint = other).workspaces()
            fail("a device with another certificate was trusted")
        } catch (e: ApiException) {
            assertEquals(Problem.WRONG_PC, e.problem)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theAnswerStreamsAndTheChatGetsItsNumber() = runBlocking {
        reply("Effi marries Instetten. ".repeat(50), 200, "X-Chat-ID" to "42")
        val seen = mutableListOf<String>()
        val chatId = api().ask(ChatRequest(workspaceId = 3, message = "Whom does Effi marry?", language = "en")) { seen += it }
        assertEquals(42, chatId)
        assertEquals("Effi marries Instetten. ".repeat(50), seen.last())
        val r = server.takeRequest()
        assertEquals("POST", r.method)
        assertEquals("/api/v1/chat/", r.url.encodedPath)
    }

    @Test
    fun theProblemsOfThePcHaveNames() = runBlocking {
        val cases = listOf(
            Triple(401, """{"error":"not-paired"}""", Problem.UNPAIRED),
            Triple(503, """{"error":"offline"}""", Problem.PC_OFFLINE),
            Triple(410, """{"error":"pairing-closed"}""", Problem.CODE_CLOSED),
            Triple(401, """{"error":"wrong-code"}""", Problem.WRONG_CODE),
            Triple(409, """{"error":"too-many-devices"}""", Problem.TOO_MANY_DEVICES),
            Triple(401, """{"detail":"Could not validate credentials"}""", Problem.NOT_SIGNED_IN),
            Triple(500, "Internal Server Error", Problem.SERVER),
        )
        for ((code, body, problem) in cases) {
            reply(body, code)
            try {
                api().hello()
                fail("no error for $code $body")
            } catch (e: ApiException) {
                assertEquals(body, problem, e.problem)
            }
        }
    }

    @Test
    fun theNextAddressIsTriedWhenOneDoesNotAnswer() = runBlocking {
        reply("""{"pc_name":"GEEKOM","version":"2.4.0","device_id":"d1","signed_in":true}""")
        val worked = mutableListOf<String>()
        val api = StarkApi(listOf("127.0.0.2", "127.0.0.1"), server.port, pin, "TOKEN", onAddressWorked = { worked += it })
        val hello = api.hello()
        assertTrue(hello.signedIn)
        assertEquals("GEEKOM", hello.pcName)
        assertEquals(listOf("127.0.0.1"), worked)
    }

    @Test
    fun pairingSendsTheCodeWithoutAToken() = runBlocking {
        reply("""{"device_id":"d1","token":"T0K3N","pc_name":"GEEKOM","version":"2.4.0"}""")
        val r = api(token = null).pair("code-from-the-qr-code", "Galaxy Z Flip5")
        assertEquals("T0K3N", r.token)
        assertEquals(null, server.takeRequest().headers[DEVICE_HEADER])
    }
}
