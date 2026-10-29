# ACN 兼容边界

协议基准为 ACN `0.3.3`，参考提交 `c542b1931f72cb905b502bd0f5b3a6efd99affb6`。兼容测试覆盖 Rust 导出的 YAML、Claim revision 和适配模板快照。`pnpm test:compat` 把 TypeScript 写出的 YAML 交回 Rust 解码；`pnpm test:contract` 使用真实 Router / Maintainer。运行方法见[开发指南](development.md)。

Router 的模型重排和 Maintainer 的自动模型仲裁由 ACN 服务提供，须在服务侧配置；插件负责查询、Dispute 上报、建议内化和上传。当前建议关闭 Router 的模型重排，原因见[团队仲裁与信息边界](outstanding-issues.md#团队仲裁与信息边界)。

共享实体包括 Claim、Trace、Dispute、Policy、仲裁及 Inbox 消息，覆盖字段默认值、别名、null / 省略、RFC 3339 纳秒、UTF-8 revision 与来源 ID。UTC 规范年份限制在 0–9999，避免写出源实现无法读回的文件。

Router 返回候选与 Dispute，不访问私有 Memory；Maintainer 属性更新是建议，Inbox 内化后才改本地知识；receipt ACK 与本地 done 分开。整合先确认存续承接，再投递弃用版本；按实体 ID 和精确版本去重，保留并发新版本。

| 边界 | 插件适配 |
| --- | --- |
| 运行目录 | 独立 `<home>/agents/<agentId>/`，不与源进程共用 |
| 形成引用 | 沿用原版扁平可见规则：本地 active/stale 与当前已过滤 transcript 中完整合法的 Claim ID；非法 used IDs 拒绝整批并重试。可引用不代表确实采用，模型仍须按完整正文和任务证据判断 |
| 模型与锁 | DSH 模型路由；锁外分析，提交时重检完整快照 |
| Trace task | 当前区间的公开用户任务正文完整保留；读取工具继续分页 |
| 单人 Dispute | 本地保存，始终无团队请求或上传队列；团队模式重新提出冲突时，仅按待投递及成功上报台账去重 |
| auth 故障 | 保留 durable 上传项，等待恢复 |
| Dream | 宿主自主工具循环与逐 Claim 语义复核；默认 24 次探索加 3 次收尾；支持按 Claim 查找和读取自身 Trace |
| 证据 | 默认关闭；带版本的实际文件读取才是独立证据；high 禁止事实纠正或提升 |
| Memory | 默认容量 1600 / 1000 字符、十个完成 turn 复核；有界窗口优先保留对话；插件工具批量 ops，源工具还有单动作入口 |
| Memory 分隔符 | 与原版一致，规范写回为 `\n§\n`，容量包含分隔符；导入保留原始字节 |

Dream、形成、Inbox effect、Memory review、会话状态和权限清单属于插件运行时格式。旧 Rust pending checkpoint / safety reviews 没有插件授权清单，不能直接接管；读回通过不表示日志可互换。插件事务保存创建时的团队共享授权；缺少该字段的旧 prepared 日志仅恢复本地效果并告警，不推定允许上传。

当前 Dream 沿用原版逐 Claim 语义复核，要求保留有效条件、版本与证据限制，不强制逐字复制旧 evidence_summary。探索和收尾额度耗尽后结束本次，下次从当前 Claim 开始；文件查证默认关闭，启用后只提供受限 read / grep / glob。Trace 是来源线索，不授予独立事实证据资格。旧固定阶段适配器及已经 prepared 的提交仍按各自兼容规则恢复；Claim / Trace DTO 与 revision 算法不变。

候选按整批校验后受理，当前组可以保留原目标并继续扩展或调整类型；旧草稿可供参考，但变更后的组必须重新校验复核。尚有额度时，普通文本收尾最多获得两次同上下文修复机会；没有探索或提案就结束时会先提醒一次，仍允许确认零修改。新增请求均计入现有额度，不因修复或提醒增加额度。

公开工具结果不再按前缀裁剪。系统、私有工具与程序封装过滤仍保留；旧记录已经丢失的片段无法凭升级补回，须依据原截断标记判断完整性。团队 Dispute 在 Claim 投递后独立尝试，Claim 更新失败不会自动阻止争议；Policy 撤回会补传全部直接依赖的废弃版本，已废弃条目不额外推进时间或伪造新 Trace。

`/acn-import` 只复制校验通过且归属当前 Agent 的 `claims/`、`traces/` 及 `memories/MEMORY.md` / `USER.md`，跳过已有目标。不导入锁、会话、任务、Dream 日志、上传队列或团队状态，也不自动上传。源目录应停止写入以获得稳定快照；规则、预览及恢复语义见[导入说明](command-reference.md#从已有-acn-目录导入)。

结构、引用和模型自评不能证明事实正确或整合语义等价，见[已知限制](outstanding-issues.md)。
