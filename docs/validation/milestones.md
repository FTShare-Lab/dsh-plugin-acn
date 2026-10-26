# M0 本地验收记录

日期：2026-10-21。DSH：`0.2.1-rc.2`；上游：`687f282e`。

## 自动检查

- Node `22.23.3`、pnpm `11.25.0`：冻结锁文件安装、typecheck、lint、安全扫描、6 项测试、build、pack 通过。
- Node `24.22.0`、pnpm `11.25.0`：相同检查全部通过。
- 6 项测试覆盖：真实 Loader 激活与隔离、按 id 禁用、卸载撤销服务，以及安全扫描的明文凭据、私有域名/个人路径识别和中性配置放行。
- `pnpm smoke:install` 在临时 `DSH_HOME` 中完成打包、Web profile 初始化、tarball 安装、配置结构与发布文件检查，并清理临时目录。
- CI 已配置 Node 22 / 24 矩阵；远端 GitHub Actions 结果需在推送后确认，本轮不将本地结果标为远端 CI 已运行。

本轮尚未移植 ACN 领域模块，因此无 ACN 测试移植项；协议与存储测试从 M1 开始。

## Web 工具调用

1. 在单独的临时目录创建空工作区、`DSH_HOME` 与 `DSH_AGENTS_HOME`，关闭遥测。
2. 打包包含临时 `acn_ping` 工具的插件，通过公开 CLI 安装到从 Web 模板初始化的 `acn-web` profile。
3. 启动上游 `dsh-llm-mock-server`，使用运行时随机生成的测试凭据、回环地址和脚本模型 `acn-smoke-model`。脚本先返回 `acn_ping({})` 工具调用，再返回 `pong`。关闭标题生成，工具模式设为 native。
4. 使用 `dsh --profile acn-web --patch <test-overlay> --no-open --port 0` 启动真实 Web 应用。
5. 在浏览器选择 ACN smoke model，输入“请调用 acn_ping 工具，并原样返回工具结果。”并发送。
6. 展开工具记录，界面显示输入 `{}`、输出 `pong`，最终回复为 `pong`。服务端第二次模型请求包含实际工具结果，摘录如下。
7. 保存截图，关闭测试 Web 服务与 mock server，删除临时目录；从插件中删除临时工具和 `tools` 依赖注入，再验证最终构建。

```json
{
  "type": "tool_result",
  "tool_use_id": "mock-call-1",
  "content": [{ "type": "text", "text": "pong" }],
  "is_error": false
}
```

本次 Web 验收覆盖实际安装、工具注册、Agent 执行、协议回传和界面展示；模型响应由本地脚本生成，未调用真实模型服务。

![M0 Web 工具调用结果](../assets/m0-web-ping.png)

# M1 本地验收记录

日期：2026-10-21。参考 ACN：`0.3.3` / `c542b19`；DSH：`0.2.1-rc.2`。参考仓库源码保持不变。

## 自动检查与安装

- Node `22.23.3`、`24.22.0`，pnpm `11.25.0`：冻结锁文件安装、typecheck、lint、安全扫描、115 项测试、build、pack 均通过。
- 115 项测试分布于 7 个文件，包含 M0 的 6 项测试；覆盖协议、完整目录读取、存储边界、真实多进程并发与崩溃恢复。
- `pnpm smoke:install` 在临时 `DSH_HOME` 完成 tarball 安装与配置组合，验证新发布的 `protocol`、`store` 及类型声明均在包中，并从实际安装位置导入两个入口。
- Rust 导出器通过 rustfmt 检查；三个 Shell 验证脚本通过语法检查，仓库通过 `git diff --check`。
- Node CI 保持 22 / 24 矩阵。本轮未推送，不将本地结果标为远端 GitHub Actions 已运行。

## 协议兼容

- 32 组参考报文的 TypeScript JSON 与 Rust JSON 逐字节相等，9 组 Claim revision 一致。
- `ACN_REPO=/path/to/reference pnpm test:compat` 完成 32 组 TypeScript YAML 的 Rust 读回，并核对规范 JSON。YAML 有 17 组字节相同、15 组仅引号或空白转义写法不同；读回结果全部一致。
- 完整 `acn-home` 基准目录由 Rust 导出实体及中性私有文件组成，所有实体读取测试通过。三种私有存储格式按源码复刻，未宣称调用了源端私有类型。
- 源端极端年份读写不对称另有反例断言；插件拒绝规范 UTC 年份越界的输入。已验证范围与差异见 [兼容记录](acn-milestones.md) 和 [已知限制](../outstanding-issues.md)。

