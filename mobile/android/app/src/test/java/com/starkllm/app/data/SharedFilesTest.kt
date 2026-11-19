package com.starkllm.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedFilesTest {
    private val own = "com.starkllm.app.files"

    @Test
    fun aDocumentOfAnotherAppIsSent() {
        assertTrue(SharedFiles.acceptable("content", "com.android.providers.downloads.documents", own))
        assertTrue(SharedFiles.acceptable("content", "10@com.google.android.apps.photos.contentprovider", own))
    }

    @Test
    fun pathsAndTheAppsOwnFilesAreRefused() {
        assertFalse(SharedFiles.acceptable("file", null, own))
        assertFalse(SharedFiles.acceptable("FILE", "", own))
        assertFalse(SharedFiles.acceptable("content", own, own))
        assertFalse(SharedFiles.acceptable("content", "0@com.starkllm.app.files", own))
        assertFalse(SharedFiles.acceptable("content", "COM.STARKLLM.APP.FILES", own))
        assertFalse(SharedFiles.acceptable("content", null, own))
        assertFalse(SharedFiles.acceptable(null, "com.example", own))
        assertFalse(SharedFiles.acceptable("https", "example.com", own))
    }
}
