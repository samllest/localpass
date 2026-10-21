!include "getProcessInfo.nsh"
!include "FileFunc.nsh"
Var pid
Var LocalPassWasRunning

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    StrCpy $LocalPassWasRunning "1"
  ${EndIf}
  ; Preserve electron-builder's stop/retry behavior, with the handoff created
  ; AFTER installation consent but BEFORE either graceful or forced termination.
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${If} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${If} ${isUpdated}
      Sleep 300
    ${EndIf}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK localpassStop
        Quit
      ${EndIf}
      localpassStop:
      ; Uninstall must not authorize restoration on a later ordinary launch.
      !ifndef BUILD_UNINSTALLER
        ${If} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\update-session.bin"
          FileOpen $R4 "$APPDATA\${APP_PACKAGE_NAME}\update-resume.marker" w
          FileWrite $R4 "LocalPass installer ${VERSION}"
          FileClose $R4
        ${EndIf}
      !endif
      DetailPrint "$(appClosing)"
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      Sleep 300
      StrCpy $R1 0
      localpassRetry:
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          Sleep 1000
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${If} $R0 != 0
            Goto localpassStopped
          ${EndIf}
          IntOp $R1 $R1 + 1
          ${If} $R1 > 1
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY localpassRetry
            Delete "$APPDATA\${APP_PACKAGE_NAME}\update-resume.marker"
            Quit
          ${EndIf}
          Sleep 1000
          Goto localpassRetry
        ${EndIf}
      localpassStopped:
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; CHECK_APP_RUNNING has finished: preserve the complete closed SQLite file set.
  ${If} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\vaults\system.db"
    StrCpy $R3 "$APPDATA\${APP_PACKAGE_NAME}\vaults"
  ${Else}
    StrCpy $R3 "$APPDATA\${APP_PACKAGE_NAME}\databases"
  ${EndIf}
  ${If} ${FileExists} "$R3\system.db"
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}\recovery\installer-${VERSION}"
    GetTempFileName $R2 "$APPDATA\${APP_PACKAGE_NAME}\recovery\installer-${VERSION}"
    Delete "$R2"
    CreateDirectory "$R2"
    ClearErrors
    CopyFiles /SILENT "$R3\*.*" "$R2"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Unable to back up the local vault. Please keep the original data directory."
      Abort
    ${EndIf}
  ${EndIf}
  ; NSIS normally skips relaunch for silent installs without --force-run.
  ; Preserve running state for manual reinstalls too, including a hidden tray app.
  ${If} ${Silent}
  ${AndIf} $LocalPassWasRunning == "1"
  ${AndIfNot} ${isForceRun}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${EndIf}
!macroend
