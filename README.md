# dsh-qwen-image

把阿里云百炼的 **qwen-image** 生图 / 改图能力接入 DeepSeek Harness：注册
`generate_image` 生图工具，以及 `list_generated_images` 历史列表工具。图片下载到当前工作区，并尽量在聊天里直接预览。

当前版本：**0.5.2**（Windows only，DSH `>=0.2.1-rc.5`）。

## 能力

- **文生图**：只给 `prompt`。
- **参考图改图**：给 `image`（1~3 张，工作区路径 / HTTPS URL / `data:image/...`）。
- **一次多张**：`n: 1~6`，并校验服务端实际返回数量。
- **尺寸与复现**：`size`（`1024*1024` 或 `1024x1024`）、`seed`、`negative_prompt`、`prompt_extend`、`watermark`。
- **聊天预览**：生成图通过 DSH attachment 服务返回图片内容块；不支持时自动降级为路径。
- **可靠落盘**：本地时区毫秒时间戳 + 随机串 + 序号，`wx` 独占创建，不覆盖已有文件。
- **可追溯**：每张图默认写同名 `.json` 旁车，含 prompt、模型、seed、request id、usage、sha256、实际宽高。
- **错误恢复**：生图 429/5xx 与下载临时失败会退避重试；单张下载失败保留其余成功图。
- **下载边界**：只信任百炼/阿里云/`baseURL` 主机，重定向目标在请求前再次校验，避免跳到未信任域名。
- **成本护栏**：`dry_run` 免费校验参数；工具描述明确会调用付费接口；`usage`/`request_id` 会返回。
- **每日图片额度**：可选 `maxImagesPerDay`，按本地日期预占/结算，超额在请求前拒绝；默认 0 不限，只数张数、不估算金额。
- **历史列表**：`list_generated_images` 读取旁车 JSON，返回最近生成的图片路径、模型、尺寸、seed、提示词摘要；只读、不花钱。
- **严格输入**：未知参数、越界 `size`、越界 `n`、非法模型和不安全路径都会在请求前拒绝。
- **设置页**：`Config` 是原生兼容的 schemastery 图，支持在设置页改字段并热更新，不必改文件重启。
- **不包含 API Key**：Key 由每位使用者自己配置。

## 安装 / 更新

0.5.2 起安装器只支持 Windows。安装/更新逻辑在 `install.mjs`，
`install.cmd` / `update.cmd` / `check.cmd` / `check-update.cmd` / `uninstall.cmd`
只是负责找 Node 并转发参数的启动器。

### 第一次安装（推荐）

1. **完全退出 DeepSeek Harness**（不是只关窗口）。
2. 解压 zip，得到 `dsh-qwen-image` 文件夹。
3. 双击 `install.cmd`。
4. 按提示粘贴百炼 API Key；不想现在配就直接回车，之后在设置页填。
5. 启动 DeepSeek Harness，在 **设置 → 插件 → qwen-image** 确认工具和配置出现。

安装器会：

1. 把插件复制到 `<DSH home>/plugins/dsh-qwen-image`；
2. 用 dsh 自带的 pnpm 把本地目录装进 profile（`link:` 或 `file:`）；
3. 把 `dsh-qwen-image` 追加到 profile 的 `dsh.profile.bundles`；
4. 可选地把 Key 写进 `<DSH home>/.env`，权限尽量设为仅当前用户可读；
5. 没有 `node` 时，启动器会尝试用 DeepSeek Harness 自带 Electron 运行时执行
   `install.mjs`（`ELECTRON_RUN_AS_NODE=1`）。

> 启动器只是入口，安装/更新不会联网下载代码。代码全部来自你解压的这份 zip；
> 只有 `check-update` 会访问 GitHub Releases 的清单。
> 如果 Node 和 DSH 都不在标准位置，可先设置 `DSH_APP` 指向 Harness 可执行文件，
> 或直接用 `node install.mjs`。

### 更新（傻瓜式）

1. **完全退出 DeepSeek Harness**；
2. 解压新 zip 到**其他目录**（不要覆盖旧目录，也不要在
   `%USERPROFILE%\.dsh\plugins\dsh-qwen-image` 里运行更新器）；
