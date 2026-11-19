package com.starkllm.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone offers only local models that can answer (the same rule as the PC's backend, netguard.is_cloud_model) */
class ModelsTest {
    @Test
    fun cloudModelsAreRecognisedAsOnThePc() {
        listOf("gpt-oss:120b-cloud", "kimi-k2:1t-cloud", "qwen3-coder:480b-cloud", "deepseek-v3.1:671b-cloud", "glm-4.6:cloud",
            "GPT-OSS:20B-CLOUD", "library/model:cloud-preview", "minimax-m2:cloud").forEach { assertTrue(it, isCloudModel(it)) }
        listOf("", "llama3.2:3b", "qwen3:8b", "gemma3:12b", "mistral-small3.2:24b", "cloudy-llama:7b", "my-cloud/llama3:8b")
            .forEach { assertFalse(it, isCloudModel(it)) }
    }

    @Test
    fun theListOffersOnlyLocalModelsThatCanAnswer() {
        val fromPc = listOf("llama3.2:3b", "nomic-embed-text:latest", "gpt-oss:120b-cloud", "qwen3:8b", "glm-4.6:cloud", "mxbai-embed-large")
        assertEquals(listOf("llama3.2:3b", "qwen3:8b"), fromPc.filter(::isChatModel))
    }
}
