# ACN 协议与存储兼容记录

## M1 基线

已验证的 ACN 服务端版本：`0.3.3`，提交 `c542b19`。完整哈希保存在 `tests/fixtures/protocol/manifest.json`。公开 DTO、序列化、revision、本地文件格式与真实 Router / Maintainer HTTP 链路均已验证；完整证据见 M4 测试覆盖与本地验收记录。

`src/protocol/` 提供 Claim、Trace、Dispute、Policy、Inbox、仲裁上下文、Router 查询/overview、鉴权与健康探针的 schema 和类型。`src/store/` 提供实体文件、上传队列、去重台账、租约状态机、编辑恢复和插件私有文档的基础 I/O。

## 兼容证据

- `scripts/export-acn-fixtures.sh` 在临时 crate 中引用参考仓库，导出 32 组 JSON / YAML 与 Claim revision；参考仓库源码保持不变。
- 公开 DTO 由 ACN 真实 Rust 类型反序列化并序列化。上传队列、编辑恢复记录、去重台账是私有类型，导出器按当前字段和 serde 属性复刻，manifest 明确标注这三个格式。它们的验证不等同于调用了私有类型自身的反序列化代码。
- 每组报文的 TypeScript JSON 与 Rust JSON 逐字节相等；所有 Claim revision 相等。测试随后生成 TypeScript YAML，由 Rust 类型读回并再次比较规范 JSON。
- YAML 不承诺同一种引号与转义写法；空字符串单双引号和混合控制字符的空白转义存在差异。差异经过 Rust 读回验证，不影响数据或 revision。
- `tests/fixtures/acn-home/` 同时包含 Rust 导出的 Claim、Trace、Dispute、Inbox、队列、台账、编辑记录和中性私有双文件；存储测试从完整目录读取。

## 对方案摘要的修正

| 项目 | 按当前源码实施的规则 |
| --- | --- |
| 可选字段 | 只对带省略属性的字段省略；`AgentQuery.semantic_query` 未配置时序列化为 `null` |
| 时间 | UTC AutoSi，保留 3/6/9 位精度；更长的小数按参考实现截到纳秒，支持闰秒；UTC 规范年份限制为四位，原因见已知限制 |
| Resolution ID | 读取兼容 `arbitration_` 前缀，并保留原字符串；字段名别名规范化，重复新旧字段视为错误 |
| Dispute | 旧存储可读单条或空 Claim 集合；上报的生命周期检查只允许 open 且无 resolved_at。形成阶段的至少两条约束在 M3 执行 |
| 整合记录 | `{ before: Claim, retired: Claim, carriers: Claim[] }`，包含完整版本快照 |
| 去重台账 | `{ reported_claim_sets: { <sorted-key>: { first_dispute_id, reported_at } } }`，保留首条记录 |
| 编辑恢复 | 正文仍是 expected revision 时丢弃未完成编辑；正文已变化时上传当前版本，完成持久入队后清除记录，不重放旧 target |
| Inbox 重投 | 现有 pending / processing / done 都必须读回并校验快照，只有 handled_at 可不同；损坏或冲突不能当成已收件 |

引用路径相对于参考仓库：`src/claim/`、`src/time.rs`、`src/router/{traits,overview,debug}.rs`、`src/auth.rs`、`src/agent/{fs,claims,maintainer_upload,consolidation_delivery}.rs`。

## M7 私有 Memory

当前导出器共生成 47 组协议/持久格式报文，Memory 新增 6 组使用真实公开 Rust 类型：MemoryOp 数组、MemoryUsage、普通/空 MemorySnapshot、当前/旧字段 MemoryApplyReport。TypeScript 生成的 YAML 再由相同类型读回。旧报告缺少 target、target_entries、no_op、message 时沿用源端默认值；工具入口额外使用严格字段校验。15 份适配后模板快照均由参考 PromptRegistry 渲染，再与本地引擎逐字比较。

