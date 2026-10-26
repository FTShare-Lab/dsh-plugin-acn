# M4 团队模式测试与来源映射

基线：ACN `0.3.3` / `c542b19`，DSH `0.2.1-rc.2` / `687f282e`，日期 2026-10-22。Node 22/24 各通过 326 项常规测试（28 个文件）和 3 项真实服务契约测试；M4 新增 82 项常规测试。契约套件单独运行真实服务，常规套件使用临时磁盘、脚本模型及回环 HTTP；不访问外部 LLM。

## 客户端与真实契约

| 参考模块 | 实现和验证 |
| --- | --- |
| `router/http_client.rs`、`maintainer/http_client.rs` | `team/http.test.ts`：精确信封、路径前缀、环境凭据轮换、401/403 分类、ACK 404/405、408/429/5xx 重试、JSON/shape 失败、响应正文超时、取消与关闭、实际环境代理及回环绕过 |
| `router/overview.rs`、工具 registry/session | `flow/team.test.ts`：团队工具、概览/查询参数、候选正文及关联争议、隐藏 retrieval_debug、只记录实际候选来源、目录冻结与字符预算、失败规范值与本地会话继续 |
| Maintainer HTTP handlers 与团队鉴权 | `contract/team.test.ts`：真实 upload → query → overview → PolicyUpdate → pull → receipt ACK → 内化 → 再上传；普通 CAU 建议内化、Dispute 上报、Policy 撤回；跨 holder upload/ACK 拒绝、无效 key 与身份不匹配 |

`scripts/contract-up.sh` 检查版本并构建两个真实 binary，运行器在临时目录创建共享团队数据根、哈希 key 台账和 admin 配置，所有监听限于回环。原始测试 key 仅在内存与子进程环境中生成，结束时检查服务日志没有泄露。CI 使用参考仓库变量及固定提交，缺少参考仓库变量时 job 明确失败，不静默跳过。契约还验证真实 Dispute 相同 ID / 相同正文重送幂等、相同 ID / 不同正文返回 409，并通过本地代理注入 500、断开监听再恢复转发，最终从真实 Router 查到自动补传的 Claim。

## Inbox 源测试对应关系

当前参考 `agent/inbox.rs` 已超过历史方案所记的 3000 行。按行为迁移以下源用例；不是声称逐字复制全部 Rust 测试。

| 源用例组 | 插件测试 |
| --- | --- |
| 等待知识锁、PolicyUpdate / deprecation 锁内 stage | `inbox/service.test.ts` 模型期间知识锁可用；`inbox/recovery.test.ts` active/deprecated 在锁内入队 |
| Policy 撤回无需旧 consolidation carrier | `inbox/prepare.test.ts` 直接依赖与单调时间；`team/upload.test.ts` 撤掉旧 carrier 依赖、保留独立 durable 编辑并投递 retirement |
| 结构化业务重试预算、相同 request、输出失败无副作用 | `inbox/service.test.ts` 两次无效输出、输入稳定、任务失败与租约释放；共享 `llm/structured.ts` 传输和结构预算还由 M3 套件验证 |
| 自身 direct deprecated 恢复、其他 holder 只读、非 direct active/stale 可编辑、非 direct deprecated 不可见 | `inbox/prepare.test.ts` 持有权与编辑集合 |
| 历史来源可引用、history-only 不能参与 Dispute、不得从 Memory 推导权限、不得虚构 Claim/Policy/update ID | `inbox/prepare.test.ts` 来源白名单及最终状态；`inbox/service.test.ts` 私有文件实际存在但不读入输入、业务校验失败不写 journal/Claim |
| 人工仲裁允许省略 type；unresolved/insufficient_evidence 拒绝；完整 direct / assessment 覆盖 | `inbox/prepare.test.ts` 仲裁上下文与集合唯一性 |
| 重复 resolved 输入抑制、语义变化可报告、单 Policy 兼容归因、多 CAU 特定 Policy 归因 | `inbox/prepare.test.ts` 忽略纯时间变化、保留新语义、仅保存模型归因 Policy |
| 大批连续 CAU 一次调用、batch refs 重放、prepared 前缀先于后来 CAU、effect 不重复调用模型 | `inbox/service.test.ts` 70 条批次；`inbox/recovery.test.ts` canonical/ref、旧前缀、9 个真实中断点 |
| 内化后上传鉴权失败仅重试投递、不重放 effect | `inbox/service.test.ts` 一次模型调用、已 done 消息重拉、修复鉴权后补传 |
| 持久化失败仍 ACK 成功前缀、ACK 失败不阻断内化、服务错误独立 | `inbox/service.test.ts` 文件 rename 失败、ACK 503/404、pull 失败仍处理本地、连接状态独立 |
| 同批废弃不能进入 Dispute、来源完整替换、单人不记录为已上报 | `inbox/prepare.test.ts` 和 `inbox/service.test.ts`；实体去重由 `team/upload.test.ts` 的已上报 Claim 集合覆盖 |
| stale remainder 丢弃、Dream pending 延后、旧 processing 接管 | `inbox/recovery.test.ts` 部分写入及外部编辑；`inbox/service.test.ts` 延后和无新 session 的激活接管；M1 保留租约过期/损坏/重复快照测试 |

与 provider transport 选择、buffered fallback、Supervisor IPC、TUI 有关的源测试不适用于插件：后台调用通过宿主 prepareCall 与统一流组装器完成；M3 已覆盖宿主 HTTP adapter、传输失败、token 上限、取消和持久任务重试。Memory Review / Dream 的生产实现仍在后续阶段。

## 上传、崩溃与宿主

`team/upload.test.ts` 覆盖 401/403/503 与真实连接拒绝、非空队列自动恢复、两次投递单飞、HTTP 期间可取得知识锁和修改 pending、新修订保留、依赖 Claim 先投递、集合去重、台账/队列写失败恢复，以及 M5 未实现依赖数据保留。

`inbox/recovery.test.ts` 在真正的子进程上 SIGKILL，9 点分别为：canonical prepared、ref、首个 Claim、首个进度、Trace、上传队列、applied、done 前、done 后。恢复两次保留固定 ID、3 Claim / 1 Trace / 1 Dispute 和对应上传项，修复 refs 并完成所有成员，不调用模型。另测 dangling/conflicting refs、被改写的成员、当前消息快照冲突、外部编辑后的陈旧剩余方案。

`team/delivery-crash.test.ts` 的 3 个真实中断点覆盖 HTTP 确认后、台账提交前/后，以及 Claim 队列清理前：用同一实体 ID 重送，或利用已持久台账跳过重复上报。确认旧进程已经退出后，测试推进孤儿锁 mtime，避免每例等待真实 30 秒。

`flow/team.test.ts` 使用真实 AgentLoop 验证路由、工具、规范失败值、形成禁用时 Inbox 独立运行、变化消息和卸载撤销。九个独立 Loader 场景验证六行组合与隔离；实际安装 tarball 后执行普通请求、Finalize 与本地 Inbox，得到 2 Claim / 2 Trace / done。八组模板快照由真实 Rust PromptRegistry 渲染并逐字比较。

当前不对真实 LLM 的知识质量或外部网络部署作验证结论。M5 consolidation carrier/retirement 顺序尚未实现，其数据和依赖明确保留；可用团队链路与兼容差异见 `acn-compat.md`。
