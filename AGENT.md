# 给 Agent 的 dsh-qwen-image 更新说明

本文件随安装包一起分发。收到一个包含本文件的 zip 时，按下面的流程把插件安装或更新到
DeepSeek Harness 的**当前用户 profile**。

## 目标

- 把本目录中的插件文件放到 `%DSH_HOME%\plugins\dsh-qwen-image`；
- 把 `dsh-qwen-image` 加入目标 profile 的依赖和 `dsh.profile.bundles`；
- 保留用户的 API Key、生成图片、每日额度记录和设置；
- 不调用任何付费生图接口。

## 先确认

1. 确认 `DSH_HOME`：
   - 优先使用环境变量 `DSH_HOME`；
   - 未设置时，Windows 是 `%USERPROFILE%\.dsh`。
2. 确认 profile：
   - 优先使用 `DSH_PROFILE`；
   - 否则看 `DSH_PROFILE_DIR` 的目录名；
   - 否则扫描 `%DSH_HOME%\profiles\*\package.json`；
   - 仍无法判断时问用户，不要默认覆盖多个 profile。
3. 确认本目录有 `install.mjs`、`package.json`、`index.mjs`、`core.mjs`、`config.mjs`。
4. 不要执行来源不明的 `postinstall` 或远程脚本。

## 推荐命令

在解压后的插件目录运行（仅 Windows）：

```bat
install.cmd --profile desktop
update.cmd --profile desktop
check.cmd --profile desktop
check-update.cmd
```

`check-update.cmd` 只读取 GitHub Releases 的 `latest.json`，不下载、不安装。
如果提示 `QWEN_UPDATE_SOURCE`，说明 `update-source.json` 还是 `OWNER/REPO` 模板，
需要先把 `manifestUrl` 改成真实仓库地址。

没有 `node` 时，启动器会尝试 DeepSeek Harness 自带运行时；也可以手动：

```bat
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" install.mjs --upgrade --profile desktop
```

需要机器可读结果：

```bat
node install.mjs --upgrade --profile desktop --json
```

## 更新流程

1. **先备份**：
   - `%DSH_HOME%\plugins\dsh-qwen-image`
   - `%DSH_HOME%\profiles\<profile>\package.json`
2. 读取新旧 `package.json` 的版本号，确认不是误降级。
3. 确认新包**不在**已安装目录 `%DSH_HOME%\plugins\dsh-qwen-image` 内；
   在已安装目录运行 `--upgrade` 会被拒绝，避免假更新。
4. 运行：

   ```bat
   node install.mjs --upgrade --profile <profile>
   ```

5. 安装器会：
   - 把旧插件目录改名为 `dsh-qwen-image.bak`；
   - 复制新文件并删除新版已移除的旧文件；
   - 更新 profile 依赖和 `dsh.profile.bundles`；
   - 默认不询问、不覆盖 API Key。
6. 运行验证：

   ```bat
   node selftest.mjs
   node regression.mjs
   node installer.test.mjs
   ```

7. 告诉用户：**完全退出并重新启动 DeepSeek Harness**。刷新网页不够。

## 不要做

- 不要修改或打印 `%DSH_HOME%\.env` 里的 Key；
- 不要删除 `generated/`、`qwen-image-usage.json`；
- 不要调用 `generate_image` 或真实百炼接口做“安装验证”；
- 不要把 `--api-key` 写进日志、命令历史或最终报告；
- 不要在用户没确认时改多个 profile；
- 不要用 `curl ... | sh` 执行远程脚本。

## 失败与回滚

如果更新后无法启动或工具报错：

```bat
node install.mjs --rollback --profile <profile>
```

安装器会把 `dsh-qwen-image.bak` 恢复为正式目录，并在有 `package.json.bak` 时恢复 profile 清单。
恢复后再次重启 DSH。

如果需要卸载：

```bat
node install.mjs --uninstall --profile <profile>
```

也可以双击 `uninstall.cmd`。默认保留插件目录、Key、图片和额度记录；只有显式 `--purge` 才删除插件目录和额度记录，
`--remove-key` 才会删除 `.env` 中的 Key。

不确定状态时先运行 `check.cmd` 或 `node install.mjs --check --profile <profile>`，它只读不写。

## 报告格式

更新成功后向用户报告：

- 旧版本 → 新版本；
- 目标 profile；
- 插件目录；
- 备份目录；
- `selftest` / `regression` 是否通过；
- 是否需要重启（答案：需要）。

不要报告 API Key 内容。