3. 双击新目录里的 `update.cmd`。

> 更新器会拒绝从已安装目录运行 `--upgrade`，避免出现“提示成功但没有替换”的假更新。
> 如果看到 `QWEN_INSTALL_SAME_DIR`，把新 zip 解压到 Downloads 等位置再运行即可。

更新器会：

- 读取新旧 `package.json` 版本；同版本会提示，降级默认拒绝（确认要降级加 `--force`）；
- 把旧插件目录改名为 `dsh-qwen-image.bak`，再原子替换；下一次成功更新会先删除旧的 `.bak`，只保留最近一份；
- 备份 profile 的 `package.json` 为 `package.json.bak`；
- 删除新版已移除的旧文件，但保留 `generated/`、用户自己放的文件和 `.env`；
- 默认不询问、不覆盖 API Key；
- 更新 profile 依赖和 `dsh.profile.bundles`，重复运行不会重复追加。

更新后运行一次本地检查，再启动 DSH：

```powershell
node .\selftest.mjs
node .\regression.mjs
node .\installer.test.mjs
```

**更新后必须完全重启宿主**（host 插件在启动时加载，刷新网页不够）。

### 检查新版本（GitHub Releases）

0.5.2 起支持从 GitHub Releases 读取 `latest.json`。发布仓库需要一次配置：

1. 把 `update-source.json` 的模板地址改成自己的仓库：

   ```json
   {
     "manifestUrl": "https://github.com/<owner>/<repo>/releases/latest/download/latest.json",
     "allowedHosts": [
       "github.com",
       "objects.githubusercontent.com",
       "release-assets.githubusercontent.com",
       "raw.githubusercontent.com"
     ]
   }
   ```

2. 推送 `v0.5.2` 这类 tag。仓库里的
   `.github/workflows/release.yml` 会调用 `release.ps1`，构建 zip、SHA256 和
   `latest.json`，并创建 GitHub Release。

3. 安装端双击 `check-update.cmd`，或运行：

   ```powershell
   node .\install.mjs --check-update
   ```

   它只读取 `latest.json` 并比较版本，不下载、不安装、不调用百炼接口。

4. 想顺便下载并校验新包：

   ```powershell
   node .\install.mjs --download-update
   ```

   下载到 `%TEMP%\dsh-qwen-image-updates\<version>\`，校验 SHA256 后停止；
   仍需你自己解压并运行新目录里的 `update.cmd`。

`latest.json` 至少包含：

```json
{
  "version": "0.5.2",
  "url": "https://github.com/<owner>/<repo>/releases/latest/download/dsh-qwen-image-0.5.2.zip",
  "sha256": "<64 位十六进制>",
  "publishedAt": "2026-11-20",
  "notes": "更新说明"
}
```

安装器只接受 HTTPS，且域名必须在 `update-source.json` 的 `allowedHosts` 中；
本机 `http://127.0.0.1` 仅为离线测试保留。私有仓库不能直接用
`releases/latest/download`，因为安装器不会内置 token。临时换源也可以用
`--update-url <url>` 或环境变量 `QWEN_UPDATE_URL`。

### 检查安装状态

不确定有没有装好、有没有备份、Key 是否配置时，双击 `check.cmd`，或运行：

```powershell
node .\install.mjs --check --profile desktop
```

它只读不写，也不会调用百炼接口；会显示包版本、已安装版本、插件目录、`.bak`、
profile 依赖/bundle、环境变量/`.env` 中的 Key 和安装锁状态。设置页/credentials 里的 Key
不会显示在这里。

### 回滚 / 卸载

```powershell
node .\install.mjs --rollback --profile desktop
```

回滚会把 `dsh-qwen-image.bak` 恢复为正式目录，并在存在 `package.json.bak` 时恢复 profile 清单；
然后重启 DSH。

```powershell
node .\install.mjs --uninstall --profile desktop
```

也可以双击 `uninstall.cmd`（默认卸载 `desktop` profile，保留插件目录、Key 和图片）。

默认只从 profile 移除依赖和 bundle，保留插件目录、Key、图片和额度记录。确认要清理时再加：

