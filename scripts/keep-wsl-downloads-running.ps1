#Requires -Version 5.1
param(
  [string]$Distro = 'Debian',
  [string]$DeployDirectory
)
$ErrorActionPreference = 'Stop'
if ($Distro -notmatch '^[\w.-]+$') { throw 'Invalid WSL distribution name.' }
if ($DeployDirectory -and $DeployDirectory -notmatch '^/[\w./-]+$') {
  throw 'DeployDirectory must be an absolute Linux path without spaces.'
}
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'LocalPass\WSL'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$logPath = Join-Path $runtimeDirectory 'keepalive.log'
if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 1MB) {
  Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
}
function Write-KeepaliveLog([string]$Message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}
if ($DeployDirectory) {
  $linuxCommand = "deploy_dir='$DeployDirectory'; "
} else {
  $linuxCommand = 'deploy_dir="$HOME/apps/localpass"; '
}
$linuxCommand += 'until docker info >/dev/null 2>&1; do sleep 5; done; docker compose --project-directory "$deploy_dir" -f "$deploy_dir/compose.yaml" up -d >/dev/null 2>&1 || exit 1; exec /bin/sleep infinity'
# Escape embedded quotes for the Windows native command line, not for a shell.
$nativeCommand = $linuxCommand.Replace('"', '\"')
Write-KeepaliveLog "Supervisor started for $Distro."
while ($true) {
  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "$env:WINDIR\System32\wsl.exe"
    $startInfo.Arguments = "-d $Distro --exec /bin/sh -c `"$nativeCommand`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $startInfo
    [void]$child.Start()
    Write-KeepaliveLog "WSL keepalive started, Windows PID $($child.Id)."
    $child.WaitForExit()
    Write-KeepaliveLog ('WSL keepalive exited with 0x{0:X8}; retrying in 15 seconds.' -f $child.ExitCode)
    $child.Dispose()
  } catch {
    Write-KeepaliveLog "Unable to keep WSL running: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 15
}
