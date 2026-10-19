#Requires -Version 5.1
param(
  [ValidateRange(1024, 65535)][int]$Port = 18770,
  [string]$Distro = 'Debian',
  [switch]$FirewallOnly
)
$ErrorActionPreference = 'Stop'
if ($FirewallOnly) {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an administrator PowerShell with -FirewallOnly.'
  }
  $ruleName = "LocalPass-Downloads-$Port"
  if (-not (Get-NetFirewallHyperVRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallHyperVRule -Name $ruleName -DisplayName "LocalPass WSL downloads TCP $Port" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts $Port -Action Allow | Out-Null
  }
  Get-NetFirewallHyperVRule -Name $ruleName | Select-Object Name,Direction,Action,LocalPorts
  exit
}
if ($Distro -notmatch '^[\w.-]+$') { throw 'Invalid WSL distribution name.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Keep Debian WSL running for the LocalPass download service.' -Force | Out-Null
Start-ScheduledTask -TaskName 'LocalPass-WSL-Downloads'
Get-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' | Select-Object TaskName,State
