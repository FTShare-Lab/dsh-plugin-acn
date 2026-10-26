# 当前架构

`acn-knowledge` 是唯一配置承载行，发布 `acnKnowledge` 领域服务。八个领域组件隔离 `acnKnowledge` / `acnFormation` / `acnInbox` / `acnDream` / `acnMemory`，其他七行注册工具、提示词、后台处理器和命令。未配置身份时只提供状态命令。第九行 `acn-configuration` 使用包根入口，独立承载网页配置 Remote，避免知识重载中断保存请求。

| 模块 | 当前职责 |
| --- | --- |
| `configuration.ts`、`client/` | 常用字段投影、保留高级参数、双语配置表单与并发冲突提示 |
| `dsh-adapter/configuration-*` | 严格 Remote 协议与宿主 profile 编辑器，保存前及文件锁内检查配置版本 |
| `protocol/` | 规范 DTO、ID、时间、revision |
| `store/` | 实体文件、原子写、跨进程锁、租约、队列、编辑恢复和私有文档 |
| `knowledge/service.ts` | Claim / Trace 浏览、修订、形成批次提交、知识版本与变化事件 |
| `knowledge/pages.ts` | 稳定排序、Unicode 摘要和分页 |
| `knowledge/catalog.ts`、`changes.ts`、`sessions.ts` | 冻结目录、累计身份差异与会话状态 |
| `tools/claim.ts`、`commands/` | 无宿主运行时依赖的领域分发和文本命令 |
| `prompt/`、`prompts/` | 异步预读模板、内存渲染和知识语义 |
| `knowledge/alignment.ts` | 完整快照变化核对、精确部分提交识别与恢复边界 |
| `formation/` | transcript、触发、schema、占位符与引用、prepared / applied checkpoint |
| `worker/` | 持久任务、优先级与 FIFO、单 worker、抢占、重试和接管 |
| `team/` | 鉴权信封、代理、超时/重试、严格响应解码、连接状态与警告去重 |
| `inbox/` | pull/ACK、同类消息批处理、仲裁和引用校验、撤回、批次 effect journal |
| `dream/` | 调度、候选、草稿硬校验、全文及语义复核、逐组提交、依赖重绑与报告 |
| `memory/` | 双文件纯操作、事务入口、冻结快照、私有 review 窗口 / outbox / checkpoint |
| `upload/` | 精确版本投递、整合依赖递归就绪、Dispute 集合去重、事件与空闲补传 |
| `llm/structured.ts` | schema 提示、结构 / 传输重试、取消与无正文审计 |
| `llm/response.ts` | 识别显式推理结束边界后的完整 JSON 对象，之后仍执行全部结构与领域校验 |
| `plugins/`、`dsh-adapter/` | 宿主生命周期、严格模型 schema、工具策略与注册 |

修订在 `knowledge_apply.lock` 内恢复旧编辑及已有 journal、重读正文、校验 holder 和 revision、验证新文本、推进更新时间，然后原子写正文。团队配置下依次写 pending edit、正文、持久队列，再删除 pending；锁外触发 HTTP 投递。单人模式跳过全部团队文件操作。

编辑日志恢复只将精确等于已授权 target 的正文入队；当前仍是原 revision 时丢弃未落盘日志，遇到其他版本时保留当前正文、告警并丢弃旧日志，不以“已经不同于原文”推定新版本可上传。

每个会话的 `sessions/<id>/state.yaml` 保存冻结目录及完整身份基线、最近通知版本、已观察身份和来源集合。状态更新在文件锁内合并，保留其他模块字段。提示词段落通过同步缓存读取冻结目录；`agent/created` 的 serial 监听负责完成异步准备。

变化检查在 `agent/pre-step` 的下游决定为 enter 后运行，将消息追加到返回值。宿主真正追加 `user/message` 时，插件才排队持久化去重游标；下一步骤先等待此前状态写入。拒绝或取消请求不会提前消耗通知。跨进程变化通过目录时间戳和两秒兜底的全文 revision digest 检测。

模型工具先经 `tools/pre-execute`，子代理写入还受不可撤销的最终 guard 约束。身份来自执行器持有的 SessionHeader，不接受模型参数提供的身份。工具返回规范 JSON，文本展示由 renderer 派生。

身份摘要通过宿主公开的 `appendPluginRecord` 写入 `plugin:acn/session-binding`，随会话持久化和 fork 继承；摘要只绑定本地知识根，不含私有正文。新建无继承日志的子会话须有已验证父身份，历史无绑定记录默认拒绝。Dream 和 Memory 的领域状态仍使用插件自有持久记录。


