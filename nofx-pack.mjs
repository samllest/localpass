#!/usr/bin/env node
/**
 * NOFX Dev Quest 本地打包脚本（§7 / §17）。
 *
 * 产出两个归档：`bundle.tar.gz`（项目 + `.git` + `screenshots/`）和
 * `trajectory.tar.gz`（Claude Code / Codex 的 `.jsonl` 会话）。录屏不在这里，
 * 它单独上传。
 *
 * 三条设计约束，值得先说清楚：
 *
 * 1. **零依赖、单文件。** 这个脚本从 nofx.one 直接下载运行，开发者不会为了交一次
 *    里程碑去装一棵 npm 树；而且它要读的是本机上最敏感的两样东西——项目源码和
 *    完整的会话记录——`curl | node` 一个只有 Node 内置模块的文件，是这里唯一
 *    诚实的分发方式。tar 是手写的，不 shell out 给系统 `tar`：macOS 的 bsdtar 会
 *    塞进 `._` 资源叉和 `PaxHeader` 条目，GNU tar 又是另一套行为，而服务端的读取
 *    器只有一个。自己写 512 字节的头，两边就永远对得上。
 *
 * 2. **先扫描，后落盘。** 密钥扫描跑完之前一个字节都不写。命中就整个中止，不留
 *    半个归档在磁盘上——留下的那个一定会被人上传，然后被服务端拒掉一次尝试。
 *    扫描结果只报 `路径:行号`，从不回显匹配到的文本，和服务端 `secrets.ts` 的
 *    第一条不变量一致：报告本身不能成为泄漏。
 *
 * 3. **门槛在本地先过一遍。** G4（入场编号）、R8（截图数量）、`.env` 脱敏这几条，
 *    服务端判起来是确定的，但判完要消耗一次提交尝试。同样的规则在这里跑一遍，
 *    代价是几秒钟。**特别是 G4**：服务端读的是 `.git/logs/HEAD` 这个 reflog，
 *    而 reflog 只记录提交信息的第一行。写在 commit body 里的编号服务端看不见，
 *    这一条不本地检查，开发者不可能自己想明白。
 *
 * 输出是中文的。开发者被拒时读到的是服务端写的中文句子（"需要 300 行，本次
 * 120 行"），本地脚本说同一种话，两边才是一套词汇。
 *
 * 用法：
 *
 *   node nofx-pack.mjs [--project .] [--out ./nofx-quest] [--nonce NOFX-QUEST-…]
 *
 * `pnpm check` 之类的东西不适用于这个文件：它不参与构建，从 `public/` 原样发出。
 */

import { Buffer } from "node:buffer";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

// --- 与服务端同步的常量 ------------------------------------------------------
//
// 每一组都在服务端有唯一来源，注释里写明是哪一个文件。这些值在两处重复，是分发
// 形式逼出来的——脚本不能 import 一个跑在 Worker 里的 TypeScript 模块——所以
// `tests/unit/dev-quest-pack-script.test.ts` 会把两边逐条比对，漂移了就红。

/** 上传限额（§7）。录屏的 50 MB 不在这里，脚本不碰录屏。 */
export const LIMITS = {
  bundle: 32 * 1024 * 1024,
  trajectory: 32 * 1024 * 1024,
};

/** 截图数量区间（§8）。脚本不知道这次交的是哪个里程碑，所以两个都报。 */
export const SCREENSHOT_RANGES = {
  topup: { min: 2, max: 4 },
  final: { min: 5, max: 8 },
};

/** 与 `src/features/dev-quest/paths.ts` 的 `EXCLUDED_SEGMENTS` 逐条对应。 */
export const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "virtualenv",
  "site-packages",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".eggs",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".angular",
  ".astro",
  ".docusaurus",
  "coverage",
  ".nyc_output",
  "htmlcov",
  "vendor",
  "pods",
  "carthage",
  "deriveddata",
  ".gradle",
  ".dart_tool",
  ".terraform",
  ".serverless",
  ".vagrant",
  ".idea",
]);

