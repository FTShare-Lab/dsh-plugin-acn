# 开发指南

本文面向插件维护者。安装配置见[使用指南](user-guide.md)，模块职责见[架构](architecture.md)。

## 构建与自动化检查

使用 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.25.0`。以下命令应串行执行：测试、契约脚本、打包和安装检查都会使用或重建同一个 `lib/`。

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

`ACN_REPO` 指向参考 ACN 源码仓库，版本与提交基线见[ACN 兼容边界](acn-compat.md)。`test:compat` / `test:contract` 需要 Bash 与 Rust 工具链，在 macOS / Linux 执行；脚本会按需读取参考仓库的 `export_env.sh`。普通单元与集成测试使用临时目录和本地测试模型，不依赖真实模型服务。

| 检查入口 | 验证范围 |
| --- | --- |
| `pnpm test` | 工具与宿主接入、存储、权限、并发、进程崩溃和恢复 |
| `pnpm test:compat` | 已提交的协议 fixture，以及 TypeScript 写出的 YAML 能否被 Rust 读回 |
| `pnpm test:contract` | 在临时目录启动真实 Router / Maintainer，验证查询、上传、裁决通知的双成员内化和整合依赖；内化模型使用本地测试适配器 |
| `pnpm smoke:install` | 新 DSH profile 中的实际包安装、Loader 生命周期、公开资源和不兼容引擎拒绝 |
| `pnpm check:security` | 版本控制文本中的凭据、邮箱和个人路径，以及提交元数据中的其他敏感内容；允许用户确认的 Git 身份邮箱 |
| `pnpm check:docs` | Markdown 相对链接与标题锚点 |

安装包包含运行 JS、类型声明、提示词、组合 patch、双语说明、本地化资源、图标、使用截图和许可证；不包含源码测试、依赖缓存、临时项目或运行日志。安装检查使用独立的 `DSH_HOME`，不会修改日常 profile。`smoke:install` 由 Node 脚本执行，可从 Windows PowerShell 或 POSIX 终端运行；Windows 的 pnpm / dsh 命令 shim 通过统一启动器调用，不要求安装 Bash。它需要可用的 `tar` 和 DSH CLI；`DSH_BIN` 也可指向桌面附带 CLI 的 `.js` 入口。

安全扫描不识别截图文字。更新图片时应检查可见内容，使用中性示例，避免展示实际数据路径、提供商别名、邮箱或凭据。

## 隔离网页调试

选择本机 Web profile 已配置的模型提供商，并将 `your-provider` 替换成它的 ID：

```sh
export ACN_ACCEPTANCE_PROVIDER=your-provider
pnpm smoke:web
```

脚本默认使用 `deepseek-v4-flash-api`；可通过 `ACN_ACCEPTANCE_MODEL_ID` 选择该提供商下其他已配置模型。凭据只传给子进程，模型请求会访问所选提供商。脚本创建临时工作区、知识目录和 DSH profile，并输出网页地址；日常配置不变。停止脚本会结束其创建的服务。macOS / Linux 调试期间向该脚本进程发送 `SIGUSR1` 可只重启它创建的 DSH，保留测试服务与数据；新网页地址会再次输出。Windows 不支持此信号，需停止脚本后使用相同 `ACN_WEB_HOME` 重新启动。

只验证安装与网页配置时使用：

```sh
ACN_WEB_INSTALL=browser pnpm smoke:web
```

此模式不预装 ACN、不预填其配置，也不生成 seed Claim。按[使用指南](user-guide.md)安装输出的 tarball，填写配置并保存。以相同 `ACN_WEB_HOME` 重启，可检查保存与恢复；已有 profile 不会再次初始化。

不调用真实模型的流程调试可使用 `ACN_WEB_MODEL=local pnpm smoke:web`。这是预设响应的本地测试模型，不适合评价知识质量。

建议检查以下稳定行为，而不是只看任务是否显示成功：

- 安装、启用、保存、重读草稿与重启后，身份、目录和模型配置符合预期。
- 多个具名连接可检查、离线保存、停用和恢复；新会话按默认工作配置预选、首发前可改选并等待内化，首发后归属固定。
- 首次同步失败允许使用所选身份的本地知识；未绑定历史仍可普通聊天。取消、热重载、冷历史读取和派生会话不改变归属。
- 知识浏览不触发同步/模型；活动可查看来源、失败和重试。结果只在可见且有焦点的来源会话展示，重启不重复弹旧结果。
- 完成一项小任务并 `/recap` 或 `/acn-finalize` 后，能从新会话检索 Claim、读取 Trace，并保留适用范围与未验证条件。
- Memory 更新后，新会话读取新快照，原会话继续使用原快照；私有内容不直接进入 Claim 或团队上传。
- 模型输出不合法、服务不可达或进程中断时，任务状态可解释，恢复后没有重复提交或丢失输入。

### Recap 触发与恢复验收

在隔离 profile 中选择真实模型，以实际开发、测试和新会话复用检查形成效果。单人和团队模式均应覆盖下列行为，使用不同会话测试各类计时，避免一项测试的输入改变另一项的空闲时间。

| 场景 | 检查重点 |
| --- | --- |
| 手动 `/recap` | 空会话不建任务；少量新增内容能处理；成功后重复执行不再次处理同一区间 |
| 前台仍在运行 | 自动触发等待前台结束；手动 Recap 只处理此前已完成的范围，不消费正在生成的内容 |
| 批量空闲 | 默认 9 轮且不足 token 门槛时，空闲 5 分钟不触发；第 10 轮后仍需空闲 5 分钟；token 门槛可独立触发 |
| 尾部空闲 | 不足批量门槛的增量在默认 1 小时前不触发，到期进入队列；后续扫描不重复消费 |
| 归档与暂停 | 普通归档保留宿主的忙碌拒绝规则；停止并归档冻结收尾范围，迟到结果不扩大范围 |
| 恢复与续聊 | 重启保留空闲起点及归档暂停；撤销归档、查看状态不解除暂停；实际用户续聊后恢复 |
| 压缩与故障 | 成功压缩处理对应区间；模型故障、任务中断和重启后保留输入，不重复提交知识 |

默认时长验收应实际等待；缩短 `formation.recapBatchIdleMinutes`、`formation.recapTailIdleMinutes` 或 `formation.recapScanSeconds` 可用于故障调试，但不能据此声称默认时长已验证。精确阈值、内部通知、失败或取消轮次、归档中断和并发边界由 `tests/formation/` 与 `tests/flow/recap-lifecycle.test.ts` 回归覆盖。

核对任务的触发原因、创建时间、状态和处理范围，并检查实际 Claim、Trace 及团队待上传项。一次模型调用可能更新已有知识或没有产出；任务成功本身不证明知识内容正确。验收日志、临时项目和按次记录保留在仓库外。

## 本地团队调试

首次配置验收应分别保留安装前的历史与空白会话，以及安装后新建的空白会话。前两类可以继续聊天，但不能绑定团队或访问 ACN 数据；只有最后一类能在首发前选择配置，回复后 `/recap` 可形成知识。安装后未选择配置就开始聊天的会话，也不能中途入队；热重载或重启不能绕过限制。已有绑定及派生历史不能换身份。配置停用与恢复应保留同一标识、知识及会话归属。

旧格式配置升级还应覆盖已经聊过且仍打开的单人、团队会话：只修改名称并保存或调整全局默认后，原会话均应按有效绑定继续访问原 Claim 和冻结 Memory；冷恢复结果一致。损坏、冲突及身份不匹配的绑定不能被迁移为有效选择。

在「团队鉴权密钥」输入随机测试 key，确认默认掩码、眼睛按钮显隐、空值保留及取消草稿；连接检查不写入托管存储，保存配置才保存密钥。确认自动引用只进入插件 YAML、密钥只进入宿主托管存储，新启动会话采用新引用，驻留实例保留原连接，释放后重新加载实例使用同 upstream 当前连接；同时检查带路径前缀的服务地址。展开本地和缺失的来源 Claim，确认返回时保留原详情与筛选，浏览不触发网络和模型。

同时启动参考服务和一个可从网页安装插件的隔离 DSH：

```sh
ACN_REPO=/path/to/reference \
ACN_CONTRACT_WEB_HOME=/path/to/isolated-web-check \
pnpm test:contract
```

该命令先构建 Router / Maintainer，再为 `agent-a`、`agent-b` 生成临时凭据，启动两项服务和网页宿主。脚本预配置 `ACN_TEST_TEAM_CREDENTIAL` 与 `ACN_TEST_OTHER_CREDENTIAL` 的兼容引用；页面无需填写引用名。正常新建工作配置时直接输入成员 key，地址使用脚本实际输出的回环 endpoint。停止脚本会结束这些服务并清理临时团队数据。

此模式默认不启用 Router 模型检索或 Maintainer 自动仲裁，只验证通信。需要评价模型仲裁时，应另行在服务端配置 Maintainer 模型并启用仲裁；推荐保持 Router 为词法检索，避免[已知重排限制](outstanding-issues.md#团队仲裁与信息边界)。插件中的模型选项不会替团队服务配置模型。

接入已经启动的测试服务时，为 `pnpm smoke:web` 同时提供 `ACN_WEB_TEAM_ROUTER`、`ACN_WEB_TEAM_MAINTAINER`，并用 `ACN_WEB_TEAM_KEY_ENV` 指定认证环境变量名。默认变量名为 `ACN_WEB_TEAM_CREDENTIAL`。少配一个 endpoint 会启动失败；凭据不写入配置文件。

可在同一隔离 profile 的「ACN 插件设置 → 工作配置」页添加两份配置，分别使用不同成员 ID 与团队鉴权密钥；也可为多个进程分别设置独立的 `ACN_WEB_HOME`、不同的 `ACN_WEB_AGENT_ID` 和对应凭据。可用 `ACN_WEB_SEED_CLAIM=false` 从空知识开始，避免多个成员生成同一个 seed ID。`ACN_WEB_TEAM_TIMEOUT_MS` 控制团队请求超时，默认 15000 毫秒。

团队检查应覆盖 A 形成并上传知识、B 检索和复用、冲突上报、Maintainer 给出建议、各成员 Inbox 内化、修订回传，以及 Dream 整理后的依赖交付。仲裁完成、建议送达和本地内化是不同阶段，应分别确认；服务断开后的补送也应检查。

### 自动仲裁与通知边界

真实模型专项测试应使用隔离团队数据，固定 Router 为词法检索，在 Maintainer 另行启用自动仲裁与模型。使用有明确来源、版本和限制的合成材料时，须标为测试输入，不能混作业务实证。

| 场景 | 应核对的结果 |
| --- | --- |
| 有证据的冲突 | 提案与独立复核通过后才采纳；保留版本、请求方法、次数和预算边界 |
| 等强度、未核实的相反证据 | 可以保持未解决，不把某一方自动视为正确；不生成假完成通知 |
| 分析期间修订输入 | 旧输入不能采纳；重分析使用当前版本，并记录轮次与输入变化 |
| 两名持有者与旁观成员 | 通知只送直接涉争持有者；旁观成员通过 Router 发现修订，而非等待广播 |
| 持久收件、ACK、内化与回传 | 分别确认各阶段；ACK 后本地仍可能尚未变化，内化也可能决定不修改 |
| 非法 JSON 或外部持有者修改 | 严格校验拒绝，不执行无效变更；失败通知保留，修正后重试只应用一次 |
| 重复拉取、进程中断、并发提交 | 不重复生成 Trace 或覆盖更新版本；按现有日志与恢复边界完成或重新分析 |

`tests/inbox/` 覆盖模型失败、重试、并发和崩溃恢复；`tests/contract/team.test.ts` 的裁决契约经真实服务送达两个成员，内化前后分别核对本地状态、回传与再次同步。契约中的管理员操作仅用于构造裁决，不能替代真实模型自动仲裁验收。最终应在 DSH 界面操作同步与查询，并保存任务、服务裁决和实际知识内容的证据，不能仅凭成功提示判断完成。

## Dream 恢复调试

设置 `ACN_WEB_EVIDENCE_CALIBRATION=true` 可在隔离宿主启用文件查证，默认关闭。先运行 `pnpm build`，再执行 `node scripts/seed-dream-preservation.mjs legacy` 或 `fresh`，可创建带版本限制的合成材料。

以输出的根目录作为 `ACN_WEB_HOME` 启动 `pnpm smoke:web`。新任务场景可同时设置 `ACN_WEB_DISABLE_MEMORY_REVIEW=true`，保留预置 review 排队任务，检查禁用处理器不会阻塞 Dream。随后运行 `/dream`，通过 `/acn-status` 和 `/claim show <id>` 核对恢复结果、证据摘要与来源承接。脚本不导入日常知识。

## 提示词维护

内容选择和知识使用纪律以原 ACN 的同名模板、`agent_system.j2` 中的知识段落为基准，保留其原文和示例，不以缩短提示词为由删减或弱化规则。适配范围限于插件实际提供的工具参数、结构化输出格式、会话投影、私有数据边界及 Dream 额度和收尾通知。

正常插件使用当前自主 Dream 提示词；旧固定阶段模板只用于兼容适配器及其测试，不注入当前自主流程。

修改后核对前台与后台 Memory 的共同规则、单人模式不出现团队调用指令，并使用参考模板引擎重新导出受影响的快照；同时运行宿主集成与真实模型验收，检查输出接口和知识选择结果。

## CI 配置

工作流使用 GitHub Actions，定义在 `.github/workflows/ci.yml`；仅推送到其他 Git 托管平台不会执行这个工作流。主检查矩阵为 Ubuntu / macOS / Windows × Node 22 / 24，覆盖类型、lint、安全、文档、全量测试、构建、打包和真实安装。测试使用四个文件进程，保留跨进程并发和强制终止恢复测试。

Windows job 只在临时 runner 开启开发者模式，以执行真实符号链接 fixture；不跳过链接保护测试，也不修改用户电脑设置。本机 Windows 运行这些测试需要开发者模式或创建符号链接的权限；普通插件使用不要求创建链接。新增 `tests/platform/` 覆盖反斜杠主目录、盘符 / UNC、原生导入、保留名称和去掉 POSIX 打开标志后的 Memory 读写及链接拒绝。现有 macOS 权限断言继续保留，Windows 改为检查可读写，不把 mode 位当作 ACL 验收。

基线安装检查使用 DSH rc.2，独立的 Windows 安装 job 另检查 rc.5；不重复运行主矩阵已覆盖的测试集。团队契约单独在 Ubuntu 运行；这不代表 Windows 上直接部署 Rust 服务已被验收。Windows 本地可在 PowerShell 串行执行以下检查（先安装所需版本的 Node、pnpm、DSH CLI 和 tar）：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test --maxWorkers=4
pnpm build
pnpm pack --pack-destination .artifacts
pnpm smoke:install
```

