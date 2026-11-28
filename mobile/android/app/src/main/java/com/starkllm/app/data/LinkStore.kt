package com.starkllm.app.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** A paired PC. The token is the phone's key to it. The id is the PC's certificate fingerprint. */
data class Link(
    val pcName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val deviceId: String,
    val token: String,
    val relayUrl: String? = null,
    val relayId: String? = null,
) {
    val id: String get() = fingerprint
}

@Serializable
private data class StoredLink(
    val pcName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val deviceId: String,
    val token: String,      // AES-GCM cipher text (base64)
    val iv: String,
    val relayUrl: String? = null,
    val relayId: String? = null,
)

/**
 * Keeps the paired PCs on this phone (home, office, ...). Every device token is encrypted with an AES key that lives in
 * the Android Keystore and cannot be taken out of it (KeystoreBox); the app has no backup (AndroidManifest.xml), so a
 * token never leaves the phone.
 */
class LinkStore(context: Context) {
    private val prefs = context.getSharedPreferences("link", Context.MODE_PRIVATE)
    private val listSerializer = ListSerializer(StoredLink.serializer())
    private val box: Box = KeystoreBox(KEY_ALIAS)

    init {
        migrateSingleLink()
    }

    fun all(): List<Link> = stored().mapNotNull { s ->
        runCatching { Link(s.pcName, s.addresses, s.port, s.fingerprint, s.deviceId, decrypt(s.token, s.iv), s.relayUrl, s.relayId) }.getOrNull()
    }

    /** the PC in use; the first one when none was chosen */
    fun current(): Link? {
        val links = all()
        val id = prefs.getString("current", null)
        return links.firstOrNull { it.id == id } ?: links.firstOrNull()
    }

    /** adds a PC or replaces the pairing with the same PC, and makes it the current one */
    fun save(link: Link) {
        val (cipherText, iv) = encrypt(link.token)
        val entry = StoredLink(link.pcName, link.addresses, link.port, link.fingerprint, link.deviceId, cipherText, iv, link.relayUrl, link.relayId)
        write(stored().filter { it.fingerprint != link.fingerprint } + entry)
        prefs.edit().putString("current", link.id).commit()
    }

    fun select(id: String) {
        prefs.edit().putString("current", id).commit()
    }

    /** the address that answered last goes first next time */
    fun preferAddress(id: String, address: String) {
        val list = stored()
        val s = list.firstOrNull { it.fingerprint == id } ?: return
        if (s.addresses.firstOrNull() == address || address !in s.addresses) return
        write(list.map { if (it.fingerprint == id) it.copy(addresses = listOf(address) + (it.addresses - address)) else it })
    }

    fun remove(id: String) {
        val rest = stored().filter { it.fingerprint != id }
        write(rest)
        if (prefs.getString("current", null) == id) prefs.edit().remove("current").commit()
        if (rest.isEmpty()) box.destroy()
    }

    private fun stored(): List<StoredLink> =
        prefs.getString("links", null)?.let { runCatching { json.decodeFromString(listSerializer, it) }.getOrNull() }.orEmpty()

    private fun write(list: List<StoredLink>) {
        prefs.edit().putString("links", json.encodeToString(listSerializer, list)).commit()
    }

    // the first version kept one PC in separate keys
    private fun migrateSingleLink() {
        val token = prefs.getString("token", null) ?: return
        val iv = prefs.getString("iv", null)
        val fp = prefs.getString("fingerprint", null)
        if (iv != null && fp != null && stored().none { it.fingerprint == fp }) {
            write(stored() + StoredLink(
                prefs.getString("pcName", "PC").orEmpty(),
                prefs.getString("addresses", "").orEmpty().split(',').filter { it.isNotBlank() },
                prefs.getInt("port", 0), fp, prefs.getString("deviceId", "").orEmpty(), token, iv,
            ))
            prefs.edit().putString("current", fp).commit()
        }
        prefs.edit().remove("token").remove("iv").remove("fingerprint").remove("pcName").remove("addresses").remove("port").remove("deviceId").commit()
    }

    private fun encrypt(plain: String): Pair<String, String> = box.seal(plain)

    private fun decrypt(cipherText: String, iv: String): String = box.open(cipherText, iv)

    private companion object {
        const val KEY_ALIAS = "starkllm_link"
    }
}