/** 与 `paths.ts` 的 `ENV_EXAMPLE_MARKERS` / `ENV_EXAMPLE_NAMES` 对应。 */
export const ENV_EXAMPLE_MARKERS = [
  "example",
  "sample",
  "template",
  "dist",
  "defaults",
  "tpl",
];
export const ENV_EXAMPLE_NAMES = new Set([
  "env.example",
  "env.sample",
  "env.template",
  "environment.example",
]);

/**
 * 与 `src/features/dev-quest/secrets.ts` 的 `BLOCKING_RULES` 逐条对应。
 *
 * 只带阻断级规则。警告级的两条（`generic_assignment` / `database_url`）留给服务
 * 端记进 checks 给人看——在本地把它们变成硬错误，只会让开发者删掉 fixture 里的
 * 假密码，而那不解决任何问题。
 */
export const BLOCKING_SECRET_RULES = [
  {
    id: "aws_access_key_id",
    label: "AWS Access Key ID",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "aws_secret_access_key",
    label: "AWS Secret Access Key",
    pattern: /aws_secret_access_key["'\s]*[:=]["'\s]*[A-Z0-9/+=]{40}/gi,
  },
  {
    id: "openai_api_key",
    label: "OpenAI API Key",
    pattern: /\bsk-(?!ant-)[\w-]{24,}/g,
  },
  {
    id: "anthropic_api_key",
    label: "Anthropic API Key",
    pattern: /\bsk-ant-[\w-]{24,}/g,
  },
  {
    id: "github_token",
    label: "GitHub Token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "google_api_key",
    label: "Google API Key",
    pattern: /\bAIza[\w-]{35}\b/g,
  },
  {
    id: "slack_token",
    label: "Slack Token",
    pattern: /\bxox[abopsr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "stripe_live_key",
    label: "Stripe Live Key",
    pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g,
  },
  {
    id: "private_key_pem",
    label: "PEM 私钥",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    id: "jwt",
    label: "JWT",
    pattern: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  },
];

/** 与 `secrets.ts` 的 `PLACEHOLDER_MARKERS` / `MIN_DISTINCT_CHARS` 对应。 */
export const PLACEHOLDER_MARKERS = [
  "example",
  "placeholder",
  "your",
  "yours",
  "changeme",
  "change-me",
  "replace",
  "redacted",
  "dummy",
  "sample",
  "todo",
  "xxxx",
  "0000",
  "1111",
  "abcdef",
];
const MIN_DISTINCT_CHARS = 8;

/** 与 `secrets.ts` 的 `MAX_SCAN_BYTES` 对应。 */
const MAX_SCAN_BYTES = 1024 * 1024;

/** 真实 `.env` 只贡献键名时，在项目包里使用的文档文件名。 */
const GENERATED_ENV_EXAMPLE = ".nofx-env.generated.example";

/** 与 `paths.ts` 的 `BINARY_SNIFF_BYTES` 对应。 */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** 根目录必须存在的编号文件（`gates.ts` 的 `QUEST_FILE`）。 */
const QUEST_FILE = "NOFX_QUEST.md";

/**
 * `.git` 里服务端真正会读的部分（`manifest.ts` 的 `isReadableGitFile`）。
 *
 * 只在 `--slim-git` 下用来裁剪。默认不裁：`.git` 是证据，交一份能 `git log` 的
 * 完整仓库，比交一份只喂得饱解析器的骨架诚实。
 */
const READABLE_GIT_ROOTS = new Set(["refs", "logs"]);
const READABLE_GIT_FILES = new Set(["HEAD", "packed-refs", "config"]);

// --- 纯函数：分类与扫描 ------------------------------------------------------

/** `paths.ts` 的 `envFileKind`。 */
export function envFileKind(name) {
  const lowered = name.toLowerCase();
  if (ENV_EXAMPLE_NAMES.has(lowered)) return "example";
  if (lowered !== ".env" && !lowered.startsWith(".env.")) return null;
  const marked = ENV_EXAMPLE_MARKERS.some((marker) => lowered.includes(marker));
  return marked ? "example" : "real";
}

/**
 * 只读取 `.env` 的键名，不保留等号右侧的任何内容。
 *
 * 与服务端 `env.ts` 的解析口径保持一致；真实配置永远不会进入归档，只有下面生成的
 * `KEY=` 行会作为 R4 的环境配置示例。
 */
export function parseEnvKeys(content) {
  const keys = new Set();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) continue;
    const key = withoutExport.slice(0, equals).trim();
    if (
      key.length > 0 &&
      key.length <= 128 &&
      !/^\d/.test(key) &&
      /[a-z]/i.test(key) &&
      /^[\w.]+$/.test(key)
    ) {
      keys.add(key);
    }
  }
  return keys;
}

