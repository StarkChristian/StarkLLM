package com.starkllm.app.data

/**
 * What another app may hand to StarkLLM with "Share". A file only as content:// from another app's provider: a file://
 * path or a content:// address of StarkLLM's own FileProvider could make the app read and send its own private files
 * (the device tokens, the cache) to the PC.
 */
object SharedFiles {
    /** shared text goes into the question field; a whole book pasted by accident is cut */
    const val MAX_TEXT = 20_000

    fun acceptable(scheme: String?, authority: String?, ownAuthority: String): Boolean {
        if (!scheme.equals("content", ignoreCase = true)) return false
        // "10@com.example.files": a provider of another user profile; the part after @ names the provider
        val provider = authority?.substringAfterLast('@')?.trim().orEmpty()
        return provider.isNotEmpty() && !provider.equals(ownAuthority, ignoreCase = true)
    }
}