| 边界 | 实际兼容结论 |
| --- | --- |
| 工具接口 | 参考工具当前是单 action/content；插件按交付方案使用 `{ops:[{op,...}]}`。op 元素与真实 MemoryOp 相同，不声称工具请求原样互换 |
| 默认容量 | M7 核对当前 config.rs 后使用 MEMORY 1600、USER 1000；修正方案示例原有 8000/4000，允许显式配置其他容量 |
| 条目 | 读取兼容紧凑 `\n§\n` 和方案 `\n\n§\n\n`，去空/去重、Unicode White_Space 修剪、唯一条目匹配后整条替换/删除一致 |
| 分隔符和容量 | 插件写回方案分隔符；每个条目间隔比参考多两个字符，所以多条目容量数字及边界可能不同。Unicode 字符计数与单条目用量一致 |
| 安全扫描 | 共用已移植的不可见字符和危险模式；只扫描 add / replace 新值，允许 remove 旧危险内容，可显式关闭扫描 |
| 私有边界 | 插件按方案更严格隔离双文件，不把它们作为 Claim 形成输入；四份 Memory 模板按 bulk 工具及冻结规则适配，非参考原模板的逐字复制 |
| 持久事务 | 参考双文件顺序写入；插件复用原子 I/O 增加 pending/receipt，保证自身恢复和调用重放。review/window/request/checkpoint 均为插件私有格式 |
| 会话与 review | 使用宿主生命周期、独立私有窗口和共用 durable worker，代替原运行时 memory review loop；本会话路由、零操作、并发编辑跳过和 prepared 恢复均有测试 |

这些验证不允许两个运行时共用数据目录或接管彼此尚未完成的私有任务。引用参考：`src/memory.rs`、`src/memory_safety.rs`、`src/tool/memory.rs`、`src/agent/fs.rs`、`src/agent/session_engine/memory_review.rs`。

## 并发和恢复边界

- 原子写为独占创建临时文件 → 写入与 fsync → rename → 尝试同步父目录；只清理超过一小时的临时文件，读取忽略临时文件。预先存在的同名临时文件或符号链接不会被覆盖或删除。
- `proper-lockfile` 使用同名 `.lock` 目录和心跳；ACN 使用系统文件锁。锁名称一致，锁机制不同，因此继续遵守独立数据目录约定，不与 ACN 进程共用目录。
- 获取锁默认超时 30 秒，失去心跳的锁 30 秒后可接管；知识锁先于上传队列锁，多文件锁按路径排序。释放失败不会覆盖原始业务错误。
- Inbox 领取时刷新 mtime，使租约年龄从领取时开始，避免旧 pending 文件刚被领取就过期。旧租约不能完成另一持有者重新领取的消息。
- 单人模式不创建、读取或消费团队上传队列；已有团队编辑记录保持原样，恢复团队模式后再处理。
- Claim 与编辑记录的原始写入由上层知识事务持有知识锁；单文件原子写保证读取者看到完整版本。Memory 这里只提供双文件锁与单文件原子写，条目操作和安全规则在 M7 接入。
- session/job 文档只提供 `schemaVersion: 1` 的持久化；队列调度、LLM、inbox effect 应用和 Dream 不在 M1 执行。

## 重现

已知时间边界：`9999-12-31T23:00:00-02:00` 和 `0000-01-01T00:00:00+01:00` 能被参考实现解析，但规范序列化后分别含 `+10000` / `-0001`，参考反序列化器拒绝读回。插件明确拒绝这两类超界输入；导出器保留源端反例断言，单元测试覆盖拒绝行为。详见 `outstanding-issues.md`。

```sh
ACN_REPO=/path/to/reference pnpm fixtures:export
ACN_REPO=/path/to/reference pnpm test:compat
pnpm test
pnpm smoke:install
```

导出器核对参考包版本为 `0.3.3`，默认使用参考仓库的 target 缓存。只有本机已有依赖时才设置 `CARGO_NET_OFFLINE=true`。默认 Node CI 使用已提交基准；Rust 读回由 `test:compat` 在有参考源码的环境执行。

## M2 Claim 行为