`acn-formation` 增量消费公开 session/event，投影与状态共用 session 锁，先同步正文再推进 lastSeenSeq。未处理行超过主文件 50MiB 时写入 `transcript-pending/`，先持久分片再替换主文件，最后清理副本；恢复核对重复 seq 的完整正文，冲突即拒绝。模型输入为未处理区间、全部 active/stale 本地 Claim 和形成说明。系统内容、私有记忆及 provider replay 不会进入输入。

任务保存于 `jobs/<id>.yaml`，包含状态、尝试次数、退避时间及单调 ordinal；固定优先级后按入队顺序执行。只有取得 worker.lock 的进程恢复 running 并消费。持有者每秒检查队列；其他进程在入队或每 60 秒尝试接管。租约与队列短锁独立，领域提交仍遵循知识锁到上传锁的顺序。

Dream 的暂停状态保存在共享任务中。持有者在模型等待时监听该标记，并在每个阶段边界重读；其他宿主发出的 stop 同样生效。prepared 期间先完成当前本地组，之后读取暂停标记，不能继续下一候选或最终收尾。

模型与网络调用均在知识锁外。提交时获取知识锁，恢复 pending edit 和已有形成 checkpoint，再比较分析快照。首次 prepared 前版本失效会抛可重试的 `AnalysisChanged`，不消耗原对话区间；Inbox 在生成 effect journal 前执行相同检查，不标记消息完成。prepared checkpoint 固定 Claim / Dispute / Trace 的实体与 ID，逐个提交并记录已执行内容；之后持久入上传队列（仅团队模式）、标记 applied、推进共享处理游标并回收 transcript。崩溃恢复识别落盘后尚未记录进度的精确目标；发现外部变更则放弃其余旧方案。已 applied 的 checkpoint 只补游标和回收，不再调用模型。

卸载会取消未 prepared 的模型调用，通常在十秒内到达安全点；若本地提交仍未收敛，保留租约直到提交结束。worker 由知识服务拥有，Formation、Inbox 和 Dream 注册各自处理器；禁用某一行仅移除对应处理器并保留任务。状态与 retry 不依赖 Formation 行。

Inbox 同步先逐条持久化，再 ACK 成功保存的前缀；ACK 只确认 receipt，done 才代表本地内化完成。单 worker 在模型前回收旧消费者的 processing 租约，每轮最多领取 1024 条。同类连续消息共用一次调用，Policy 撤回会先冲刷前批次并确定性废弃直接依赖。CAU 可编辑本地 active/stale 和自身 direct deprecated Claim，其他 holder 的冻结快照只读；输入没有 Memory、USER 或 transcript。

批次 `inbox/effects/<canonical-id>.yaml` 保存成员快照/hash、分析 Claim、固定目标/Trace/Dispute、已执行结果和状态，其他成员文件指向 canonical。恢复先整体校验成员及引用，补齐缺失 refs，再补本地效果；applied 后补 done。新批次开始前先恢复已 prepared 的前缀。这个 journal 是插件私有格式，协议实体仍与 Rust 相同。

上传在独立 `delivery.lock` 生命周期租约下单飞执行，HTTP 期间不持知识锁或 pending 锁。成功后用 id + revision 移除 Claim，避免删去并发新版本；每轮每 ID 只发送一次，新版本留待下一轮。Dispute 等待其待上传依赖，并在服务确认后记集合台账。确认与本地记账之间崩溃时，以相同实体 ID 重送。知识应用、会话创建、手动 Inbox 及每十分钟补传触发投递；失败保留队列。

投递前在短知识锁内确认存储已恢复，并核对所有待传 Claim 的当前精确版本。版本漂移或缺失时暂停该项；投递层不自动替换正文，尤其不能把单人期间的后续整合当作已有依赖。团队编辑正常入队或显式 `sync_review` 重绑后才能发布新版本。

## Dream 的结构化整理与恢复

`acn-dream` 激活、agent/created 及每四小时检查资格；上次成功满 24 小时、至少五条不同的自有 Claim 版本变化才自动排队。手动运行跳过两个门槛，仍须有自有非废弃 Claim。失败、停止和部分提交不更新成功冷却，未完成候选沿原任务恢复。单 worker 按 Finalize、Recap、Inbox、Memory review、Dream 的优先级处理，Dream 在 prepared 前让位，prepared 后完成当前组再响应停止或卸载。