## 并发与崩溃恢复

- 10 个独立进程同时写一个 Claim，读取始终完整，最终文件为其中一个完整版本；10 个队列写入进程不丢条目；10 个 Inbox 领取进程仅一个获得租约。
- 在真实原子写的 fsync 后、rename 前 SIGKILL，旧正文保留，残留临时文件不会被当作实体读取，过期后可清理。
- SIGKILL 遗留的 processing 租约和锁目录到期后可恢复或接管；文件锁超时、获取顺序和异常释放测试通过。
- 在编辑日志、本地正文、持久队列三个阶段分别 SIGKILL，恢复使用当前正文，不重放旧 target，已入队版本不会重复入队。
- 重投快照校验、旧租约隔离、领取时刷新租约年龄、损坏与 `null` 状态拒绝、单人模式不积累团队队列等回归通过。

本轮只实现协议与本地存储；Claim 工具、网络投递和 Inbox 内化按后续里程碑接入。来源测试的移植与延期范围见 [M1 测试覆盖](m1-test-coverage.md)。

# M2 本地验收记录

日期：2026-10-21。DSH 与 ACN 版本基线沿用 M1。

## 工具和生命周期

- 真实 AgentLoop 执行 `claim list/read/update/traces/read_trace`，模型可取得 revision 并修订；旧 revision 返回规范 conflict，外部 holder 修订被拒绝，损坏文件作为工具错误报告。
- 子代理的 `origin` 与 `delegationDepth` 两类标记均可拒绝 update、放行 read；即使外层策略直接返回 allow，最终 guard 仍拒绝写入。
- 同一会话目录保持不变；独立进程修改 Claim 后，下一请求出现累计身份变化，连续请求中只新增一次同版本消息。拒绝和取消发生在准入前时，提示留待后续请求。
- JSONL 持久会话实际 dispose/resume 后，目录保持一致，已准入版本不重复追加。服务重建、compact、fork 继承目录、clear 重建基线及 fork 独立通知游标另有回归。
- 未配置身份时，仅 ACN 状态命令可用，不创建知识目录。`/claim set` 与 `/acn-status` 经真实命令注册表执行，无模型调用；各插件行独立禁用与卸载清理通过。
- 单人模式下 fetch 调用为零，上传目录和编辑补传文件不存在。Claim 提示词不读取私有 MEMORY / USER 双文件。

## 模型与模板

- 本机 `dsh-llm-mock-server` 与真实 Messages HTTP adapter 分别完成 list/read/update 的工具请求、执行、tool_result 回传，各使用两次模型请求。未调用外部模型服务。
- pre-step 内 `inject()` 晚一个步骤生效；返回值追加 `messages` 进入当前步骤，并有持久 `user/message` 证据。实现采用后者，详细接口结论见 [DSH 兼容记录](dsh-milestones.md)。
- 四个适配模板的五组快照与参考仓库公开 PromptRegistry 的渲染结果逐字相等；显式对齐模板末尾换行规则。知识主模板只保留所需知识部分，范围见 [M2 测试覆盖](m2-test-coverage.md)。
- 原有 32 组协议报文、9 组 revision 保持一致，32 组 TypeScript YAML 再次通过 Rust 读回；M1 的并发和 SIGKILL 恢复回归通过。

## 工程与发布

- Node `22.23.3`、`24.22.0`，pnpm `11.25.0`：冻结锁文件安装、typecheck、lint、安全扫描、184 项测试（12 个文件）、build、pack 通过。
- 两个 Node 版本均完成 `smoke:install`：在临时 DSH_HOME 安装 tarball，再用 CLI 相同的 runtime resolution / PluginPackages 启动链加载实际安装包，校验物理路径后执行 Claim list、知识段落和状态命令。模板、类型声明、共享 JS chunk 和公开入口均包含于发布包。
- 参考仓库源码未修改；本轮未提交或推送，未将本地结果记为远端 CI 已运行。Shell 语法、Rust 导出器格式和 `git diff --check` 通过。