/** `paths.ts` 的 `looksBinary`。 */
export function looksBinary(bytes) {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/** `image-sniff.ts` 的 `sniffImageType`。截图靠魔数认，不靠扩展名。 */
export function sniffImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** `secrets.ts` 的 `looksLikePlaceholder`。 */
export function looksLikePlaceholder(match) {
  const lowered = match.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker))) {
    return true;
  }
  return new Set(lowered).size < MIN_DISTINCT_CHARS;
}

/**
 * `secrets.ts` 的 `scanForSecrets`，只跑阻断级规则。
 *
 * 返回的 finding 里没有 `match` 字段，这是刻意的：整条链路——扫描、报告、终端
 * 输出——都不该持有那段文本。
 */
export function scanForSecrets(filePath, content) {
  const scanned =
    content.length > MAX_SCAN_BYTES
      ? content.slice(0, MAX_SCAN_BYTES)
      : content;
  const findings = [];
  const seen = new Set();
  let starts = null;

  for (const rule of BLOCKING_SECRET_RULES) {
    for (const match of scanned.matchAll(rule.pattern)) {
      if (match.index == null) continue;
      if (looksLikePlaceholder(match[0])) continue;
      starts ??= lineStarts(scanned);
      const line = lineNumberAt(starts, match.index);
      const key = `${rule.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ rule: rule.id, label: rule.label, path: filePath, line });
    }
  }
  return findings;
}

function lineStarts(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * `git.ts` 的 `parseReflogLine`，只取这里用得到的三个字段。
 *
 * 按字段切而不是一条正则：身份里有空格，让惰性组去吞会切错 `Jean-Luc de la
 * Fontaine` 这种名字。前面两个 sha，后面时间戳和时区，中间全是身份。
 */
export function parseReflogLine(line) {
  const tab = line.indexOf("\t");
  const left = tab === -1 ? line : line.slice(0, tab);
  const right = tab === -1 ? "" : line.slice(tab + 1);

  const tokens = left.split(" ").filter((token) => token.length > 0);
  if (tokens.length < 5) return null;
  const timestamp = tokens.at(-2);
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;

  const colon = right.indexOf(": ");
  const action = colon === -1 ? right.trim() : right.slice(0, colon).trim();
  const message = colon === -1 ? "" : right.slice(colon + 2).trim();
  return { at: new Date(seconds * 1000), action, message };
}

// --- tar 写入 ----------------------------------------------------------------

const BLOCK = 512;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/**
 * 一个 ustar 头。
 *
 * 校验和的算法是：把 148..156 这八个字节当成空格算总和，再写回去。这条规矩看着
 * 随意，但它是 tar 唯一的自检机制，服务端 `tar.ts` 的 `checksumMatches` 就靠它
 * 判断流有没有失步。
 */
function header({ name, size, mode, mtime, typeflag }) {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode & 0o7777, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(typeflag, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/**
 * 一个条目的所有块。
 *
 * 名字超过 100 字节时先发一个 GNU `L` 头把全名放进 body——ustar 的 `prefix`
 * 字段只能在斜杠处切，切不动一个 120 字节的单段路径，而 `L` 没有这个限制。
 * `tar.ts` 认这个 typeflag（`flag === "L"` 那一支）。
 */
export function tarEntry({ name, body, mode = 0o644, mtime = 0 }) {
  const chunks = [];
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 100) {
    const marker = "././@LongLink";
    const payload = Buffer.concat([nameBytes, Buffer.from([0])]);
    chunks.push(
      header({
        name: marker,
        size: payload.length,
        mode: 0o644,
        mtime: 0,
        typeflag: "L",
      }),
      payload,
      padding(payload.length),
    );
  }
  chunks.push(
    header({
      // 长名条目里这个字段被截断是允许的，真正的路径已经在 `L` body 里。
      name: nameBytes.subarray(0, 100).toString("utf8"),
      size: body.length,
      mode,
      mtime,
      typeflag: "0",
    }),
    body,
    padding(body.length),
  );
  return chunks;
}

/** 结束标记：两个全零块。 */
export function tarEnd() {
  return Buffer.alloc(BLOCK * 2);
}

/**
 * 把一组文件写成 gzip 压缩的 tar。
 *
 * 逐个读、逐个写，任何时候堆上只有一个文件的内容。一个装了大量截图的项目包
 * 解压后可以到几百兆，全读进内存跑不动。
 */
async function writeTarball(target, files, onProgress) {
  const gzip = zlib.createGzip({ level: 9 });
  const finished = pipeline(gzip, fs.createWriteStream(target));

  const push = async (chunk) => {
    if (!gzip.write(chunk)) await once(gzip, "drain");
  };

  for (const file of files) {
    const body = file.body ?? (await fsp.readFile(file.absolute));
    for (const chunk of tarEntry({
      name: file.path,
      body,
      mode: file.mode,
      mtime: file.mtime,
    })) {
      await push(chunk);
    }
    onProgress?.(file);
  }
  await push(tarEnd());
  gzip.end();
  await finished;
  const { size } = await fsp.stat(target);
  return size;
}

// --- 目录遍历 ----------------------------------------------------------------

/**
 * 走一遍项目，产出要打包的文件清单。
 *
 * 符号链接整条跳过：tar 里的链接对服务端毫无价值（`manifest.ts` 只是数一下），
 * 而跟随它可能把 `node_modules` 外面的整棵树拖进来。
 */
export async function collectProject(root, { slimGit }) {
  const files = [];
  const excluded = new Map();
  const envFiles = [];
  const envKeys = new Set();
  const screenshots = [];

  async function walk(directory, relative) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new PackError(`无法读取目录 ${relative || "."}：${error.message}`);
    }
    for (const entry of entries) {
      const name = entry.name;
      const relativePath = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);

      if (entry.isSymbolicLink()) continue;

      const segments = relativePath.split("/");
      const insideGit = segments[0] === ".git";

      if (entry.isDirectory()) {
        if (!insideGit && EXCLUDED_SEGMENTS.has(name.toLowerCase())) {
          excluded.set(relativePath, (excluded.get(relativePath) ?? 0) + 1);
          continue;
        }
        if (insideGit && slimGit && !keepSlimGitPath(segments)) continue;
        await walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (insideGit && slimGit && !keepSlimGitPath(segments)) continue;

      if (!insideGit && envFileKind(name) === "real") {
        envFiles.push(relativePath);
        const content = (await readHead(absolute, MAX_SCAN_BYTES)).toString(
          "utf8",
        );
        for (const key of parseEnvKeys(content)) envKeys.add(key);
        continue;
      }

      const stats = await fsp.stat(absolute);
      const file = {
        path: relativePath,
        absolute,
        size: stats.size,
        mode: stats.mode,
        mtime: stats.mtimeMs,
        git: insideGit,
      };
      files.push(file);

      // 截图的判定跟服务端一致：位置对（`screenshots/` 在根下）且魔数对。
      if (segments[0] === "screenshots" && segments.length > 1) {
        const head = await readHead(absolute, 12);
        if (sniffImageType(head)) screenshots.push(relativePath);
      }
    }
  }

  await walk(root, "");
  let generatedEnvExample = null;
  if (envKeys.size > 0) {
    const occupied = new Set(files.map((file) => file.path));
    generatedEnvExample = GENERATED_ENV_EXAMPLE;
    for (let suffix = 2; occupied.has(generatedEnvExample); suffix += 1) {
      generatedEnvExample = `.nofx-env.generated-${suffix}.example`;
    }
    const body = Buffer.from(
      `${[...envKeys]
        .sort()
        .map((key) => `${key}=`)
        .join("\n")}\n`,
      "utf8",
    );
    files.push({
      path: generatedEnvExample,
      absolute: null,
      body,
      size: body.length,
      mode: 0o644,
      mtime: 0,
      git: false,
      generated: true,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    excluded: [...excluded.keys()].sort(),
    envFiles,
    envKeys: [...envKeys].sort(),
    generatedEnvExample,
    screenshots,
  };
}

/**
 * `--slim-git` 下 `.git` 里保留的路径，与 `isReadableGitFile` 同构。
 *
 * `refs` 和 `logs` 先判，且不看深度——它们既是目录也是要保留的整棵子树，而遍历
 * 会先拿着 `.git/logs` 这个目录本身来问一次。按 `tail.length === 1` 去分文件和
 * 目录会在那一问上答错，把整个 reflog 裁掉，交上去必挂 G4。
 */
function keepSlimGitPath(segments) {
  const tail = segments.slice(1);
  const head = tail[0];
  if (!head) return true;
  if (READABLE_GIT_ROOTS.has(head)) return true;
  return tail.length === 1 && READABLE_GIT_FILES.has(head);
}

async function readHead(absolute, bytes) {
  const handle = await fsp.open(absolute, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 扫描清单里的每个文本文件。
 *
 * 每个文件只读前 1 MB——服务端也只扫这么多，本地扫得更深会得到一份服务端不会
 * 复现的拒绝，那比不扫更糟。
 */
async function scanFiles(files) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (file.size === 0) continue;
    if (file.body) {
      const buffer = file.body.subarray(0, MAX_SCAN_BYTES);
      if (looksBinary(buffer)) continue;
      scanned += 1;
      findings.push(...scanForSecrets(file.path, buffer.toString("utf8")));
      continue;
    }
    const handle = await fsp.open(file.absolute, "r");
    try {
      const length = Math.min(file.size, MAX_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (looksBinary(buffer)) continue;
      scanned += 1;
      findings.push(...scanForSecrets(file.path, buffer.toString("utf8")));
    } finally {
      await handle.close();
    }
  }
  return { findings, scanned };
}

// --- 会话轨迹 ----------------------------------------------------------------

/** Claude Code 的目录名：把绝对路径里的非字母数字全换成连字符。 */
function claudeProjectSlug(projectPath) {
  return projectPath.replace(/[^a-z0-9]/gi, "-");
}

/**
 * 找出属于这个项目的会话文件。
 *
 * 两个来源，判定方式相同：读文件开头的若干行，看里面报的工作目录是不是这个项目。
 * Claude Code 的目录名本身就是 slug 化的路径，可以直接命中；但一个会话可以横跨
 * 多个 `cwd`（`trajectory.ts` 在真实样本里见过八个这样的文件），所以两边都还是
 * 读一遍内容确认，目录名只当快路径用。
 */
async function findSessions(projectPath, { since, home }) {
  const roots = [
    { kind: "claude-code", dir: path.join(home, ".claude", "projects") },
    { kind: "codex", dir: path.join(home, ".codex", "sessions") },
  ];
  const found = [];
  let skippedOld = 0;
  let scanned = 0;

  for (const root of roots) {
    if (!(await exists(root.dir))) continue;
    const slug = claudeProjectSlug(projectPath);
    for await (const absolute of walkFiles(root.dir)) {
      if (!absolute.toLowerCase().endsWith(".jsonl")) continue;
      const stats = await fsp.stat(absolute);
      if (stats.mtimeMs < since) {
        skippedOld += 1;
        continue;
      }
      scanned += 1;
      const fast =
        root.kind === "claude-code" && path.dirname(absolute).endsWith(slug);
      if (fast || (await mentionsCwd(absolute, projectPath))) {
        found.push({ kind: root.kind, absolute, size: stats.size });
      }
    }
  }
  found.sort((a, b) => (a.absolute < b.absolute ? -1 : 1));
  return { sessions: found, skippedOld, scanned };
}

/** 前 256 KB 里有没有一个 `cwd` 落在项目里。 */
async function mentionsCwd(absolute, projectPath) {
  const head = await readHead(absolute, 256 * 1024);
  const text = head.toString("utf8");
  const prefix = `${projectPath}/`;
  for (const line of text.split("\n")) {
    if (!line.includes(`"cwd"`)) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // 截断的最后一行，或者一行坏 JSON。会话文件是追加写的，这很正常。
      continue;
    }
    const candidates = [row?.cwd, row?.payload?.cwd];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (candidate === projectPath || candidate.startsWith(prefix))
        return true;
    }
  }
  return false;
}

async function* walkFiles(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

// --- 门槛预检 ----------------------------------------------------------------

class PackError extends Error {}

/**
 * G4 的本地复现。
 *
 * 服务端读的是 reflog，不是 `git log`，而 reflog 只保留提交信息的第一行。这个
 * 差别是这个脚本存在的最大理由之一：`git commit -m "feat: x" -m "NOFX-QUEST-…"`
 * 在 `git log` 里看得见编号，在服务端看不见，交上去必挂 G4 并吃掉一次尝试。
 */
export async function checkNonce(root, nonce) {
  const questPath = path.join(root, QUEST_FILE);
  if (!(await exists(questPath))) {
    throw new PackError(
      `根目录缺少 ${QUEST_FILE}。新建一个，把入场编号写进去（一行即可）。`,
    );
  }
  const questText = await fsp.readFile(questPath, "utf8");
  const resolved = nonce ?? questText.match(/NOFX-QUEST-[0-9A-Z]{6,}/i)?.[0];
  if (!resolved) {
    throw new PackError(
      `${QUEST_FILE} 里找不到入场编号。编号形如 NOFX-QUEST-XXXXXXXXXX，在任务页面上。`,
    );
  }
  const needle = resolved.toLowerCase();
  if (!questText.toLowerCase().includes(needle)) {
    throw new PackError(`${QUEST_FILE} 不含编号 ${resolved}。`);
  }

  const logPath = path.join(root, ".git", "logs", "HEAD");
  if (!(await exists(logPath))) {
    throw new PackError(
      [
        "读不到 .git/logs/HEAD，服务端的提交历史就是从这里来的。两种常见原因：",
        "· 这个目录是 git clone 出来的干净副本 —— 请打包你实际开发的那个仓库",
        "· core.logAllRefUpdates 被关掉了 —— 打开它，之后的提交才会被记录",
      ].join("\n"),
    );
  }
  const commits = (await fsp.readFile(logPath, "utf8"))
    .split("\n")
    .map((line) => parseReflogLine(line))
    .filter((entry) => entry?.action.startsWith("commit"));

  if (commits.length === 0) {
    throw new PackError(
      "reflog 里没有任何提交记录，只有 clone 或 checkout。服务端会判定这份历史不是本地写出来的。",
    );
  }
  const tagged = commits.filter((entry) =>
    entry.message.toLowerCase().includes(needle),
  );
  if (tagged.length === 0) {
    throw new PackError(
      [
        `${commits.length} 个提交的标题里都没有编号 ${resolved}。`,
        "注意服务端读的是 reflog，只保留提交信息的第一行——写在 commit body 里不算。",
        `补一个就够：git commit --allow-empty -m "${resolved} 里程碑打包"`,
      ].join("\n"),
    );
  }
  return { nonce: resolved, commits: commits.length, tagged: tagged.length };
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `NOFX Dev Quest 打包脚本

  node nofx-pack.mjs [选项]

选项
  --project <dir>   项目根目录，默认当前目录
  --out <dir>       归档输出目录，默认 ./nofx-quest-out
  --nonce <编号>    入场编号，默认从 NOFX_QUEST.md 里读
  --since <日期>    只收这个日期之后的会话文件，默认 30 天前
  --no-trajectory   跳过会话轨迹，只打项目包
  --slim-git        .git 只保留服务端会读的部分（HEAD / config / packed-refs
                    / refs / logs）。项目包超限时的退路，默认不裁。
  --help            显示这段说明

产出 bundle.tar.gz 与 trajectory.tar.gz。运行录屏不打包，在页面上单独上传。`;

export function parseArgs(argv) {
  const options = {
    project: process.cwd(),
    out: path.resolve("nofx-quest-out"),
    nonce: null,
    since: Date.now() - 30 * 86_400_000,
    trajectory: true,
    slimGit: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new PackError(`${arg} 后面缺少参数`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--project":
        options.project = path.resolve(next());
        break;
      case "--out":
        options.out = path.resolve(next());
        break;
      case "--nonce":
        options.nonce = next();
        break;
      case "--since": {
        const parsed = Date.parse(next());
        if (Number.isNaN(parsed)) throw new PackError("--since 不是合法日期");
        options.since = parsed;
        break;
      }
      case "--no-trajectory":
        options.trajectory = false;
        break;
      case "--slim-git":
        options.slimGit = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new PackError(`未知参数 ${arg}（--help 看用法）`);
    }
  }
  return options;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    say(USAGE);
    return 0;
  }

  const root = options.project;
  if (!(await exists(path.join(root, ".git")))) {
    throw new PackError(`${root} 不是一个 git 仓库（找不到 .git）。`);
  }

  say(`项目：${root}`);
  const nonceFacts = await checkNonce(root, options.nonce);
  say(
    `入场编号：${nonceFacts.nonce}（${QUEST_FILE} ✓，${nonceFacts.tagged}/${nonceFacts.commits} 个提交标题带编号 ✓）`,
  );

  const project = await collectProject(root, { slimGit: options.slimGit });
  if (project.envFiles.length > 0) {
    const detail = project.generatedEnvExample
      ? `仅提取 ${project.envKeys.length} 个键到 ${project.generatedEnvExample} ✓`
      : "未解析到可生成示例的键";
    say(
      `环境配置：已排除 ${project.envFiles.length} 个真实 .env 文件；${detail}`,
    );
  }

  const shots = project.screenshots.length;
  const { topup, final } = SCREENSHOT_RANGES;
  if (shots < topup.min) {
    throw new PackError(
      [
        `screenshots/ 下只找到 ${shots} 张有效截图（PNG / JPEG / WebP，按魔数认，不看扩展名）。`,
        `追加里程碑要 ${topup.min}–${topup.max} 张，终验要 ${final.min}–${final.max} 张。`,
      ].join("\n"),
    );
  }
  say(
    `截图：${shots} 张（追加 ${topup.min}–${topup.max}，终验 ${final.min}–${final.max}）`,
  );

  const scan = await scanFiles(project.files);
  if (scan.findings.length > 0) {
    throw new PackError(
      [
        "扫到疑似密钥，已中止，没有写出任何归档。请先在本地删除或替换：",
        ...scan.findings
          .slice(0, 20)
          .map((f) => `· ${f.path}:${f.line} — ${f.label}`),
        scan.findings.length > 20
          ? `· 以及另外 ${scan.findings.length - 20} 处`
          : null,
        "",
        "提醒：git 历史里的密钥同样会被扫到。改当前文件不够，历史要一起清。",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  say(`密钥扫描：${scan.scanned} 个文本文件，未命中阻断规则 ✓`);

  await fsp.mkdir(options.out, { recursive: true });
  const bundlePath = path.join(options.out, "bundle.tar.gz");
  const bundleBytes = await writeTarball(bundlePath, project.files);
  const gitFiles = project.files.filter((file) => file.git).length;
  say(
    `项目包：${bundlePath}（${mb(bundleBytes)}，${project.files.length} 个文件，其中 .git ${gitFiles} 个）`,
  );
  if (project.excluded.length > 0) {
    const shown = project.excluded.slice(0, 5).join("、");
    const more =
      project.excluded.length > 5 ? ` 等 ${project.excluded.length} 处` : "";
    say(`  已排除依赖与构建产物：${shown}${more}`);
  }

  let trajectoryBytes = 0;
  let trajectoryPath = null;
  if (options.trajectory) {
    const found = await findSessions(root, {
      since: options.since,
      home: os.homedir(),
    });
    if (found.sessions.length === 0) {
      throw new PackError(
        [
          `在 ~/.claude/projects 和 ~/.codex/sessions 里找不到属于 ${root} 的会话记录`,
          `（看了 ${found.scanned} 个文件，另有 ${found.skippedOld} 个太旧被跳过——用 --since 放宽）。`,
          "如果开发用的是别的机器或别的工具，把 .jsonl 会话文件收进一个目录，",
          "自己打成 trajectory.tar.gz 上传即可；--no-trajectory 可以跳过这一步。",
        ].join("\n"),
      );
    }

    // 轨迹里是开发者写下的每一句 prompt 和读过的每一段代码，密钥出现在这里的
    // 概率比出现在源码里高。服务端只扫项目包，不扫轨迹——这一遍是唯一的一遍。
    const sessionFiles = found.sessions.map((session) => ({
      path: `${session.kind}/${path.basename(session.absolute)}`,
      absolute: session.absolute,
      size: session.size,
      mode: 0o644,
      mtime: 0,
    }));
    const sessionScan = await scanFiles(sessionFiles);
    if (sessionScan.findings.length > 0) {
      throw new PackError(
        [
          "会话轨迹里扫到疑似密钥，已中止。轨迹会原样上传，所以这里不能放过：",
          ...sessionScan.findings
            .slice(0, 20)
            .map((f) => `· ${f.path}:${f.line} — ${f.label}`),
          "",
          "对应的会话文件在 ~/.claude/projects 或 ~/.codex/sessions 下，同名可查。",
          "删掉那几个会话文件，或者用 --since 把它们排除在窗口外，再重跑。",
        ].join("\n"),
      );
    }

    trajectoryPath = path.join(options.out, "trajectory.tar.gz");
    trajectoryBytes = await writeTarball(trajectoryPath, sessionFiles);
    const kinds = new Set(found.sessions.map((session) => session.kind));
    say(
      `会话轨迹：${trajectoryPath}（${mb(trajectoryBytes)}，${found.sessions.length} 个会话，来自 ${[...kinds].join(" + ")}）`,
    );
  }

  const oversize = [
    bundleBytes > LIMITS.bundle ? ["项目包", bundleBytes, LIMITS.bundle] : null,
    trajectoryBytes > LIMITS.trajectory
      ? ["会话轨迹", trajectoryBytes, LIMITS.trajectory]
      : null,
  ].filter(Boolean);

  if (oversize.length > 0) {
    say();
    for (const [label, actual, limit] of oversize) {
      say(`⚠ ${label} ${mb(actual)}，超过 ${mb(limit)} 上限，上传会被拒。`);
    }
    if (bundleBytes > LIMITS.bundle && !options.slimGit) {
      say(
        "  项目包超限时先看 .git 的体积：--slim-git 只保留服务端会读的那几个文件",
      );
      say(
        "  （HEAD / config / packed-refs / refs / logs），通常能省下大部分。",
      );
    }
    return 1;
  }

  say();
  if (trajectoryPath) {
    say(
      "下一步：在任务页面上传这两个文件，另外单独上传运行录屏（≥10 秒，≤50 MB）。",
    );
  } else {
    // --no-trajectory 跳过的是打包，不是这一项：三样上传物缺一样，提交交不上去。
    say(
      "下一步：在任务页面上传项目包。会话轨迹这次没打——自己收一份 .jsonl 打成",
    );
    say("tar.gz 一并上传，另外单独上传运行录屏（≥10 秒，≤50 MB）。");
  }
  say("录屏前请关掉无关窗口和通知——这是整个流程里最容易连带泄露隐私的一项。");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof PackError) {
        process.stderr.write(`\n${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    });
}

export { main, PackError };
