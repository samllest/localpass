# LocalPass 的 WSL 下载服务

WSL 运行安装包与扩展的下载站，使用者在自己的 Windows 电脑安装桌面端。每个人注册自己的本地账号，密码保存在各自电脑，WSL 不接收密码数据。

## 构建与校验

在 Windows 项目目录使用 Node.js 22 和 npm：

```powershell
npm install
npm test
npm run test:site-data
npm run test:extension
npm run test:startup
npm run test:storage-lifecycle
npm run test:installer
npm run build:win
npm run test:updates
npm run package:distribution
```

`build:win` 会先构建项目，再创建独立的生产依赖目录，使用当前项目 Electron 对应的 SQLite 原生模块生成安装包，兼容开发目录使用 npm 或 pnpm 的情况。发布构建不会使用机器环境里其他项目的签名证书；当前交付的安装包未进行公共代码签名。

发布文件位于 `dist/downloads/site/`：安装包、扩展 ZIP、下载首页、使用说明与 `SHA256SUMS.txt`。安装包也内置扩展文件，可以在桌面端设置中打开扩展目录。只允许程序构建产物与生产依赖进入安装包；`.localpass-data`、SQLite 数据库、私钥、环境文件及工作截图不会进入发布包。

## 应用内更新（1.4.0 起）

安装版在启动 8 秒后及运行期间每 4 小时检查内网新版本；只检查，不自动下载或安装。也可在「设置 → 版本与更新」手动检查，点击「下载更新」，查看进度，校验完成后选择「重启并安装」。安装前再次确认，正常退出或后台运行不会自动安装。覆盖安装沿用原来的本地数据目录。

默认更新站为 `http://192.168.3.145:18770/`。地址改变时，在同一设置区域展开「内网更新地址」保存新地址，每台客户端会记住自己的配置。更新站不可达时显示可重试提示，不影响密码库使用。开发窗口不执行安装更新。

旧版本没有更新入口，需要先从下载页下载 1.4.0 或更高版本覆盖安装一次。浏览器中通过「加载已解压的扩展程序」安装的扩展不能随桌面端自动替换，仍需重新加载扩展；本次扩展版本维持 1.3.0。

以后发布时，提升 `package.json` 版本，执行 `npm run build:win`、`npm run package:distribution`，再执行下方 WSL 部署命令。打包会同时发布 electron-updater 使用的 `latest.yml`、安装包及 blockmap，SHA256SUMS 也包含这些文件。Nginx 禁止缓存更新索引，并保留历史安装包，已检查过旧版本的客户端仍可完成下载。下载时 electron-updater 按索引中的 SHA512 校验完整安装包。

当前更新包未公共签名，使用现有 HTTP 内网站点；文件哈希用于检查下载完整性，不能证明发布者身份。如需提高发布来源验证能力，应给安装包签名并将站点迁移到 HTTPS。

### 1.4.2 密码库隔离、更新与重装保护

注册时只有账号对应的密码库初始化成功才提交账号，初始化失败会回滚账号记录，避免后续出现「账号已存在但密码库缺失」。正常退出时显式关闭账号目录数据库。原先已缺失的文件不会用空库替代，应恢复完整的 `system.db` 和对应的 `user_*.db`。

应用内更新在用户确认安装后，通过 SQLite backup API 将完整账号目录和全部密码库（含已提交的 WAL 内容）备份到 `%APPDATA%\localpass\recovery\updates\`；备份不完整时暂停更新。安装程序也会在关闭旧进程后保留完整的数据库文件集合（包括 WAL）到 `recovery\installer-<version>\`。这些备份保留原密码库密钥上下文，仍需原主密码解锁。

正常交互安装结束后启动应用；静默覆盖安装检测到旧应用原本在运行（包括托盘后台）时，也自动启动一个替代实例。静默首次安装、或原本未运行的静默重装不会强制启动；应用内更新的 `--force-run` 交给标准安装流程处理，避免重复启动。`test:installer` 使用独立产品标识、临时目录和无窗口测试进程实际验证静默重装，不会覆盖 LocalPass 安装或访问真实密码库。

## 部署到 WSL

需要 WSL 的 Debian 中已运行 Docker，当前用户可以执行 `docker`、`docker compose` 和 `curl`。

```powershell
wsl -d Debian -- bash /mnt/e/project/localpass/deploy/wsl/deploy.sh /mnt/e/project/localpass/dist/downloads/site
```

默认部署到 WSL 的 `~/apps/localpass`，使用独立的 `localpass-distribution` Compose 项目，监听端口 `18770`。可使用 `LOCALPASS_DOWNLOAD_PORT` 修改端口。下载文件复制到 WSL 自己的 Linux 文件系统，服务不依赖 Windows 项目目录持续挂载。

Windows 本机访问 `http://localhost:18770/`。其他电脑使用这台 Windows 主机可达的局域网 IP 加端口 `18770`。WSL 使用 mirrored 网络时，确认该端口允许从使用者所在网络访问。