Claim / Trace 的分页字段、默认上限、有界摘要、只读权限和排序沿用 `src/agent/claims.rs`。CAS 修订保留身份与来源字段，校验 holder、安全文本及 expected revision；时间使用源端的 `max(now_seconds, previous+1s)`。读取与后续修订都可恢复已落盘的团队编辑记录，修订的恢复和重读在同一个知识锁临界区执行。

模型参数动作专属，不接受无关字段；可选字段的显式 null 按源端 Option 语义读取。工具描述沿用源端英文，规范 JSON 的分页/详情/修订结果保持相同字段；revision conflict 按插件方案单独返回 `{conflict:true,current_revision}`。

静态知识模板提取了 Claim 定义、目录使用纪律和数据边界；团队配置才包含 Dispute / Policy 定义。目录改为方案指定的有界单行身份列表，完整基线仍包含未显示实体。变化提示沿用相对冻结基线的累计身份差异，追加 status 便于直接判断条目状态。模板跨引擎比较范围见 `m2-test-coverage.md`。


## M3 形成与恢复

复盘 schema 与 `session_engine/finalize.rs::recap_output_schema()` 字段和约束一致：四个数组必须存在、所有属性必填、禁止额外字段、Dispute 至少两条不同引用。新对象按数组位置声明占位符，全文字符串引用解析为固定实体 ID；更新保留 holder / created_at，更新时间严格递增，来源列表完整替换并去重。新 Claim 默认 active，自引用、不可见 Policy、重复更新、越权更新和非法 Dispute 在任何实体写入前校验。

`knowledge/alignment.ts` 移植 `claim_alignment.rs` 的内容比较、精确目标识别、缺少分析快照时判旧，以及普通读取跨整理提交的边界；源模块两项测试全部移植。恢复保存 analysisClaims 与 appliedClaims，识别写盘后尚未记录进度的目标；外部修改后放弃剩余 Claim / Dispute，保留已执行结果，不再调用模型。新 checkpoint 是插件私有格式，游标使用 DSH seq，不声称与 Rust 的 session 文件互读。Claim / Trace / Dispute 仍使用同一协议 DTO。

相对源端明确采用方案的差异：

| 边界 | 当前源端 | 插件行为 |
| --- | --- | --- |
| 引用可见性 | prepare.rs 从 transcript 任意正文提取合法格式 Claim ID | 仅本地 active/stale 正文和会话已展示完整实体；目录 ID 或用户文本中的裸 ID 不授权；历史 provenance 仅可继续作为 provenance |
| 伪造 used IDs | 让整批 prepare 失败 | 按 M3 验收丢弃并告警；非法 source / Dispute 仍整批重试 |
| 单人 Dispute | runner 的团队分支才落上报与记录路径 | 按插件方案保存本地 Dispute，单人始终不入队、不发团队请求 |
| 准备时的知识锁 | 源端 finalize 临界区覆盖模型准备 | 模型调用在锁外，提交前对完整分析快照重新核对；并发编辑使旧方案失效 |
| Trace task | 参考会话的原始分段任务记录 | DSH 投影中的用户任务文本，有界 16000 Unicode 字符；保留输入 / 输出引用关系 |
| 队列提交 | 本地 checkpoint 与 stage_maintainer_batch 协作 | 持知识锁时持久入队后才标 applied，HTTP 在 M4 的锁外投递阶段接入 |

Recap / Finalize 共用处理水位，prepared 之后完成提交，之前允许 Finalize 抢占 Recap。七个真实 SIGKILL 点分别覆盖 prepared、首个 Claim 落盘、进度落盘、Trace、上传队列、applied 和游标 rename 前；反复恢复不重复生成 ID、实体或上传条目。孤儿锁测试在进程终止后把 mtime 移到到期窗口，验证实际锁库接管，不声称在真实等待 30 秒前能够接管。

M3 只测试本地模型与回环 HTTP，没有实际外部 LLM 或团队网络调用。知识质量的真实模型抽样、团队服务契约分别留在 M8、M4。

