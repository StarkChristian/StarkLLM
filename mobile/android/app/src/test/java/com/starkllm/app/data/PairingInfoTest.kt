package com.starkllm.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingInfoTest {
    private val fp = "Ab-_" + "x".repeat(39)
    private val code = "c0DE_-" + "z".repeat(16)

    // the link desktop/phonelink.js puts into the QR code (URLSearchParams: "," becomes %2C, " " becomes +)
    private fun link(a: String = "192.168.0.47%2C10.0.0.5", p: String = "47615", f: String = fp, c: String = code, v: String = "1", n: String = "GEEKOM+PC") =
        "starkllm://pair?v=$v&n=$n&a=$a&p=$p&f=$f&c=$c"

    @Test
    fun readsTheCodeOfThePc() {
        val info = PairingInfo.parse(link())!!
        assertEquals("GEEKOM PC", info.pcName)
        assertEquals(listOf("192.168.0.47", "10.0.0.5"), info.addresses)
        assertEquals(47615, info.port)
        assertEquals(fp, info.fingerprint)
        assertEquals(code, info.code)
    }

    @Test
    fun keepsOnlyHomeNetworkAddresses() {
        assertEquals(listOf("172.20.1.2"), PairingInfo.parse(link(a = "85.1.2.3%2C172.20.1.2%2C127.0.0.1%2Cexample.com"))!!.addresses)
        assertNull(PairingInfo.parse(link(a = "85.1.2.3")))
    }

    @Test
    fun refusesEverythingElse() {
        listOf(
            "https://www.starkllm.com/",
            "starkllm://other?v=1",
            "not a link at all",
            link(v = "2"),
            link(p = "0"),
            link(p = "70000"),
            link(f = "short"),
            link(c = "short"),
            link(c = "has spaces in it+++++++"),
            "starkllm://pair?v=1&a=192.168.0.47&p=47615&f=$fp",
        ).forEach { assertNull(it, PairingInfo.parse(it)) }
    }

    @Test
    fun privateIpv4() {
        listOf("10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.178.20").forEach { assertTrue(it, PairingInfo.isPrivateIpv4(it)) }
        listOf("172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.0.1", "192.168.0", "192.168.0.256", "192.168.0.01x", "::1", "").forEach {
            assertFalse(it, PairingInfo.isPrivateIpv4(it))
        }
    }

    @Test
    fun theNameOfThePcIsCleaned() {
        assertEquals("PC", PairingInfo.parse(link(n = ""))!!.pcName)
        assertEquals("ab", PairingInfo.parse(link(n = "a%07b"))!!.pcName)
        assertEquals(60, PairingInfo.parse(link(n = "x".repeat(100)))!!.pcName.length)
    }

    @Test
    fun theSourceLineNamesTheDocuments() {
        val sources = json.parseToJsonElement(
            """{"ws":["Effi Briest.pdf (Chunk 3)","books/Moby Dick.epub"],"kb":["Effi Briest.pdf (Chunk 12)"],"used":true,"unverified_quotes":["Call me Ishmael, said he."]}"""
        )
        val s = AnswerSources.from(sources)
        assertEquals(listOf("Effi Briest.pdf", "Moby Dick.epub"), s.documents)
        assertEquals(listOf("Call me Ishmael, said he."), s.unverifiedQuotes)
        assertEquals(AnswerSources.NONE, AnswerSources.from(null))
    }

    @org.junit.Test
    fun `the relay of a pairing code is taken only as wss to a public name`() {
        val base = "starkllm://pair?v=1&n=PC&a=192.168.0.47&p=47615&f=" + "A".repeat(43) + "&c=" + "B".repeat(22)
        val ok = PairingInfo.parse(base + "&r=wss%3A%2F%2Frelay.starkllm.com&i=" + "C".repeat(22))!!
        org.junit.Assert.assertEquals("wss://relay.starkllm.com", ok.relayUrl)
        org.junit.Assert.assertEquals("C".repeat(22), ok.relayId)
        org.junit.Assert.assertNull(PairingInfo.parse(base + "&r=ws%3A%2F%2Frelay.starkllm.com&i=" + "C".repeat(22))!!.relayUrl)
        org.junit.Assert.assertNull(PairingInfo.parse(base + "&r=wss%3A%2F%2F192.168.0.1&i=" + "C".repeat(22))!!.relayUrl)
        org.junit.Assert.assertNull(PairingInfo.parse(base + "&r=wss%3A%2F%2Frelay.starkllm.com")!!.relayUrl)
        org.junit.Assert.assertNull(PairingInfo.parse(base)!!.relayUrl)
    }
}