| 参数 | 作用 |
|---|---|
| `--purge` | 删除插件目录和 `qwen-image-usage.json`；workspace 的 `generated/` 不受影响（除非输出目录就在插件目录内） |
| `--remove-key` | 从 `<DSH home>/.env` 删除 `DASHSCOPE_API_KEY` |

### 命令行参数

在插件目录运行 `node install.mjs --help` 可看完整列表。常用：

| 参数 | 作用 |
|---|---|
| `--check` | 只检查安装状态，不写文件、不调用 dsh |
| `--check-update` | 读取 GitHub Releases 清单，检查是否有新版；只读网络 |
| `--download-update` | 有新版时下载 zip 到临时目录并校验 SHA256，不自动安装 |
| `--update-url <url>` | 覆盖 `update-source.json` 中的清单地址，便于测试或换源 |
| `--upgrade` | 更新已有安装；备份旧版本，默认不碰 Key |
| `--rollback` | 恢复最近一次更新前的插件目录和 profile |
| `--uninstall` | 从 profile 移除插件，默认保留插件目录 |
| `--profile <name>` | 指定 profile；可重复或逗号分隔；省略时扫描已存在的 profile |
| `--dsh-home <dir>` | 指定 DSH home；默认 `%DSH_HOME%` 或 `%USERPROFILE%\.dsh` |
| `--profile-root <dir>` | 指定 profiles 目录；默认 `<DSH home>/profiles` |
| `--dsh-path <file>` | 指定 dsh CLI；否则从 PATH 和常见安装位置查找 |
| `--source <dir>` | 指定插件源目录；默认脚本所在目录 |
| `--api-key <key>` | 写入 `<DSH home>/.env`；不建议在共享终端使用 |
| `--prompt-key` | 在终端询问 Key |
| `--skip-key` | 不配置 Key |
| `--skip-install` | 只复制文件和更新 bundle，不执行 `dsh plugin add` |
| `--dry-run` | 只打印计划，不写文件、不执行 pnpm |
| `--json` | 输出机器可读 JSON，便于 Agent 或脚本判断 |
| `--force` | 允许同版本重装或降级 |

### 手动安装

如果不想运行安装器，也可以手动做两步：

```powershell
dsh plugin --profile desktop add "file:C:/Users/<你>/.dsh/plugins/dsh-qwen-image"
```

然后编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，把 `dsh-qwen-image`
加入 `dsh.profile.bundles`，再重启宿主。单独 `dsh plugin add` **不够**，因为 host 插件
还要在 bundle 列表里才会被加载。

### 旧版 Windows 安装脚本

`install.ps1` 仍然保留，仅用于旧版 Windows 流程；新用户优先用 `install.cmd`。
它没有版本检查、备份和回滚能力。

## 配置 API Key

去 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 创建 API-KEY（`sk-` 开头）。
不要使用别人的 Key，也不要把自己的 Key 发给别人。

推荐任选一种：

1. 安装时由 `install.cmd` 写入 `<DSH home>/.env`：

   ```dotenv
   DASHSCOPE_API_KEY=sk-你的key
   ```

2. 设置页：**设置 → 插件 → qwen-image → API Key**。这是 `role: secret` 字段，保存后按 `volatile` 热更新。

3. 环境变量：

   ```powershell
   setx DASHSCOPE_API_KEY "sk-你的key"
   ```

Key 的查找顺序：

1. 插件配置里的 `apiKey`（设置页 / profile patch；会明文落盘）
2. 宿主 `credentials` 服务里的同名引用（若可用）
3. 环境变量（变量名由 `apiKeyEnv` 决定，默认 `DASHSCOPE_API_KEY`）
4. `%USERPROFILE%\.dsh\.env` 里的同名变量
5. `%USERPROFILE%\.dsh\.credentials.yaml` 里的同名变量

区域要一致：北京用 `https://dashscope.aliyuncs.com`，新加坡用
`https://dashscope-intl.aliyuncs.com`。北京 Key 配新加坡端点会报 `InvalidApiKey`。

## 验证（不花钱）