```bash
cd ~/apps/localpass
docker compose ps
curl --fail http://127.0.0.1:18770/health
docker compose logs --tail=50
```

Docker 服务启动后，容器通过 `unless-stopped` 自动启动；主机与 WSL 需要保持运行。重新构建并再次执行 `deploy.sh` 即可发布更新，旧下载版本保留在 `releases/`，`site` 指向当前版本。

为避免 WSL 在终端退出后停止，可在普通 PowerShell 执行以下命令，安装独立后台守护任务 `LocalPass-WSL-Downloads`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-wsl-downloads.ps1
```

守护程序由 Windows 任务计划程序启动，不依赖当前终端或项目目录。它在 Docker 就绪后启动 LocalPass 下载容器并保持 WSL 活跃；保活进程退出后 15 秒重试。任务在用户登录时启动，并每分钟尝试拉起一次；已有实例运行时忽略重复启动。关闭 PowerShell、CMD 或 WSL 终端不会主动退出守护任务。Windows 用户需要保持登录，主机保持开机且不休眠。

安装脚本使用 Windows 自带的 .NET Framework 编译器，将 `scripts/wsl-downloads-supervisor.cs` 编译为 Windows GUI 子系统的后台程序，安装到 `%LOCALAPPDATA%\LocalPass\WSL\`。任务直接启动这个程序；它和 WSL 子进程均不创建控制台，因此不会留下空白的 Windows Terminal 窗口。守护程序使用单实例锁防止重复保活，并在自身退出时清理其 WSL 子进程。无需重新安装 LocalPass 桌面端或浏览器扩展。

日志由任务运行账户写到 `%LOCALAPPDATA%\LocalPass\WSL\keepalive.log`；可用以下命令查看任务状态：

```powershell
Get-ScheduledTask -TaskName LocalPass-WSL-Downloads
Get-ScheduledTaskInfo -TaskName LocalPass-WSL-Downloads
```

默认部署目录是 WSL 当前用户的 `~/apps/localpass`。如果使用其他目录，安装任务时添加 `-DeployDirectory /absolute/linux/path`。守护任务仅自动启动该目录内的 Compose 项目，不会自动重启 Debian 或 Windows 网络服务。需要手动停止守护时，应先禁用任务，再停止任务，避免下一分钟被重新拉起：

```powershell
Disable-ScheduledTask -TaskName LocalPass-WSL-Downloads
Stop-ScheduledTask -TaskName LocalPass-WSL-Downloads
```

WSL mirrored 网络默认阻止外部入站连接。在管理员 PowerShell 执行以下命令，只放行下载服务的 TCP 18770 端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-wsl-downloads.ps1 -FirewallOnly
```

这不会关闭防火墙。可用 `Remove-NetFirewallHyperVRule -Name LocalPass-Downloads-18770` 撤销规则。主机自身访问局域网 IP 还可能受 WSL 的回环设置影响，验证页面时本机使用 `localhost`，其他电脑使用主机局域网 IP。

如果 `localhost` 正常但同一局域网无法访问，使用独立的 WSL 内部端口，避免 Windows 与 WSL 同端口映射冲突。先在普通 PowerShell 执行（部署目录按实际情况修改）：

```powershell
wsl -d Debian -- cp /mnt/e/project/localpass/deploy/wsl/lan.env.example /home/jayg/apps/localpass/.env
wsl -d Debian -- docker compose --project-directory /home/jayg/apps/localpass --env-file /home/jayg/apps/localpass/.env -f /home/jayg/apps/localpass/compose.yaml up -d --force-recreate
```

