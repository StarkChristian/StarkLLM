package com.starkllm.app.data

import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * The phone trusts the PC because of the fingerprint in the QR code it scanned, not because of who signed the PC's
 * certificate (it is self-signed): certificate pinning. A device in the same Wi-Fi that pretends to be the PC fails the
 * TLS handshake, before anything (the pairing code, the device token, a question) is sent.
 */
object Pinning {
    /** SHA-256 of the certificate (DER) in base64url without padding, as in the QR code */
    fun fingerprintOf(cert: X509Certificate): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.encoded))

    fun matches(cert: X509Certificate?, pin: String): Boolean =
        cert != null && MessageDigest.isEqual(fingerprintOf(cert).toByteArray(), pin.toByteArray())

    class PinnedTrustManager(private val pin: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("The phone does not accept client connections")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            if (chain.isNullOrEmpty() || !matches(chain[0], pin)) {
                throw CertificateException("This is not the paired PC (certificate fingerprint differs)")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    fun client(pin: String, base: OkHttpClient = OkHttpClient()): OkHttpClient {
        val trust = PinnedTrustManager(pin)
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        return base.newBuilder()
            .sslSocketFactory(tls.socketFactory, trust)
            // the certificate names no address (the PC's address can change): the pin is the identity check
            .hostnameVerifier { _, session -> matches(session.peerCertificates.firstOrNull() as? X509Certificate, pin) }
            .connectTimeout(4, TimeUnit.SECONDS)
            // a large model can take a while before the first word of an answer
            .readTimeout(5, TimeUnit.MINUTES)
            .writeTimeout(2, TimeUnit.MINUTES)
            .retryOnConnectionFailure(false)
            // the PC's phone link closes idle connections after 30 s: drop them here first, so a request after a pause
            // does not meet a connection the PC already closed (seen on the Flip5 as "not reachable")
            .connectionPool(ConnectionPool(4, 20, TimeUnit.SECONDS))
            .build()
    }
}