配置与用户操作见 [配置说明](../config.md) 和 [使用说明](../user-guide.md)。团队 HTTP、知识形成、后台 worker、Dream 和 Memory 操作继续按后续里程碑实施。


# M3 本地验收记录

日期：2026-10-22。ACN `0.3.3` / `c542b19`，DSH `0.2.1-rc.2` / `687f282e`；参考仓库源码保持不变。

## 形成主链路

- 生产 AgentLoop 的压缩 summary 触发 Recap，生成协议合法的 Claim 与 Trace；伪造 used ID 被丢弃并告警，合法输入 / 输出引用可从 Claim / Trace 查询。
- idle 自动 Finalize、running 取消计时、dispose、手动 /acn-finalize 和启动补做均验证。同一区间叠加触发只形成一次，新区间增量处理。形成的新 Claim 进入下一次准入请求的变化提示，原目录保持冻结。
- 未 prepared Recap 可被 Finalize 中止；prepared Recap 在 Finalize 到达后补完本地提交，后者只消费剩余区间。
- 普通模型请求和后台 prepared call 使用同一宿主能力，真实回环 HTTP adapter 覆盖成功与 HTTP 500/503 后恢复。结构两次不合法后第三次成功；五次不合法标 failed，/acn-status 可见，原 job ID 可 retry。
- 没有本会话 request/header 且没有配置后台路由时，不调用模型，失败提示包含 llm.provider / llm.model 与 retry 操作；不使用其他会话路由。显式后台路由可在第一次普通请求前工作。
- 单人形成期间 fetch 为零，私有 MEMORY / USER 实际存在但其标记不进入输入，上传目录不存在；本地 Dispute 可保存。团队模式可靠入队，网络投递未在本阶段启动。

## 并发与恢复

- 多 worker / 双进程共享同一租约，固定优先级与 FIFO、running 恢复、五次退避上限、失败持久化、手动重试和卸载取消均通过。
- 七个真实 SIGKILL 点覆盖 prepared、Claim、进度、Trace、上传队列、applied、游标 rename；反复恢复不重复产生实体或上传条目，恢复不用模型，处理中断的任务可由新 worker 完成。
- 模型分析在知识锁外；用户编辑可立即完成，旧分析在提交时被判过期，保留用户编辑。精确部分写入、缺少分析快照、外部变化与目标退出方案等源端恢复测试均通过。
- 增量投影先同步正文后推进游标，恢复未完成尾行及 append / state 间隙；主文件容量不足时保留未处理分片，核对重复 seq，成功后回收。job ID、checkpoint 会话标识与文件位置不一致时拒绝恢复。

## 工程与安装

- Node `22.23.3` 与 `24.22.0`、pnpm `11.25.0`：冻结锁文件离线安装、typecheck、lint、安全扫描、244 项测试（21 个文件）、build、pack、smoke:install 全部通过。M3 新增 60 项测试，源端 claim_alignment.rs 两项测试全部移植。
- 两种 Node 环境均在临时 DSH_HOME 实际安装 tarball，验证 formation / formation-core、模板、声明和隔离；按 CLI runtime resolution 启动已安装包，执行普通会话及 /acn-finalize，实际得到一个 Claim 与一个 Trace。八个 Loader 场景覆盖新增行禁用与卸载。
- 六组模板快照与真实 Rust PromptRegistry 渲染逐字相等。原有 32 组协议 JSON、9 组 revision 及 32 组 TypeScript YAML 的 Rust 读回保持通过。Rust 导出器格式、Shell 语法和 git diff --check 通过。
- 全部模型测试使用脚本或本机回环，未调用外部 LLM / 团队服务，未把 schema 正确等同于真实知识质量。未提交或推送，未将本地矩阵记为远端 CI 已运行。

测试到源码的映射和差异见 [M3 测试覆盖](m3-test-coverage.md)、[ACN 兼容记录](acn-milestones.md)、[DSH 兼容记录](dsh-milestones.md)。后续按 M4 接入团队 HTTP 客户端与契约测试。

# M4 本地验收记录

日期：2026-10-22。ACN `0.3.3` / `c542b19`，DSH `0.2.1-rc.2` / `687f282e`。分支 `feature/m4-team-mode`；参考仓库源码及工作区保持不变，未提交、推送或运行远端 CI。

## 团队链路