## M4 团队链路与内化

真实 ACN binary 共用临时 `data/team/`，启用团队鉴权和管理员鉴权，关闭远端检索/仲裁模型能力。契约测试跑通 upload/query/overview、PolicyUpdate、普通 CAU 建议、pull/receipt ACK、内化后再上传、Dispute report 和撤回。跨 holder upload/ACK 返回 403；错误 key 或 key/agent 不匹配由实际服务返回 401。

客户端以当前 `router/http_client.rs`、`maintainer/http_client.rs` 为准：Router 401/403 和 Maintainer 401 为 auth，Maintainer 403 为 client，408/429/5xx/连接错误/超时可重试，ACK 的 404/405 单独提示旧路由。实现沿方案加入 ±20% 抖动；不保存错误响应正文或原始异常。回环直连、其他地址使用环境代理的实际传输已验证。

内化权限、仲裁完整性、连续 CAU 合批、特定 Policy 归因、重复 resolved 语义输入抑制、整批最终状态与历史 provenance 对齐当前 `agent/inbox.rs`。PolicyUpdate 撤回只处理直接依赖。Inbox 模板保留源端内化纪律，仅把新 Claim 的 status 说明适配为严格 schema；通过 Rust 模板引擎逐字快照核对。

明确的宿主与持久化差异：

| 边界 | 插件处理 |
| --- | --- |
| 同步启动处理 | DSH 将同步与内化排入后台 inbox 任务；`/inbox` 先同步、显示 receipt 计数后入队 |
| 模型 transport | 统一经宿主 prepareCall/stream；没有自行选择 provider buffered fallback 或 Supervisor IPC |
| InternalizeOutcome 解析 | 按结构化 schema 要求三个数组完整且禁止额外字段；源端 Serde 对省略/null 数组更宽松。新 Claim 不接受额外 status，始终初始化 active |
| journal 范围 | PolicyUpdate、撤回和 CAU 均有 prepared/applied journal；canonical/ref 是插件私有结构，不与 Rust effect 文件互读；实体 DTO、上传队列及去重台账互通 |
| stale 边界 | 模型在锁外分析，提交时比较完整本地快照，比仅可编辑集合更保守；外部修改后保留已执行结果并丢弃旧方案剩余效果 |
| 上传鉴权失败 | 按插件方案保留所有 durable Claim/Dispute；源端部分普通 Claim 的 auth 失败分支会丢弃普通上传项 |
| Dispute 集合台账 | 服务确认后记录；已持久化待送队列在失败时保留。HTTP 成功与本地记账间崩溃以相同实体 ID 重送，依赖服务端的实体幂等性 |
| 整合交付 | 属于 M5；本阶段不投递 consolidation retirement，保留依赖和 acknowledgement-only 数据 |

9 个 Inbox 和 3 个上传真实 SIGKILL 点、台账/队列故障、401/503 与连接拒绝后自动恢复均有回归。单人模式不构造团队客户端，不请求团队服务，不创建队列或把本地 Dispute 标为已上报。完整源用例分组及延期范围见 `m4-test-coverage.md`。

## M5 整理与整合交付

DreamState、Checkpoint、PreparedGroup、ExecutionMeta、SemanticReview 与 SelfReview 的持久字段逐项对照 `dream.rs`、`dream_plan.rs`、`dream_execution.rs`、`dream_review.rs`。`dream_pending.yaml` 仍是指向 checkpoint 的 YAML 路径字符串；插件限制其落在本 Agent 的整理目录或最终 checkpoint 目录。初始快照、候选进度、同步日志和摘要使用插件私有格式，不能与源运行时共用数据目录。

新增七份夹具后共 39 份：空/完整 DreamState、pending 路径、旧空 checkpoint、逐组 checkpoint、旧组/名称字段默认值、Validation 输入与哈希。导出器镜像私有 Rust 类型，并实际 Rust 读回 TypeScript YAML；这不等于调用不可公开访问的源端私有类型。原有 32 份公开/存储格式仍比较 JSON 字节、9 份 Claim revision；Dream 内嵌 JSON Value 会排序键，比较结构语义和 Rust 读回。验证包含字段空白保留，不能因 trim 改变旧记录和哈希。

