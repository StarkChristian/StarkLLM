package com.starkllm.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The paired PC. The token is the phone's key to it. */
data class Link(
    val pcName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val deviceId: String,
    val token: String,
)

/**
 * Keeps the pairing on this phone. The device token is encrypted with an AES key that lives in the Android Keystore
 * and cannot be taken out of it; the app has no backup (AndroidManifest.xml), so the token never leaves the phone.
 */
class LinkStore(context: Context) {
    private val prefs = context.getSharedPreferences("link", Context.MODE_PRIVATE)

    fun load(): Link? {
        val token = runCatching {
            decrypt(prefs.getString("token", null) ?: return null, prefs.getString("iv", null) ?: return null)
        }.getOrNull() ?: return null
        return Link(
            pcName = prefs.getString("pcName", null) ?: return null,
            addresses = prefs.getString("addresses", null)?.split(',')?.filter { it.isNotBlank() } ?: return null,
            port = prefs.getInt("port", 0).takeIf { it > 0 } ?: return null,
            fingerprint = prefs.getString("fingerprint", null) ?: return null,
            deviceId = prefs.getString("deviceId", "").orEmpty(),
            token = token,
        )
    }

    fun save(link: Link) {
        val (cipherText, iv) = encrypt(link.token)
        prefs.edit()
            .putString("pcName", link.pcName)
            .putString("addresses", link.addresses.joinToString(","))
            .putInt("port", link.port)
            .putString("fingerprint", link.fingerprint)
            .putString("deviceId", link.deviceId)
            .putString("token", cipherText)
            .putString("iv", iv)
            .commit()
    }

    /** the address that answered last goes first next time */
    fun preferAddress(address: String) {
        val list = prefs.getString("addresses", null)?.split(',')?.filter { it.isNotBlank() } ?: return
        if (list.firstOrNull() == address || address !in list) return
        prefs.edit().putString("addresses", (listOf(address) + (list - address)).joinToString(",")).apply()
    }

    fun clear() {
        prefs.edit().clear().commit()
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
    }

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (keyStore().getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): Pair<String, String> {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP) to Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
    }

    private fun decrypt(cipherText: String, iv: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        return String(cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP)), Charsets.UTF_8)
    }

    private companion object {
        const val KEY_ALIAS = "starkllm_link"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
