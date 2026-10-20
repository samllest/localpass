#Requires -Version 5.1
param(
  [ValidateRange(1024, 65535)][int]$Port = 18770,
  [string]$Distro = 'Debian',
  [switch]$FirewallOnly,
  [string]$LanAddress,
  [ValidateRange(1024, 65535)][int]$BackendPort = 18771,
  [string]$DeployDirectory
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
  if ($LanAddress) {
    if ($BackendPort -eq $Port) { throw 'BackendPort must differ from the public Port.' }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($LanAddress, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $LanAddress -eq '0.0.0.0' -or $LanAddress.StartsWith('127.')) {
      throw 'LanAddress must be a specific non-loopback IPv4 address.'
    }
    if (-not (Get-NetIPAddress -IPAddress $LanAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
      throw 'LanAddress is not assigned to this Windows host.'
    }
    # Recreate existing listeners: updating a stale rule may leave it unbound.
    & netsh.exe interface portproxy delete v4tov4 "listenaddress=$LanAddress" "listenport=$Port" protocol=tcp 2>$null | Out-Null
    # Bind only the LAN address. The loopback destination remains the WSL service.
    & netsh.exe interface portproxy add v4tov4 "listenaddress=$LanAddress" "listenport=$Port" connectaddress=127.0.0.1 "connectport=$BackendPort" protocol=tcp
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the LAN port forward.' }
    & netsh.exe interface portproxy add v4tov4 listenaddress=127.0.0.1 "listenport=$Port" connectaddress=127.0.0.1 "connectport=$BackendPort" protocol=tcp
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the local port forward.' }
    $lanRuleName = "LocalPass-LAN-Downloads-$Port"
    if (Get-NetFirewallRule -Name $lanRuleName -ErrorAction SilentlyContinue) {
      Set-NetFirewallRule -Name $lanRuleName -Enabled True -Direction Inbound -Action Allow -Profile Any -RemoteAddress LocalSubnet -LocalAddress $LanAddress -Protocol TCP -LocalPort $Port | Out-Null
    } else {
      New-NetFirewallRule -Name $lanRuleName -DisplayName "LocalPass LAN downloads TCP $Port" -Enabled True -Direction Inbound -Action Allow -Profile Any -RemoteAddress LocalSubnet -LocalAddress $LanAddress -Protocol TCP -LocalPort $Port | Out-Null
    }
    Write-Output "LAN download address: http://${LanAddress}:$Port/"
  }
  exit
}
if ($Distro -notmatch '^[\w.-]+$') { throw 'Invalid WSL distribution name.' }
if ($DeployDirectory -and $DeployDirectory -notmatch '^/[\w./-]+$') {
  throw 'DeployDirectory must be an absolute Linux path without spaces.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'LocalPass\WSL'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$runnerSource = Join-Path $PSScriptRoot 'wsl-downloads-supervisor.cs'
if (-not (Test-Path -LiteralPath $runnerSource)) { throw 'The WSL supervisor script is missing.' }
$sourceHash = (Get-FileHash -LiteralPath $runnerSource -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$runnerPath = Join-Path $runtimeDirectory "wsl-downloads-supervisor-$sourceHash.exe"
if (-not (Test-Path -LiteralPath $runnerPath)) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  }
  & $compiler /nologo /target:winexe /optimize+ "/out:$runnerPath" $runnerSource
  if ($LASTEXITCODE -ne 0) { throw 'Unable to compile the windowless WSL supervisor.' }
}
$existingTask = Get-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
  Stop-ScheduledTask -TaskName 'LocalPass-WSL-Downloads'
}
$arguments = $Distro
if ($DeployDirectory) { $arguments += " $DeployDirectory" }
$action = New-ScheduledTaskAction -Execute $runnerPath -Argument $arguments
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$retryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' -Action $action -Trigger @($logonTrigger, $retryTrigger) -Principal $taskPrincipal -Settings $settings -Description 'Supervise LocalPass WSL downloads independently of terminal windows; retry after interruption.' -Force | Out-Null
Start-ScheduledTask -TaskName 'LocalPass-WSL-Downloads'
Get-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' | Select-Object TaskName,State
Write-Output "Supervisor log: $(Join-Path $runtimeDirectory 'keepalive.log')"