- 使用真实 `acn-router` / `acn-maintainer`，团队/admin 鉴权开启，监听随机回环端口，共用临时团队数据根。agent-a / agent-b 各上传自身 Claim，Router 实际查询与概览可见。
- 管理 API 发布 PolicyUpdate 和普通 CAU，插件 pull → 逐条持久化 → ACK → 入队内化 → 生成带 Policy 来源的 Claim/Trace → 再上传；Policy 撤回无需模型，直接废弃本地直接依赖并上传。跨 holder upload / ACK 返回 403，错误 key 与身份不匹配返回 401。
- Dispute 成功上报后可从真实管理 API 回查。同一 ID / 同一正文重送成功，同一 ID / 不同正文返回 409。代理注入 HTTP 500、关闭监听产生连接拒绝后队列保留，恢复转发后空闲补传自动送达，真实 Router 查到结果。
- HTTP 信封、前缀、环境凭据轮换、代理/回环绕过、408/429/5xx 重试、正文超时、取消、旧 ACK 路由与异常响应均验证。POST health 在团队鉴权开启而缺少结果时不误报成功。日志与错误不保留 key、请求体或响应正文；真实服务日志也逐值检查测试凭据未泄露。
- 鉴权失败只出现一次警告，真实 AgentLoop 继续普通本地会话；连接状态分别记录 Router 和 Maintainer。单人模式团队 transport 和全局 fetch 调用均为零，不创建上传目录，不把本地 Dispute 记为已上报。

## 内化、并发与恢复

- 70 条连续 CAU 一次调用与一个 canonical journal，其余成员保存 refs。仲裁快照完整性、holder、direct deprecated 恢复、非 direct 可编辑集合、历史来源/Dispute 权限、多 Policy 归因和已解决语义输入抑制均验证。
- ACK 404/503 仍处理本地快照；本地持久化失败只 ACK 成功前缀；pull 失败仍可内化本地消息。结构化重试预算与输入稳定、失败释放租约、激活回收孤儿 processing、Dream pending 延后均验证。
- 9 个真实 Inbox SIGKILL 点与 3 个真实投递 SIGKILL 点全部通过：固定实体 ID、Trace、Dispute、队列和 done 均可恢复；记账前以同 ID 重送，记账后跳过重复。缺失 ref 可修复，冲突 ref、成员被改写和当前消息快照变化在效果写入前拒绝；外部 Claim 修订会使旧计划剩余部分失效。
- 网络和模型期间知识/队列数据锁可取得；应用时在知识锁内 durable stage，然后再标 applied。投递单飞，id+revision 精确清理保留并发新版本，Dispute 等待待上传依赖；队列/台账故障不丢数据。
- Formation / Inbox 共用知识服务 worker。禁用 Formation 后 `/inbox` 仍使用宿主模型完成内化；禁用 Inbox 会撤销命令、保留任务。后台结果触发下一请求的 Claim 变化提示，冻结目录保持不变。

## 工程与安装

- Node `22.23.3`、`24.22.0` 与 pnpm `11.25.0`：冻结锁文件离线安装、typecheck、lint、安全扫描、**326 项常规测试（28 个文件）**、**3 项真实契约测试**、build、pack、smoke:install 全部通过。相对 M3 常规测试新增 82 项。
- 两个 Node 环境均完成 32 组协议 YAML 的实际 Rust 读回，原有 JSON/revision 基准保持通过；8 组模板由真实 Rust PromptRegistry 生成并与内存模板引擎逐字比较。
- 九个 Loader 场景覆盖六行组合及单行禁用、隔离与卸载。两种 Node 下均实际安装 tarball，再通过 CLI 相同的 runtime resolution 加载安装包，执行普通请求、Finalize 和本地 Inbox，得到 **2 Claim / 2 Trace / done**。
- 发布包包含 inbox/team/upload 核心入口、插件行、模板、类型声明和公共 chunk；Shell 语法、Rust 导出器格式、CI YAML 的必跑契约矩阵及 git diff --check 通过。远端 CI 需配置参考仓库变量；不把本地成功当作远端结果。

M4 范围已完成。M5 的 consolidation 依赖交付保持延期，已有依赖和 acknowledgement 数据保留。完整源用例映射与差异见 [M4 测试覆盖](m4-test-coverage.md)、[ACN 兼容记录](acn-milestones.md)和[已知限制](../outstanding-issues.md)。

# M5 本地验收记录

