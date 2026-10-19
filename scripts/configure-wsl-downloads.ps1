#Requires -Version 5.1
param(
  [ValidateRange(1024, 65535)][int]$Port = 18770,
  [string]$Distro = 'Debian',
  [switch]$FirewallOnly,
  [string]$LanAddress,
  [ValidateRange(1024, 65535)][int]$BackendPort = 18771
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
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Keep Debian WSL running for the LocalPass download service.' -Force | Out-Null
Start-ScheduledTask -TaskName 'LocalPass-WSL-Downloads'
Get-ScheduledTask -TaskName 'LocalPass-WSL-Downloads' | Select-Object TaskName,State
