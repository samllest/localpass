@echo off
setlocal

:: Get the absolute path of this batch script's directory
set "DIR=%~dp0"
:: Remove trailing backslash
set "DIR=%DIR:~0,-1%"

:: Register the native messaging host
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.localpass.app" /ve /t REG_SZ /d "%DIR%\com.localpass.app.json" /f

echo === LocalPass Native Messaging Host Registered ===
echo.
echo Make sure you have updated com.localpass.app.json with your Chrome Extension ID!
echo.
pause