日期：2026-10-22。分支 `feature/m5-dream`。ACN `0.3.3` / `c542b1931f72cb905b502bd0f5b3a6efd99affb6`，DSH `0.2.1-rc.2` / `687f282e`；参考仓库源码保持干净。

## 整理、并发与恢复

- 自动资格覆盖激活、会话创建、四小时定时、24 小时成功冷却和不同 Claim 变更数；手动绕过门槛，禁用阻止两种入口。零修改、明确保留、候选完整性、质量废弃简写、整合覆盖/来源/置信度、防环和最终名称校验通过。
- 全文引用验证四字段双向覆盖，包含条件、否定、备选行动、数字和比较符号；错侧/错 ID、旧哈希、废弃承接、新证据和事实纠正均拒绝。模型可据反馈修复或保留原样；未把测试通过称为语义正确。
- 锁等待和模型调用可停止，已接受草稿及已完成组保留；prepared 前取消无写入，prepared 后完成本组再暂停或卸载。高优先级 Inbox 可抢占，停止与让位不消耗 Dream attempt。关闭后重新加载恢复本地回执，不重放模型。
- 并发重复提交去重、两个旧快照竞争、当前全图来源环复查、手动排队合并、审计失败阻止效果、恢复失败阻止领取其他任务且 attempt 为零均通过。独立进程在模型等待和 prepared 两个阶段只写共享暂停标记，持有者均正确停止并沿原 job 继续。承接在 HTTP 期间改版时旧 ACK 不能释放来源弃用，并发新版本留在下一轮。
- **18 个真实 SIGKILL 边界**覆盖逐组提交、最终 checkpoint 和同步重绑。另有 **2 个强杀后并发第三版本场景**，验证保留用户编辑、已落盘效果、跳过剩余旧计划及未满足的上传依赖。反复恢复不增加实体或队列条目；最终提交才更新成功冷却。
- 上下文超过半预算时归档完整已处理记录、提交有界预览与四字段摘要；压缩传输失败后保留已生效组，重试从压缩继续。Dream 输入没有私有双文件、Dispute 或 transcript 内容。

## 契约、工程与实际安装

- Node **22.23.3 / 24.22.0**、pnpm **11.25.0**：冻结锁文件离线安装、typecheck、lint、安全扫描、**431 项常规测试（34 个文件）**、build、pack 与 smoke:install 全部通过。相对 M4 新增 105 项常规测试；其中 95 项为 Dream 领域与宿主流程场景，其余为兼容、模板和 Loader。
- 两种 Node 均通过 **4 项真实 Router / Maintainer 契约测试**。新增 Dream 场景先注入承接上传 503，确认来源弃用未送出；服务恢复后记录实际 Maintainer 的承接 200 → 来源 deprecated 200，并由真实 Router 检索到完整存续正文。
- 两种 Node 均完成 **39 份 TypeScript YAML 的 Rust 读回**；新增 Dream 私有字段镜像、旧字段默认值、字段空白保留与 Validation 哈希测试。原有 32 份 JSON 字节、9 份 Claim revision 保持通过；**10 份模板快照**由参考引擎生成并逐字比较。
- **10 个 Loader 场景**覆盖七行组合、隔离、单行禁用和卸载。两种 Node 均在临时 DSH_HOME 实际安装 tarball，从安装目录导入 dream-core 及声明，再按真实 runtime resolution 启动已安装插件，执行普通请求、Finalize、Inbox、Dream，确认 **2 Claim / 4 Trace / done / Dream report**，其中一条 synthetic Claim 被质量清理。
- Rust 导出器格式、Shell 语法、git diff --check 通过。M5 代码与源用例映射见 [测试覆盖](m5-test-coverage.md)；远端 CI 未运行，未提交或推送。

本地代码复查及上述检查已完成。独立只读 CLI 审查按既有 code-review 流程调用，因配置的默认模型 `gpt-6.1-sol` 不受该 CLI 登录方式支持而返回 400，未生成可用结论；未将其记作通过，也未更改用户模型配置。真实模型的知识质量抽样仍属于 M8，证据校准与私有 Memory 分别属于 M6、M7。

# M6 本地验收记录

日期：2026-10-22。分支 `feature/m6-evidence-calibration`。ACN `0.3.3` / `c542b1931f72cb905b502bd0f5b3a6efd99affb6`，DSH `0.2.1-rc.2` / `687f282e`。参考仓库源码保持干净；保留此前未提交的 M0–M5 工作，没有提交、推送或运行远端 CI。