```powershell
node .\selftest.mjs
node .\regression.mjs
node .\installer.test.mjs
```

- `selftest.mjs`：加载入口、检查 `Config`、参数/输出 schema、两个工具的注册和 `output.render`，不访问网络。
- `regression.mjs`：本地 HTTP mock，覆盖配置校验、size/env 解析、目录越界、参考图校验、
  下载重试、部分失败、旁车 JSON、历史列表、每日额度、生图请求体、usage/request_id、dry-run、附件内容块，
  共 28 项，**不调用付费接口**。
- `installer.test.mjs`：临时 `DSH_HOME` + 假 dsh，覆盖首次安装、更新保留数据、`link:` 依赖、
  版本降级保护、回滚、dry-run、`--skip-install`、卸载、Windows 双击入口、检查更新、下载更新
  和帮助/版本，共 14 项，**不碰真实 profile**。

真正出图（会消耗额度）：

```powershell
.\smoke.ps1 "一只戴宇航头盔的橘猫，扁平插画风"
```

在对话里也可以先让模型用 `dry_run: true` 免费校验一次：
“先生成 2 张 1024*1024 的猫，用 dry_run 看看参数”。

## 用法

- “画一只戴宇航头盔的橘猫，扁平插画风”
- “把这张图的背景换成雪山日落” + 提供工作区内的图片路径
- “一次出 4 张 1536*1024 的横图，seed 固定为 42”
- “先 dry_run，确认参数再真跑”

输出示例：

```
已生成 2 张图片（qwen-image-3.0, 1024*1024），请求 2 张。
- C:\work\generated\qwen-20261108-123456-789-a1b2c3-1.png（实际 1024×1024）
- C:\work\generated\qwen-20261108-123456-789-a1b2c3-2.png（实际 1024×1024）
request_id: ...
usage: ...
```

原图 URL 只有 24 小时有效，插件会立即下载；长期保存请使用本地文件。
多张下载中若有单张失败，成功项保留，失败项在结果的 `failed` / `warnings` 中可见；成功图的旁车 JSON 记录各自元数据。

### 查看历史

直接说“看看最近生成了哪些图”，模型可以调用 `list_generated_images`。它只读本地旁车 JSON，
不调用百炼；默认查看配置的 `dir`，也可以指定目录。

| 参数 | 必填 | 说明 |
|---|---|---|
| `dir` | 否 | 工作区内目录；默认使用配置 `dir` |
| `limit` | 否 | 最多返回 1~100 张，默认 10 |

返回 `dir`、`total`、`truncated` 和 `items`；每项含 `file`、`name`、`savedAt`、`bytes`，
以及可用的 `model`、`size`、`width`、`height`、`seed`、`requestId`、`prompt`。
只有写了旁车 JSON 的图片会出现；旧版本手动放进目录的图不会被索引。

### 工具参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 中英文均可；建议写清主体、风格、构图、光线 |
| `size` | 否 | `1024*1024` / `1024x1024`；单边 512~2048，总像素 512²~2048²，宽高比 1:8~8:1；省略由模型决定 |
| `n` | 否 | 1~6，默认 1；还受配置 `maxImagesPerCall` 限制 |
| `negative_prompt` | 否 | 仅 `qwen-image-3.0` / `3.0-pro` 支持，其他模型会明确报错；`negativePrompt` 是别名 |
| `image` | 否 | 参考图数组，1~3 张；工作区内相对/绝对路径、HTTPS URL、data URL；`imageUrl` 是单张别名 |
| `dir` | 否 | 工作区内目录，默认 `generated`；`..`、工作区外绝对路径、symlink 逃逸都会被拒绝 |
| `model` | 否 | `qwen-image-3.0`（默认）/ `qwen-image-3.0-pro` / `qwen-image-2.1-pro` / `qwen-image-2.1-turbo` |
| `prompt_extend` | 否 | 是否扩写提示词；3.0 默认开、2.1 默认关。要精确复现请传 `false`；`promptExtend` 是别名 |
| `seed` | 否 | 0~2147483647；服务端不保证完全复现 |
| `watermark` | 否 | 不传则用服务端默认；`true`/`false` 显式覆盖 |
| `dry_run` | 否 | 只校验参数、参考图和目录边界，不调用付费接口、不下载、不写文件 |
| `timeout_ms` | 否 | 本次生图请求超时，5000~1800000；覆盖配置 `timeoutMs` |

