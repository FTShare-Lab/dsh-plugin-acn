# 开发与复验

本文面向插件维护者。普通用户先看[使用指南](user-guide.md)，分发准备看[发布说明](release.md)。

## 可复验的本地构建

以下步骤应串行执行；常规测试、契约脚本、打包和安装冒烟都会使用或重建同一个 `lib/`，并行执行会导致 Loader 在测试期间读到被清理的产物。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test
ACN_REPO=/path/to/reference pnpm test:compat
ACN_REPO=/path/to/reference pnpm test:contract
pnpm build
pnpm pack --pack-destination .artifacts
pnpm smoke:install
```

安装包包含运行 JS、类型声明、模板、组合 patch、中英文 README、包及八个组件的中英文 locale、原创 SVG 图标、当前文档、变更记录和许可证；不包含源码测试、临时项目、日志、私有数据、凭据或 node_modules。`pnpm smoke:install` 在新 `DSH_HOME` 执行真实 CLI 安装，检查公开入口、全部本地化与图标资源、Loader 行为，再用临时不兼容引擎包检查宿主拒绝，不改项目声明。

真实 Web 验收先选择本机 Web profile 中已配置的提供商；将 `your-provider` 替换为自己的提供商 ID。以下真实模型复验命令都需要该环境变量，回环脚本模型模式不需要。

```sh
export ACN_ACCEPTANCE_PROVIDER=your-provider
pnpm smoke:web
```

默认模型为 `deepseek-v4-flash-api`，凭据只传入子进程环境，所有验收数据写入临时目录；可用 `ACN_ACCEPTANCE_MODEL_ID` 选择其他已配置模型。隔离宿主统一显示中性别名 `acceptance-provider`，日常配置不变。脚本输出本机 Web 地址，选择默认工作区后按[验收步骤](acceptance.md)操作；停止脚本结束自建服务。临时记录不进入仓库。

只通过网页安装和填写 ACN 配置的复验使用 `ACN_WEB_INSTALL=browser pnpm smoke:web`。此模式只准备宿主模型和合成工作区，不安装 ACN、不预填其配置、不生成 seed Claim；根据输出的 tarball 路径在网页安装并启用，再填写字段。以相同 `ACN_WEB_HOME` 重启可验证保存恢复，脚本不会再次初始化已有 profile。

需要同时启动真实本机团队服务时可运行：

```sh
ACN_REPO=/path/to/reference \
ACN_ACCEPTANCE_PROVIDER=your-provider \
ACN_CONTRACT_WEB_HOME=/path/to/isolated-web-check \
node scripts/contract-services.mjs
```

辅助进程为两个测试身份生成临时凭据，向 DSH 子进程注入 `ACN_TEST_TEAM_CREDENTIAL`（agent-a）和 `ACN_TEST_OTHER_CREDENTIAL`（agent-b），输出回环 endpoint 与 tarball 路径；在网页选择团队模式并填入对应变量名。停止辅助进程会关闭其自建服务；重启后按新的端口输出更新页面连接。该辅助模式验证通信，默认不启用服务端模型重排或仲裁。完整本次步骤见[网页配置验收](validation/2026-10-24-web-configuration.md)。

故障复验可使用 `ACN_WEB_MODEL=local pnpm smoke:web`，模型为回环脚本服务。普通单元与集成测试始终使用本地模型，不依赖真实供应端。

实际团队验收可在启动两项本地服务并配置团队身份后，为同一 `pnpm smoke:web` 进程同时设置 `ACN_WEB_TEAM_ROUTER`、`ACN_WEB_TEAM_MAINTAINER`；`ACN_WEB_TEAM_KEY_ENV` 指向保存凭据的环境变量，默认 `ACN_WEB_TEAM_CREDENTIAL`。未设置 endpoint 时仍为单人模式，少配一个会明确失败。脚本只将 endpoint 和变量名写入临时配置。使用独立服务数据根及测试身份，不连接生产团队；实测步骤和能力范围见[团队验收记录](validation/2026-10-23-inbox-dream-team.md)。

多成员复验为每个进程设置独立 `ACN_WEB_HOME` 和不同 `ACN_WEB_AGENT_ID`（默认 `agent-a`），并使用对应身份的团队凭据。设置 `ACN_WEB_SEED_CLAIM=false` 从空知识开始，避免不同成员上传同一默认 seed ID；其余初始材料使用合成数据。`ACN_WEB_TEAM_TIMEOUT_MS` 可覆盖验收进程的团队超时，默认 15000；真实模型重排验收使用 180000。Router / Maintainer 的模型与自动仲裁需在服务配置中单独启用，插件的模型配置不会替服务配置模型。完整步骤与结果见[真实模型团队闭环](validation/2026-10-23-model-team-loop.md)。

设置 `ACN_WEB_EVIDENCE_CALIBRATION=true` 可在隔离 Web 验收中启用 Dream 的工作区受限查证，默认仍关闭。真实开发、跨项目复用及故障场景见[实际使用审核](validation/2026-10-25-usage-audit.md)。

Dream 版本限制复验先 `pnpm build`，再执行 `node scripts/seed-dream-preservation.mjs legacy` 或 `fresh`，得到新建临时根。以 `ACN_WEB_HOME=<root> pnpm smoke:web` 启动旧草稿恢复场景；新任务场景使用 `ACN_WEB_HOME=<root> ACN_WEB_DISABLE_MEMORY_REVIEW=true pnpm smoke:web`，保留预置 Memory review 排队任务，在会话中运行 `/dream`。随后用 `/acn-status` 和 `/claim show <id>` 核对成功任务、完整原证据摘要以及未被领取的禁用任务。脚本只创建虚拟公共数据，不导入本机真实知识。