## 证据、权限与恢复

- 校准默认关闭；启用后仅自身原始 medium/low 进入 B。high 不能先降级再校准，也不能借 A/C 声明事实纠正。无独立新证据时允许明确保留，原 Claim 不变；质量清理和纯重组继续可用。
- 真实版本文件读取先预占预算，回执持久后才响应工具；校验完整 SHA-256、字节数、实际页、逐 Claim 授权和原始 revision。事实修改与置信度提升都要求对应直接证据、新 evidence_summary 和逐字证据复核。虚构、无版本、跨 Claim、旧 Claim/Trace、命令输出和错误引文均不能授权。
- 工作区从可信命令会话/最近普通会话 cwd 冻结，模型不能换根。真实 I/O 覆盖越界、路径遍历、私有数据根、Memory/USER、环境/凭据/隐藏文件、符号和硬链接、非普通文件及非 UTF-8。glob/grep 做有界字面搜索，仅定位；返回文本保留完整行并显式标记截断。
- 真正创建宿主子会话：发布前 restrict 清除继承，强制 native、注册插件四个只读工具并安装单调 guard。native/PTC 主环境中，全局和后加 scoped 工具、run_code、Claim 写入均被实际拒绝；策略 allow 和参数改写不能绕过。完整系统段与 required context 遮蔽验证私有标记不进入请求，子会话不进入形成投影，也不触发 Inbox/Dream。
- 并发工具读取无丢失回执或预算；两个并发子会话保持各自工作区和清单。调用、步数、字节及搜索预算跨失败和重启保留，完成清单不能追加；超时、停止和步数耗尽均停止并排空子循环。
- **11 个不同真实 SIGKILL 边界**：权限清单、调用预算、读取回执、查证完成、prepared、pending、首个 Claim、组完成、Trace、applied、DreamState。另有 **2 个强杀后证据过期场景**，分别在 prepared 和部分 Claim 写入后改文件，恢复保留已生效目标并跳过剩余写入。没有用异常注入代替这些进程强杀测试。
- 查证后/复核期间文件改版时不应用旧授权；完成清单在重试时复用，不再次探索。prepared 恢复直接核对清单和文件，不调用模型或查证工具。真实 I/O 故障阻止恢复和其他任务领取，attempt 保持零；修复后固定目标继续完成。

## 工程、协议、契约与安装

- Node **22.23.3 / 24.22.0**、pnpm **11.25.0**：冻结锁文件离线安装、typecheck、lint、安全扫描、**520 项常规测试（39 文件）**、build、pack 和实际 smoke:install 均通过。相对 M5 新增 89 项；M6 领域及宿主流程占 85 项。
- 两套 Node 各通过 **5 项真实 Router/Maintainer 契约**。新增场景从 low Claim 开始，真实工作区证据支持范围修正和 high 输出，经实际 Maintainer 上传后，Router 返回精确正文与置信度；原有团队、故障补传和整合依赖契约继续通过。
- 两套 Node 各完成 **41 份 TypeScript YAML 的 Rust 读回**，新增带版本证据的 Validation / Checkpoint 镜像与哈希；**11 份模板**由真实 Rust PromptRegistry 生成并逐字比较，9 组 Claim revision 保持通过。镜像私有格式没有冒充源私有类型的直接调用。
- **11 个真实 Loader 场景**；实际 CLI 安装 tarball 后按运行时解析加载安装目录的插件。默认关闭流程与显式开启校准流程均得到 **2 Claim / 4 Trace / Inbox done / Dream report**；后者确实创建受限子会话读取临时文件，并把 medium Claim 修订为有新依据的 high Claim。
- Rust 导出器格式、Shell 语法、M6 文件相对基线的 whitespace 检查及 git diff --check 均通过。两套包保存在 `.artifacts/m6-node22/`、`.artifacts/m6-node24/`。完整映射及实现边界见 [M6 测试覆盖](m6-test-coverage.md)。

本地代码复查已完成。独立只读 CLI 审查再次使用配置的默认模型，仍被登录方式/模型兼容错误 400 阻断，没有可用结论，未记为通过。当前仅开放规划白名单中的文件只读子集，不暴露 Web 或命令；旧外来 safety_reviews 缺少插件授权清单时明确拒绝恢复。真实外部模型的语义质量和私有 Memory 分别留在 M8、M7。