| 项目 | 当前实施与差异 |
| --- | --- |
| 内容版本 | Claim 内容哈希为既有 revision 的原始 SHA-256；Validation 按通用 JSON Value 的递归有序键计算，含空 `unversioned_evidence_omitted` |
| 草稿与复核 | 固定候选的结构化阶段替代源工具循环；展开 keep/update/deprecate，再硬校验；复核覆盖四字段、名称及完整信息去向，无修改配额 |
| 证据权限 | M5 比完整源能力更窄：没有证据组、文件/命令读取、证据回执或事实纠正，不能提高置信度；含证据依赖的未完成提交会阻止恢复，不能跳过校验 |
| 提交与恢复 | 固定 before/after、Trace 和验证版本；按存续后废弃写入，在知识锁内 stage 上传依赖。pending 指针及指针前 prepared 均可恢复，不依赖远端；第三版本使剩余组效果跳过 |
| 成功冷却 | 逐组更新自身版本；仅最终提交更新 last_success_at、last_input_snapshot_at 和已知版本，部分执行/停止不提前冷却 |
| 依赖交付 | 对当前精确 Claim 与完整 ACK 核对，递归沿显式后续整合链寻找已确认存续承接，拒绝空承接与环；清理保留传递链 |
| 修订与重绑 | 普通修订不会自动认可旧承接；重新读取、版本哈希绑定、来源保留和语义复核后重绑，只改变持久队列。false/applied 同步记录支持恢复 |
| 宿主上下文 | 自管有界阶段并移植 dream_compaction；没有源端 supervisor IPC、通用自主工具调用或宿主子代理，不声明这些接口相同 |

详细测试对应关系见 [M5 测试覆盖](m5-test-coverage.md)。功能测试与自复核不能代替真实知识质量评估。

## M6 证据协议与恢复

参考 `dream_plan.rs`、`dream_review.rs`、`dream_execution.rs`、`tool/file.rs`、`tool/dream_sandbox.rs`：只有 file_read 且带 file_version 的回执可作为独立证据。版本为原始文件完整 SHA-256 与 byte_len，引用可匹配原始输出或经严格页码确认去除显示行号的正文。所有类别的置信度提升、B 实际修改和声明的事实纠正都需要对应 Claim 的直接证据及新 evidence_summary；原始 high 禁止纠正，包括 A/C 混入与先降级。

新增 dream-validation-evidence 与 dream-checkpoint-evidence 两份 Rust 私有类型镜像 fixture，总计 41 份 YAML 往返；Validation 哈希包含证据及其版本。新增 dream_evidence 模板由真实参考 PromptRegistry 渲染，当前 11 组模板逐字比较。公开实体和 9 组 Claim revision 算法未变化。

| 边界 | 插件当前适配 |
| --- | --- |
| 探索工具 | 自建只读 read/grep/glob/claim，属于规划白名单子集；不开放命令或 Web，没有移植源端通用 code_run / OS shell sandbox |
| 直接证据 | 回执额外绑定 input.claim_ids 和插件工作区/候选版本清单；逐 Claim basis 不能借用其他候选的读取 |
| 权限与预算 | canonical 工作区、私有根及隐藏/凭据路径保护、无符号/硬链接；每组持久的工具/步数/字节/文件上限 |
| 恢复 | 未完成组重检真实文件版本，过期跳过剩余效果，已生效结果保留；没有模型或团队网络依赖 |
| 旧记录 | M5 空 receipts 记录可读可恢复；带旧 safety_reviews 但无插件授权清单的待应用任务明确拒绝，不擅自信任外来权限 |

协议读回不代表可共享运行目录；Rust 的旧 shell 沙箱、通用工具、supervisor 和插件清单不属于同一执行环境。完整映射见 [M6 测试覆盖](m6-test-coverage.md)。