再在管理员 PowerShell 给 Windows 主机的实际局域网 IP 添加专用转发。例如：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-wsl-downloads.ps1 -FirewallOnly -LanAddress 192.168.3.145
```

容器仅监听 WSL 内部的 `127.0.0.1:18771`；Windows 监听指定局域网 IP 和本机 `127.0.0.1` 的 TCP 18770，转发到内部端口。Windows 防火墙只允许 `LocalSubnet` 访问该端口，适用于当前网络为 Public 的情况。对外访问地址仍为 `http://192.168.3.145:18770/`，本机为 `http://localhost:18770/`。规则在重启后保留；若主机局域网 IP 改变，应先删除旧地址转发，再用新 IP 执行命令。Windows IP Helper 服务需保持运行。`deploy.sh` 会保留 `.env` 并从容器实际映射端口执行健康检查。

WSL 重启后，如果内部 `http://127.0.0.1:18771/health` 正常，但局域网入口拒绝连接，检查 Windows 是否实际监听局域网地址：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 18770
```

若只显示 `127.0.0.1`，在管理员 PowerShell 重新执行上述配置脚本，重建局域网监听。若仍未监听，可执行 `Restart-Service iphlpsvc -Force` 后再次检查；这会短暂中断此主机其他 Windows 端口转发连接。

撤销这条局域网转发（管理员 PowerShell）：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=192.168.3.145 listenport=18770
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=18770
Remove-NetFirewallRule -Name LocalPass-LAN-Downloads-18770
```

## 使用者安装

1. 下载并运行 Windows 安装包，在桌面端注册自己的账号和主密码。
2. 下载并解压扩展 ZIP。Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`。
3. 打开开发者模式，加载解压后的 `chrome-extension` 文件夹。桌面端设置中也提供内置扩展目录入口。
4. 保持桌面端解锁，刷新网站并登录一次。后续可在登录框选择已保存的账号。
5. 更新插件后重新加载扩展，并刷新网站。

### 1.4.3 界面与扩展修复

桌面端按 Ardot 设计更新登录、密码管理、密码检查、设置和账号选择界面，安装包包含本地字体与图标。输入控件使用独立字体度量，修复中文和 g、j、p 等字符底部被裁切的问题。

配套扩展为 1.3.1：原生账号选择窗口切换焦点时复用同一次查询，选择或取消后不会自动重复弹出；离开表单、输入内容或切换页面会取消过期查询。更新后请重新加载扩展，并刷新已打开的网站页面。

已有 1.4.x 桌面端可在「设置 → 版本与更新」检查、下载并安装 1.4.3，也可从下载页覆盖安装。WSL 发布时保留当前网络配置和旧安装包，通过 `latest.yml` 向客户端提供新版本。

### 1.2.1 启动修复

1.2.0 同时打开多个窗口时，可能因浏览器连接端口 `35320` 已被占用而弹出主进程 JavaScript 错误。1.2.1 会在再次启动时激活已有窗口；开发版或其他程序占用端口时显示中文说明，密码库功能保持可用。更新前先正常关闭已运行的 LocalPass（包括开发版），再运行新版安装包覆盖安装，保留原数据目录。浏览器扩展仍为 1.2.0，无需更新。

### 1.2.2 后台运行

点击窗口关闭按钮或按 Alt+F4 时，可选择「取消」「确认关闭」「后台运行」。后台运行会隐藏窗口并保留系统托盘图标，已解锁的密码库可以继续配合扩展保存和填充密码；锁定或退出应用后不再保存或填充，也不会在扩展中暂存等待下次启动。

勾选「不再提示」后，记住本次「确认关闭」或「后台运行」选择 72 小时，重启后仍有效。重复关闭不会顺延到期时间，取消不会保存任何选择。可在设置的「关闭窗口」中点击「恢复关闭提示」提前恢复。托盘菜单中的「退出 LocalPass」始终直接退出。

Windows 安装版的数据位于 `%APPDATA%\localpass\vaults`。从 1.4.2 起，旧版 `databases` 目录中的账号和现存密码库会通过 SQLite 一致性快照自动迁移，原文件保留。浏览器内核数据单独放在 `browser-session`，避免 Chromium 启动清理误删密码库。开发版使用项目的 `.localpass-data/databases`。更新或迁移前保留完整数据目录，并在设置中导出加密备份；当前备份解密需要原密码库的密钥，应一并保留原 `system.db` 与 `user_*.db` 文件。
