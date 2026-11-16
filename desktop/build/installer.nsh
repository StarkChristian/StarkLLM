; StarkLLM additions to the electron-builder NSIS installer.
;
; Found on a real Windows 11 PC with Smart App Control on (9 Nov 2026): the update 2.0.7 -> 2.0.8 stopped with
; "The old application files could not be uninstalled ...: 2". Before an update the installer runs the uninstaller of the
; old version; that uninstaller finds and closes the running app with a helper DLL, and Smart App Control can block
; unsigned DLLs ("Part of this app has been blocked"). The old uninstaller then gives up with code 2 and the update ends.
;
; 1. If the old uninstaller fails, the installer closes StarkLLM itself and installs over the old files instead of
;    stopping. Chats, documents and settings are in %APPDATA%\StarkLLM and are not touched either way.
; 2. Closing the running app uses only built-in NSIS commands (no plugin DLL), so the next update does not depend on them.

!macro starkllmCloseApp
  ; taskkill is part of Windows and signed by Microsoft; SW_HIDE: no console window during the update
  ExecShellWait "open" "$SYSDIR\taskkill.exe" '/f /t /im "${APP_EXECUTABLE_FILENAME}"' SW_HIDE
  Sleep 1500
!macroend

!macro customCheckAppRunning
  !insertmacro starkllmCloseApp
!macroend

!macro starkllmOldUninstallerResult
  ${If} ${Errors}
    DetailPrint "The old uninstaller could not be started; installing over the old files."
  ${ElseIf} $R0 != 0
    DetailPrint "The old uninstaller ended with code $R0; installing over the old files."
    !insertmacro starkllmCloseApp
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInstallCheck
  !insertmacro starkllmOldUninstallerResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro starkllmOldUninstallerResult
!macroend