参考图限制：最多 3 张，单张 ≤ 10 MiB、单边 ≤ 4096；格式为 PNG / JPEG / GIF / WebP。
工作区外本地路径默认拒绝；确需读取时在配置里打开 `allowOutsideWorkspace`。

### 输出

工具返回结构化结果，`output.render` 还会生成聊天文本和图片块：

| 字段 | 说明 |
|---|---|
| `files` | 已保存的本地绝对路径 |
| `urls` | 原图 HTTPS URL（24 小时有效） |
| `images` | 可预览图片的 attachment 引用；附件服务不可用时为空 |
| `dimensions` | 每张图的实际宽高/字节/格式 |
| `model` / `size` | 实际模型与请求尺寸；未指定尺寸时为 `auto` |
| `requestedN` / `receivedN` | 请求张数与接口实际返回张数 |
| `requestId` | 百炼 `request_id`，排障时提供给阿里云 |
| `usage` | 接口返回的 usage（通常含图片张数等信息） |
| `failed` | 下载失败项；成功项仍在 `files` 里 |
| `warnings` | 提示或降级原因 |
| `dryRun` / `durationMs` | 是否 dry-run、耗时；正常生成还有 `seed`（如果请求了） |

## 配置项

设置页或 `cordis.patch.yml` 的 `config` 均可修改；所有字段可热更新（`volatile`）。
常用项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | 空 | 百炼 Key；设置页中是 secret 字段；留空走环境变量/文件 |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | Key 所在环境变量名 |
| `model` | `qwen-image-3.0` | 默认模型 |
| `baseURL` | `https://dashscope.aliyuncs.com` | 百炼端点；外部 http 需显式开 `allowInsecureBaseURL` |
| `dir` | `generated` | 工作区内输出目录 |
| `prefix` | `qwen` | 文件名前缀 |
| `timeoutMs` | `300000` | 单次生图请求超时 |
| `downloadTimeoutMs` | `120000` | 单张下载超时 |
| `maxRetries` / `downloadRetries` | `2` / `2` | 生图/下载重试次数；重试可能重复计费 |
| `maxImagesPerCall` | `6` | 单次最多张数 |
| `maxImagesPerDay` | `0` | 每日最多提交张数，按本地日期计数；0 不限。只数张数，不估算金额；多会话下为尽力而为 |
| `maxReferenceImages` | `3` | 参考图张数上限 |
| `maxReferenceBytes` | `10485760` | 单张参考图体积上限 |
| `maxReferenceDimension` | `4096` | 参考图单边像素上限 |
| `maxDownloadBytes` | `33554432` | 单张生成图下载上限 |
| `maxPromptChars` | `12000` | 提示词字符硬上限；超过 5000 会警告 |
| `writeMetadata` | `true` | 是否写同名 `.json` 旁车 |
| `attachToChat` | `true` | 是否返回图片内容块；关闭只返回路径 |
| `allowOutsideWorkspace` | `false` | 允许参考图读取工作区外路径 |
| `allowInsecureBaseURL` | `false` | 允许外部 http `baseURL`；本机 localhost 始终允许 |
| `allowAnyDownloadHost` | `false` | 允许从任意 HTTPS 域名下载；默认只信任百炼/阿里云和 `baseURL` 主机 |

> 按 id 覆盖时 `config` 是整段替换，不是深合并；要保留的字段请一起写。

## 安全与限制

