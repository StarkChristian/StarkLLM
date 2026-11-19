package com.starkllm.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.starkllm.app.AppViewModel
import com.starkllm.app.R
import com.starkllm.app.data.Workspace
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Photos of letters for the PC: taken by the camera app into the app's cache (shared with it through the FileProvider),
 * sent to the PC, and then deleted. Nothing stays on the phone.
 */
object Photos {
    private fun dir(context: Context) = File(context.cacheDir, "photos")

    fun authority(context: Context) = "${context.packageName}.files"

    /** "Photo-2026-11-19-081500.jpg", with the word in the phone's language */
    fun name(context: Context): String =
        context.getString(R.string.photo_file_prefix) + "-" + SimpleDateFormat("yyyy-MM-dd-HHmmss", Locale.ROOT).format(Date()) + ".jpg"

    fun newFile(context: Context): File = File(dir(context).apply { mkdirs() }, name(context))

    /** At a fresh start of the app: photos left over (the app was ended while one was taken or sent) */
    fun clear(context: Context) {
        dir(context).listFiles()?.forEach { it.delete() }
    }
}

/** "Camera" of the attach sheet: takes a photo and sends it into the workspace */
internal val LocalTakePhoto = compositionLocalOf<(Workspace) -> Unit> { {} }

/**
 * The camera for photos of letters, kept at the top of the app (StarkApp) and with saved state: the camera app is in
 * front while the photo is taken, and Android may end StarkLLM meanwhile. The attach sheet (closed by then) could not
 * receive the photo; this can, and it still knows the file and the workspace.
 */
@Composable
internal fun rememberPhotoCamera(vm: AppViewModel): (Workspace) -> Unit {
    val context = LocalContext.current
    var path by rememberSaveable { mutableStateOf<String?>(null) }
    var workspaceId by rememberSaveable { mutableStateOf(0) }
    var workspaceName by rememberSaveable { mutableStateOf("") }
    var denied by rememberSaveable { mutableStateOf(false) }
    val take = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val file = path?.let(::File)
        path = null
        if (file != null) {
            if (ok && file.length() > 0) {
                vm.upload(Workspace(workspaceId, workspaceName), file.name, file.asRequestBody("image/jpeg".toMediaType()), onDone = { file.delete() })
            } else {
                file.delete()
            }
        }
    }
    val start = rememberUpdatedState<() -> Unit> {
        val file = Photos.newFile(context)
        path = file.absolutePath
        try {
            take.launch(FileProvider.getUriForFile(context, Photos.authority(context), file))
        } catch (e: Exception) {
            file.delete()       // no camera app on the phone
            path = null
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) start.value() else {
            denied = true
        }
    }
    if (denied) PermissionDialog(stringResource(R.string.camera_permission_needed)) { denied = false }
    return remember<(Workspace) -> Unit> {
        { ws ->
            workspaceId = ws.id
            workspaceName = ws.name
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) start.value()
            else permission.launch(Manifest.permission.CAMERA)
        }
    }
}