队列领取、入队时抢占、跨进程监控和 Dream 阶段边界共用 runnableJob 条件：queued、未暂停、已注册处理器、nextRunAt 已到期。处理器禁用或退避中的高优先级任务仍持久保留，但不会导致 Dream 反复让位重领；重新启用或到期后才参与调度。

选择**插件自管结构化上下文**。完整 Claim 以 effective_updated_at、created_at 降序、ID 升序装入，保守字符预算 64000；超长单条跳过，余量不足时从较旧条目截断，报告保留覆盖数。候选登记后逐个 draft → 硬校验 → review → execute，不能遗漏候选结束；允许明确保留和零修改。复核输入带原文、草稿、验证哈希与当前候选反馈；全文引用覆盖 name / statement / scope / evidence_summary，包含否定、条件和备选行动。复核仍是模型自评，不能证明事实或信息等价。证据校准在 B 候选起草之前加入独立的受限文件查证，默认关闭；A/C 保持已有输入的清理与重组。

`dream/preservation.ts` 将完整原 evidence_summary 作为保守的不丢失单位，不做语言、关键词或模型抽取。草稿预检和最终提交都要求各 ID（包括废弃历史）逐字保留原摘要；C 另要求 coverage 指定的活跃去向完整承接每条输入摘要。复核入口同样检查原文承接，不能用完整的 before 引用加无关 after 引用骗过。新证据说明只能追加，旧判断可在正文按授权校准并在依据中明确区分新旧版本。同步重绑也检查当前 carrier 的原依据。DTO 与记录格式保持不变；旧未 prepared 草稿按新约束重起草，prepared 固定目标仍按原协议恢复。

已完成上下文达到半预算时，先归档完整历史，再用移植的 `dream_compaction.j2` 生成 checked/findings/uncertainties/next_steps 摘要；摘要限制 12000 字符。压缩失败保留已提交组，重试先恢复压缩，再继续候选。结构化调用没有宿主对话或自动工具探索；这是对源端自主工具循环的明确适配。

每组先写 `dream/<job>/executions/<validation-hash>.yaml` 和可读审计，之后在知识锁内重检当前版本，写 `dream_pending.yaml` 字符串指针，先写存续承接、再写废弃来源，同锁内持久入队整合依赖。完成组、Trace、applied、DreamState 后删除 pending。最终 checkpoint 位于 `runtime/supervisor/dream/<job>.yaml`，其成功状态才更新冷却。恢复同时发现指针与指针落盘前的 prepared 记录；所有知识入口及 worker 领取任务前先恢复本地 Dream，失败不消耗其他任务 attempt。

恢复接受精确 before 或精确 target，第三版本使本组剩余效果失效，已落盘目标和外部编辑保留；原因记入 `report.md` 与 `executions/*.md`。上传不阻塞本地恢复。整合弃用只在每个当前精确承接已获远端确认，或有显式后续整合链且最终承接已获确认时就绪；递归检查防环，清理保留传递依赖。承接普通修订使旧依赖继续阻塞，需 `sync_review` 重新核对完整来源、当前版本与信息去向后重绑；同步日志可恢复，但不修改 Claim。

## 受限证据校准

任务 payload 和 origin 冻结可信会话 cwd 的 canonical 工作区；模型不能指定新根。`EvidenceStore` 持久化候选 Claim revision、工作区、额度和真实读取回执。工具调用、模型步数和读取预算在执行前预占，回执在响应工具前同步落盘；completed 后不能再追加。证据锁只覆盖本地短 I/O，子会话和结构化模型均在领域数据锁外。

`dsh-adapter/dream-evidence.ts` 通过 agents.create 的 setup 在发布前清除继承能力、强制 native 模式、注册四个插件只读工具并安装单调 guard。完整系统段落不插值，关闭可选 context，并用同名空 scoped contribution 阻止 required context 在准入刷新时回流。知识目录和变化通知跳过这种查证会话；形成、Inbox 和 Dream 的普通会话触发也忽略子会话。子会话结束、取消和超时后必须 dispose 并排空循环，不能留下后台工具继续工作。

文件策略同时核对 lexical / canonical 根、逐层拒绝符号链接，打开时使用 no-follow/non-blocking，前后校验普通文件、inode、链接数、长度和修改时间。版本包含完整文件原始 SHA-256 和字节数，实际返回页保留完整行。glob/grep 有累计遍历和读取额度，只是定位结果；唯一独立证据是绑定明确 claim_ids 的 file_read。工具不暴露 shell、通用代码、网络、团队或私有 Memory 能力。