# M7 本地验收记录

日期：2026-10-22。分支 `feature/m7-private-memory`。ACN `0.3.3` / `c542b1931f72cb905b502bd0f5b3a6efd99affb6`，DSH `0.2.1-rc.2` / `687f282e`。参考仓库保持干净，保留此前 M0–M6 未提交工作；没有提交、推送或运行远端 CI。

## 已实施与修复

- 双文件、bulk ops、唯一条目匹配、去重、字符容量、可关闭的安全扫描；整批失败保持原始文件。M7 核对当前 config.rs，容量默认值为 **1600 / 1000**，修正方案早期示例。
- 双文件短锁、固定 before/after pending、逐文件原子写、完成回执与调用身份去重。恢复保留外部第三版本和已生效文件，完成回执不会覆盖后来的外部编辑。
- 会话冻结快照、真实 resume、新会话刷新、clear/compact/fork 与子会话隔离；Memory 工具即刻落盘但不刷新原系统段落。
- 普通文件工具 canonical 路径保护，覆盖其他 Agent、state/receipt、符号/硬链接、搜索祖先和实时 cwd；使用真实 fs-local、文件工具、subprocess/ripgrep。正常审批能执行公共路径，审批后 cwd 变化仍拒绝。Memory 关闭或单行禁用时保护仍在。
- 独立私有 review 窗口、完整人工 turn 计数、Unicode 裁剪标记、原子窗口/outbox、引用式持久任务和跨状态去重；结构化输出与安全校验、并发编辑 CAS、固定 checkpoint 无模型恢复、卸载取消/重新消费。
- native 及程序桥的私有参数/结果/外层程序回显过滤，公共子工具 Claim 正文与来源仍可引用。修复 worker 在领取 I/O 期间处理器卸载的竞态，任务退回 queued 后可继续。
- **16 项真实 SIGKILL 场景**，覆盖 10 个不同发布边界，包含冻结 state、双文件部分发布、回执、review prepared/applied、outbox/enqueued；恢复不重放已提交 replace，不重复请求模型。

## 最终验证

- Node **22.23.3 / 24.22.0**、pnpm **11.25.0** 各通过：冻结锁文件离线安装、typecheck、lint、仓库安全扫描、**669 项常规测试（46 文件）**、build、pack、smoke:install。相对 M6 新增 149 项；M7 专属 7 个测试文件共 135 项，其余为公共 worker 回归、兼容、模板和 Loader。
- 两套 Node 各通过 **6 项真实 Router/Maintainer 契约**。新增 Memory 场景在健康团队服务可用时执行私有写入及 review，断言不调用上传、团队查询或收件，也不产生上传任务；随后真实 Router 查询不含私有标记。
- 两套 Node 各完成 **47 份 YAML 的 Rust 读回**，Memory 新增 6 组使用公开 Rust 类型；**15 份适配模板快照**和 9 组 Claim revision 保持通过。
- **14 个真实 Loader 场景**；三条实际 tarball 安装流程覆盖默认、证据校准、Memory。Memory 流程执行真实工具写入、当前冻结段落不变、新会话读取新值和持久 review；原有 Claim / Inbox / Dream 及受限证据 child 继续通过。
- 两套包保存于 `.artifacts/m7-node22/`、`.artifacts/m7-node24/`，完整日志保存在当次验收的临时目录。Rust 导出器格式、Shell 语法、差异空白检查和源仓库 clean 状态另行核对。

本地代码复查已完成。按既有 code-review 流程执行了一次独立只读 CLI 审查；配置的默认模型 `gpt-6.1-sol` 再次因登录方式不支持返回 400，JSONL/stderr 保存于本机临时目录，没有可用审查结论，未记为通过。

保护范围明确限定为已知文件工具与写/编辑意图，不提供 OS 沙箱；任意 shell/直接 I/O/自定义工具、对抗性路径竞争和远端 provider 未作隔离保证。结构过滤不证明普通回答的语义上绝不泄漏；review 使用已配置的模型供应端。真实模型质量评估及发布工作仍属于 M8。源用例对应见 [M7 测试覆盖](m7-test-coverage.md)，接口和分隔符差异见 [ACN 兼容记录](acn-milestones.md)。
