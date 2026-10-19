# LocalPass 的 WSL 下载服务

WSL 运行安装包与扩展的下载站，使用者在自己的 Windows 电脑安装桌面端。每个人注册自己的本地账号，密码保存在各自电脑，WSL 不接收密码数据。

## 构建与校验

在 Windows 项目目录使用 Node.js 22 和 npm：

```powershell
npm install
npm test
npm run test:site-data
npm run test:extension
npm run build:win
npm run package:distribution
```

`build:win` 会先构建项目，再创建独立的生产依赖目录，使用当前项目 Electron 对应的 SQLite 原生模块生成安装包，兼容开发目录使用 npm 或 pnpm 的情况。发布构建不会使用机器环境里其他项目的签名证书；当前交付的安装包未进行公共代码签名。

发布文件位于 `dist/downloads/site/`：安装包、扩展 ZIP、下载首页、使用说明与 `SHA256SUMS.txt`。安装包也内置扩展文件，可以在桌面端设置中打开扩展目录。只允许程序构建产物与生产依赖进入安装包；`.localpass-data`、SQLite 数据库、私钥、环境文件及工作截图不会进入发布包。

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

为避免 WSL 在终端退出后停止，可在普通 PowerShell 执行以下命令，创建当前用户登录时启动的 `LocalPass-WSL-Downloads` 任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-wsl-downloads.ps1
```

WSL mirrored 网络默认阻止外部入站连接。在管理员 PowerShell 执行以下命令，只放行下载服务的 TCP 18770 端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-wsl-downloads.ps1 -FirewallOnly
```

这不会关闭防火墙。可用 `Remove-NetFirewallHyperVRule -Name LocalPass-Downloads-18770` 撤销规则。主机自身访问局域网 IP 还可能受 WSL 的回环设置影响，验证页面时本机使用 `localhost`，其他电脑使用主机局域网 IP。

## 使用者安装

1. 下载并运行 Windows 安装包，在桌面端注册自己的账号和主密码。
2. 下载并解压扩展 ZIP。Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`。
3. 打开开发者模式，加载解压后的 `chrome-extension` 文件夹。桌面端设置中也提供内置扩展目录入口。
4. 保持桌面端解锁，刷新网站并登录一次。后续可在登录框选择已保存的账号。
5. 更新插件后重新加载扩展，并刷新网站。

Windows 安装版的数据通常位于 `%APPDATA%\localpass\databases`。开发版使用项目的 `.localpass-data/databases`。更新或迁移前保留完整数据目录，并在设置中导出加密备份；当前备份解密需要原密码库的密钥，应一并保留原 `system.db` 与 `user_*.db` 文件。