## 私有 Memory

`acn-memory` 独立发布 `acnMemory`、批量工具、`acn:memory`（order 720）及 review handler。`MemorySessions` 在主 agent 创建时预读双文件并合并保存到版本化 session state；同步提示词只访问缓存，恢复、压缩和 fork 使用原快照，clear 刷新。所有子代理均跳过快照和 review，最终工具 guard 拒绝其 Memory 调用。

`MemoryFileStore` 复用双文件锁和原子写。事务顺序为重读 → 纯操作/扫描/容量校验 → pending（before、after、result、identity）→ MEMORY → USER → receipt → 删除 pending。所有读取先恢复 pending，普通文件要求 UTF-8、单链接并 no-follow 打开。恢复只接受每个文件仍等于 before 或 after；第三版本使整批未完成部分跳过。完成回执优先于当前文件比较，避免回执已写但 pending 未删时误覆盖后来的用户编辑。该协议是独立目录内的插件事务，不是跨两个文件的 OS 原子替换。

review 自有私有窗口，不从可能被 Recap/Finalize 回收的 transcript 取数据。成功人工 turn 的计数、裁剪后的最近 N turn 与 outbox 同次原子写入；outbox 再写不可变 request、入队引用并删除确认。`memory_review` 按请求跨所有队列状态去重，崩溃后的重复派发不会重复复核。模型只获得自身请求和最新私有快照；输出经严格 schema 与纯操作校验后先写固定 checkpoint，再在双文件锁内进行原文哈希 CAS。若事务回执已存在，先按 identity 返回结果，再处理 CAS。prepared 恢复不再请求模型。

模型调用期间只持 worker 生命周期租约，不持 Memory、窗口、session 或队列数据锁。卸载取消未 prepared 调用，任务回到 queued；已 prepared 的本地应用收敛后再卸载。持久任务和无正文调用审计不保存 Memory / USER 内容，私有正文仅位于双文件、冻结 state、私有 request/checkpoint/receipt。普通宿主会话日志仍包含用户可见 Memory 工具调用及结果。

形成投影过滤 native Memory 调用及结果；`run_code` 外层代码和回显也被过滤，通过 `tool/ptc-dispatch*` 只保留实际公共子工具调用/正文及来源 ID。Inbox、Dream、Router 和 Upload 的领域输入保持原有公共 DTO。它们不会读取 Memory 文件；模型在普通回复中复述的文字没有语义级脱敏保证。

路径保护属于知识插件，使用可选 fs/workingDirectory 注入，因而不随 Memory 行禁用撤销。由于基线缺少读取前事件，已知文件工具在异步 pre-execute 中检查 canonical containment、普通文件链接数及递归搜索硬链接，再由单调最终 guard 校验本次授权、冻结参数和实时 cwd。ask 决策也先验证路径，审批后复查 cwd；外层策略短路无法绕过最终 guard。`fs/write-intent` / `fs/edit-intent` 额外保护 provider 写入意图。范围及非沙箱限制见使用说明。

计划、change_basis、SemanticReview 与 SelfReview 分别核对证据的存在、逐 Claim 归属、新 evidence_summary、原始置信度和实际原文引用。仅确认连续行号和页范围完全一致时去掉显示前缀；错误引用反馈聚合位置并限制源预览。Validation 哈希含版本回执。知识提交从受限清单重新装载证据、校验原始快照，在 prepared 与每个未完成组恢复时核对文件当前版本；不接受模型自造的回执。过期时保留已有精确目标、跳过剩余写入；I/O 故障阻止领取其他知识任务。已经完成的组不因材料后来变化被撤销。

## 只读迁移

`commands/import.ts` 在目标写入之前验证源路径、UTF-8、DTO、归属和私有安全/容量，再持知识锁逐文件发布。`writeTextAtomicIfAbsent` 复用原子写的临时文件与 fsync，以独占硬链接发布完整目标，已有路径不覆盖；源目录从不加锁或写入。Memory 沿知识锁到双文件锁的顺序，复用 `MemoryFileStore` 的 pending / receipt 恢复边界。导入没有独立后台任务或网络调用；进程中断后用户重试补齐缺失文件，不承诺整批原子可见。

草稿协议中，`operation.reason` 只作为无 changes、无独立 change_basis 的质量废弃简写，不是通用备注；所有其他依据使用 change_basis。JSON schema 字段说明与错误反馈给出具体操作 ID / 类别。整合时保留指向将废弃输入的既有来源，仅免除合回存续 ID 自身的自引用。
