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
  !insertmacro _CHECK_APP_RUNNING
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
