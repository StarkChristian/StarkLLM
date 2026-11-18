# kotlinx.serialization, OkHttp, ZXing and CameraX bring their own rules.
# The data classes sent to and read from StarkLLM on the PC:
-keep,includedescriptorclasses class com.starkllm.app.data.**$$serializer { *; }
-keepclassmembers class com.starkllm.app.data.** {
    *** Companion;
}
