// StarkLLM for Android: the companion app of StarkLLM on a Windows PC (docs/android-companion.md).
plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9 compiles Kotlin itself; this only pins the Kotlin version it uses
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