提交前的本机验证不触发远端 CI，Windows runner 的结果应在工作流实际运行后确认。团队契约 job 需要仓库变量 `ACN_REFERENCE_REPOSITORY`，其值为参考源码仓库；私有跨仓库访问另用 `ACN_REFERENCE_TOKEN` secret。缺少参考仓库变量会明确失败，不会跳过契约检查。

参考提交与 fixture 应一起维护。升级 ACN 或 DSH 后，先核对协议、事件、工具门禁、模型取消和卸载边界，再运行上述检查。测试是否通过以本次命令退出码及 CI 结果为准，不把旧报告的通过数量当作当前结论。

## 项目会话预选验证

项目预选只使用公开的 `sessionPersistence.list/open` 和 `sessions.list`；无需替换宿主 UI 包、安装额外 bundle 或执行安装后脚本。只读历史不会创建 Agent 或触发模型、团队同步。

检查同一项目的新会话是否沿用最近新建普通会话的 upstream，以及另一个项目是否使用自己的记录或全局默认。重启后应从持久会话日志恢复；打开旧会话、继续旧任务和后台子代理不能改变创建顺序。还需覆盖草稿改选、无全局默认、并发新建、目录别名、配置停用/删除/身份变化及历史读取失败。已有会话继续保持原绑定。
