# M3 测试覆盖与来源映射

基线：ACN `0.3.3` / `c542b19`，DSH `0.2.1-rc.2` / `687f282e`。截至 2026-10-22，全量 244 项测试、21 个文件；M3 新增 60 项。全部使用本地临时磁盘、脚本模型或回环 HTTP，不访问外部模型或团队服务。

## 源端移植范围

| 参考模块 / 用例 | 插件实现与验证 |
| --- | --- |
| claim_alignment.rs：ordinary_read_detects_pending_and_a_commit_completed_during_read | alignment.test.ts 同名测试，覆盖 pending、提交跨越读取、提交后稳定读取 |
| claim_alignment.rs：alignment_compares_content_and_recognizes_partial_writes_without_hiding_external_edits | alignment.test.ts 同名测试，完整内容相等、精确部分写入、外部 scope 修改、目标已退出方案及无 analysis |
| prepare.rs / runner_finalize.rs：占位符、来源、更新、Dispute | prepare.test.ts：十二项 Claim 链、多位下标、全文自然语言替换、未声明 / 错序 / 真实新 ID、自引用、重复更新、holder、完整来源替换、Policy 与历史 provenance、时间递增、伪造 used 丢弃告警、不同 Dispute 引用、严格 schema |
| session_engine/finalize.rs：prepared 抢占边界 | service.test.ts 与 recovery.test.ts：运行中未 prepared Recap 被 Finalize 中止；已经 prepared 的 Recap 完成本地提交，Finalize 只处理后续区间 |
| session_engine/finalize.rs：PendingFinalizeLocalApply 与 stale checkpoint | recovery.test.ts / crash.test.ts：保存分析与已应用快照、识别写盘后未记进度、缺少 analysis、外部修改、固定 Trace ID、单人本地 Dispute / 团队持久入队 |
| structured_json.rs：结构化重试与失败 | service.test.ts：两次无效后第三次成功、五次无效变 failed、按原 job ID retry；transport.test.ts：三次传输上限、五次持久退避、不可重试凭据错误、timeout 与卸载取消 |
| session_recap.j2 / what_is_*.j2 | unit/prompt.test.ts 与 Rust PromptRegistry 六组逐字快照；保持质量、隐私和引用要求，仅适配输出为直接 JSON |

claim_alignment.rs 的全部两项源测试均已移植，没有延期。其他源模块按本里程碑涉及的行为移植，并未宣称移植其所有测试：源端 TUI、Supervisor 进程通信、Memory Review、后台进程 watcher、团队 HTTP、Dream 与 provider replay 不属于 M3 插件实现。具体兼容差异见 acn-compat.md。

## 持久化与真实崩溃

crash.test.ts 在真实子进程、真实 fsync / rename 上设暂停点，父进程 SIGKILL：

1. prepared checkpoint 已持久化；
2. 首个 Claim 正文落盘，进度尚未记录；
3. 首个 Claim 的进度已记录；
4. Trace 已落盘；
5. 上传队列已持久化；
6. checkpoint 已标 applied；
7. transcript 已回收、session state rename 尚未提交。

每种情况恢复两次，再让新 worker 恢复 running 任务；固定实体 ID、三个 Claim、一个 Trace、一个 Dispute 和上传条目数量均保持一致，游标推进后投影为空。另有两个真实进程的单 worker 消费与 SIGKILL 后存活进程接管。测试在确认持有者退出后推进孤儿锁 mtime 到过期窗口，不需要耗时等待真实 30 秒。

transcript.test.ts 覆盖先 append 后 state 的尾部恢复、未完成尾行截除、状态未知字段合并、主文件容量与未处理分片、分片和主文件重复行核对、冲突 seq 拒绝、工具截断、目录 ID 不授权与私有记忆工具脱敏。job / checkpoint 的 ID 与文件位置必须一致。

## 生产宿主集成

flow/formation.test.ts 通过生产 AgentLoop 验证：mock compaction 形成符合协议的 Claim / Trace 并丢弃伪造 used ID；Recap / idle / dispose 共享游标；空闲到期与运行取消计时；下一次请求看到新 Claim 变化而冻结目录不变；真实命令 Finalize、status 和 retry；子代理门禁与 formation 卸载。

真实 Messages adapter 连接回环 mock server，覆盖成功、HTTP 500、HTTP 503 后恢复；后台请求包含 schema，无可执行工具声明，无普通对话 purpose 冒用。

plugin/bundle.test.ts 的八个独立 Loader 场景和 smoke:install 覆盖新增行、服务隔离、启停、公开入口、模板和声明。安装包在真实 profile 内加载后执行普通会话及 /acn-finalize，实际得到一个 Claim 和一个 Trace。

## 尚未在本阶段验证

- 外部真实模型的知识质量抽样属于 M8；本阶段不把 schema 正确等同于知识质量已验证。
- 团队网络投递、真实 Router / Maintainer 契约属于 M4；M3 仅验证可靠持久入队和单人零团队网络 / 零上传队列。
- 新后台任务不回补插件激活前未投影的历史日志，不使用已弃用的同步历史接口。
