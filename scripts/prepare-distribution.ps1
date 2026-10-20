$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$extensionInfo = Get-Content -LiteralPath (Join-Path $projectRoot 'chrome-extension/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $packageInfo.version
$extensionVersion = $extensionInfo.version
$installerName = "localpass-$version-setup.exe"
$installer = Join-Path $projectRoot "dist/release/$installerName"
if (-not (Test-Path -LiteralPath $installer)) { throw "Build the Windows installer first: npm run build:win" }
$site = Join-Path $projectRoot 'dist/downloads/site'
New-Item -ItemType Directory -Path $site -Force | Out-Null
Copy-Item -LiteralPath $installer -Destination (Join-Path $site $installerName) -Force
$extensionName = "localpass-extension-$extensionVersion.zip"
Compress-Archive -LiteralPath (Join-Path $projectRoot 'chrome-extension') -DestinationPath (Join-Path $site $extensionName) -Force
$utf8 = [System.Text.UTF8Encoding]::new($false)
$template = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'deploy/wsl/site/index.html'))
$size = [Math]::Round((Get-Item -LiteralPath $installer).Length / 1MB, 1)
$html = $template.Replace('__EXTENSION_VERSION__', $extensionVersion).Replace('__VERSION__', $version).Replace('__INSTALLER_SIZE__', [string]$size)
[System.IO.File]::WriteAllText((Join-Path $site 'index.html'), $html, $utf8)
$guide = @"
LocalPass $version 使用说明

1. 运行 $installerName 安装桌面端，然后注册自己的本地账号与主密码。
2. 解压 $extensionName，保留其中 chrome-extension 文件夹。
3. Chrome 打开 chrome://extensions/（Edge 为 edge://extensions/），开启开发者模式。
4. 点击“加载已解压的扩展程序”，选择解压后的 chrome-extension 文件夹。
   也可在桌面端的“设置 → 在浏览器中使用”中点击“打开扩展目录”。
5. 保持桌面端运行并解锁，刷新网站并登录一次。之后可在登录输入框选择已保存的账号。

密码库在每个使用者自己的电脑上，下载服务器不接收密码。
Windows 安装版数据库通常位于 %APPDATA%\localpass\databases。
更新前请在设置中导出加密备份，卸载或更换电脑前保留完整的数据目录。
当前加密备份需要原密码库的加密密钥，恢复时应保留原 system.db 与 user_*.db 文件。
更新插件后，需要重新加载扩展并刷新网站页面。
关闭窗口时可选择取消、确认关闭或后台运行。后台运行且密码库已解锁时，扩展才能继续保存和填充密码。
勾选“不再提示”会记住本次退出或后台运行选择 3 天，取消不记忆。可在设置中“恢复关闭提示”。
托盘菜单可重新打开窗口或退出应用；退出后扩展不会暂存登录密码。
开发环境按主机、端口和项目名称匹配。项目名称取网站名称，缺失时取标签页标题，可在编辑密码时调整。
同名项目存在多个账号记录时，会弹出独立选择窗口；桌面端在后台且已解锁时也会显示。
保存时遇到同名账号的不同密码，可确认更新对象或另存为新记录。
"@
[System.IO.File]::WriteAllText((Join-Path $site '使用说明.txt'), $guide, $utf8)
$checksums = @($installerName, $extensionName) | ForEach-Object {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead((Join-Path $site $_))
  try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  "$hash  $_"
}
[System.IO.File]::WriteAllText((Join-Path $site 'SHA256SUMS.txt'), (($checksums -join "`n") + "`n"), $utf8)
Write-Output "Distribution ready: $site"
