package com.starkllm.app.data

import java.net.URI
import java.net.URLDecoder

/**
 * The content of the pairing QR code that StarkLLM on the PC shows (Settings > Phone, desktop/phonelink.js):
 * starkllm://pair?v=1&n=<PC name>&a=<addresses>&p=<port>&f=<certificate fingerprint>&c=<one-time code>
 */
data class PairingInfo(
    val pcName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val code: String,
) {
    companion object {
        private val FINGERPRINT = Regex("^[A-Za-z0-9_-]{43}$")   // SHA-256 in base64url
        private val CODE = Regex("^[A-Za-z0-9_-]{16,64}$")

        /** null when the text is not a StarkLLM pairing code (any other QR code the camera sees). */
        fun parse(text: String): PairingInfo? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (!uri.scheme.equals("starkllm", ignoreCase = true) || uri.host != "pair") return null
            val q = query(uri.rawQuery ?: return null)
            if (q["v"] != "1") return null
            // only addresses of a home network: a code cannot send the phone into the internet
            val addresses = q["a"].orEmpty().split(',').map { it.trim() }.filter { isPrivateIpv4(it) }.distinct()
            if (addresses.isEmpty()) return null
            val port = q["p"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val fingerprint = q["f"]?.takeIf { FINGERPRINT.matches(it) } ?: return null
            val code = q["c"]?.takeIf { CODE.matches(it) } ?: return null
            val name = q["n"].orEmpty().filter { !it.isISOControl() }.trim().take(60).ifEmpty { "PC" }
            return PairingInfo(name, addresses.take(8), port, fingerprint, code)
        }

        private fun query(raw: String): Map<String, String> =
            raw.split('&').mapNotNull { part ->
                val i = part.indexOf('=')
                if (i <= 0) null else decode(part.substring(0, i)) to decode(part.substring(i + 1))
            }.toMap()

        // the String overload: the Charset one needs Android 13
        private fun decode(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault("")

        /** 10/8, 172.16/12, 192.168/16 written as four numbers */
        fun isPrivateIpv4(s: String): Boolean {
            val parts = s.split('.')
            if (parts.size != 4) return false
            val n = parts.map { p -> if (p.isEmpty() || p.length > 3 || !p.all(Char::isDigit)) return false else p.toInt() }
            if (n.any { it > 255 }) return false
            return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168)
        }
    }
}