- **同步接口**：单次最多 6 张；没有异步任务、进度/心跳、后台 jobs。慢模型或大批量建议拆成多次调用。
- **编辑能力有限**：支持参考图 + 提示词，不做 mask/局部重绘/扩图/强度控制；也没有多图独立指令。
- **历史只有只读列表**：`list_generated_images` 能按旁车 JSON 列出最近图片，但没有画廊 UI、检索、重生成、保留/清理策略；目录仍会持续增长。
- **预算只限制张数**：`maxImagesPerDay` 按本地日期在 `~/.dsh/qwen-image-usage.json` 记账，超额在请求前拒绝；它不估算金额、不含失败重试、不防多进程竞争，删除 ledger 即可重置。需要金额预算时仍要自己控制 `model`/`n`。
- **参考图输入**：不支持直接引用聊天附件，需要先拿到工作区内路径；远程 URL 不做内容预检。
- **工具名固定**：`generate_image`，没有命名空间/重命名配置。
- **安装器只支持 Windows**：`install.mjs` 是 Node ESM；启动器会先执行 `node --version`，失败时尝试 DSH 自带 Electron。没有运行时可用时，只能手动复制并改 profile 清单。macOS/Linux 启动器已移除。
- **无 i18n/图标**：描述和错误目前是中文；插件页没有单独 locale/icon 资源。
- **代理**：插件层不自己配代理，使用宿主 `fetch` 的网络配置。

## 分享给别人

- 插件代码和 `cordis.patch.yml` 不含 Key；
- 把整个 `dsh-qwen-image` 目录压成 zip 发给对方，对方解压后双击 `install.cmd`；
- 以后发新版 zip，对方解压到其他目录后双击 `update.cmd` 即可；
- 请求从使用者机器直连百炼，作者不中转、不产生费用；
- 对方有 Agent 时，可以把 zip 和 `AGENT.md` 一起给它，让 Agent 按文档安装或更新。

分发前自查：

1. 不要打包 `%USERPROFILE%\.dsh\.credentials.yaml`、`%USERPROFILE%\.dsh\.env`、`generated/`；
2. 检查 `cordis.patch.yml` 和 profile patch 没有残留 `apiKey: sk-...`；
3. 打包：运行 `.\release.ps1 -Repository <owner>/<repo>`，会自动生成
   `dist/dsh-qwen-image-0.5.2.zip`、`.sha256` 和 `latest.json`；
   也可以手动 `Compress-Archive`，但 GitHub Releases 自动更新依赖这三个文件：

   ```powershell
   Get-FileHash .\dist\dsh-qwen-image-0.5.2.zip -Algorithm SHA256
   Get-Content .\dist\dsh-qwen-image-0.5.2.zip.sha256
   ```

4. 推送 `v0.5.2` tag 后会自动创建 Release；也可以在 GitHub 的 Actions 页面
   手动运行 `release`，tag 填 `v0.5.2`（不需要本地 Git）；
   也可以手动 `gh release create v0.5.2 dist/dsh-qwen-image-0.5.2.zip dist/dsh-qwen-image-0.5.2.zip.sha256 dist/latest.json`。
   发布前确认 `update-source.json` 的 `OWNER/REPO` 已替换成真实仓库。

> `release.ps1` 和 `.github/` 是源码仓库的发布工具，不放进安装 zip；安装 zip 只带运行和安装所需文件。

## 设计说明

- **没有 `dependencies`**：DSH 运行时注入服务，插件用相对导入和 Node 内置模块；用 `link:` / `file:`
  安装也能加载。
- **手写 ToolDefinition**：不依赖 `defineTool`；参数/输出 schema 使用 DSH 支持的 JSON Schema 子集。
- **Config 不依赖 schemastery**：实现 Standard Schema 的 `~standard.validate`，同时提供
  `type` / `dict` / `meta` / `toJSON()` 和 `Symbol.for('schemastery')`，让设置页按原生 schema 处理。
- **图片预览走 attachments**：`ctx.get('attachments').saveImage()` 返回 attachment ref，再包成
  `{ type: 'image', attachment }`；服务不可用时只返回路径，不阻塞主流程。
- **下载先落盘再附件化**：即使聊天预览失败，本地文件仍然保留。
- **历史读旁车而不是扫图片**：`list_generated_images` 只信任输出目录里成对的 `.json`/图片，
  不接受 sidecar 里的任意 `path`，避免把列表变成任意文件读取。
- **额度先预占再结算**：调用前把本次 `n` 写进本地 ledger，接口返回后按实际张数多退少补；
  请求失败释放预占，尽量降低并发超发。

## License

MIT