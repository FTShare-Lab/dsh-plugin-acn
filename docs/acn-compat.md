# ACN 兼容边界

协议基准为 ACN `0.3.3`，参考提交 `c542b1931f72cb905b502bd0f5b3a6efd99affb6`。覆盖 47 份 Rust 导出 YAML、9 组 Claim revision 和 15 份适配模板快照。`pnpm test:compat` 把 TypeScript 写出的 YAML 交回 Rust 解码；`pnpm test:contract` 使用真实 Router / Maintainer。最终执行结果见[验收](acceptance.md)。

Router 的模型重排和 Maintainer 的自动模型仲裁由 ACN 服务提供，须在服务侧配置；插件负责查询、Dispute 上报、建议内化和上传。指定模型下的三成员真实联通、Dream 并发及服务故障结果见[模型团队闭环验收](validation/2026-10-23-model-team-loop.md)，不代表插件实现了服务端仲裁或验证过所有模型。

共享实体包括 Claim、Trace、Dispute、Policy、仲裁及 Inbox 消息，覆盖字段默认值、别名、null / 省略、RFC 3339 纳秒、UTF-8 revision 与来源 ID。UTC 规范年份限制在 0–9999，避免写出源实现无法读回的文件。

Router 返回候选与 Dispute，不访问私有 Memory；Maintainer 属性更新是建议，Inbox 内化后才改本地知识；receipt ACK 与本地 done 分开。整合先确认存续承接，再投递弃用版本；按实体 ID 和精确版本去重，保留并发新版本。

| 边界 | 插件适配 |
| --- | --- |
| 运行目录 | 独立 `<home>/agents/<agentId>/`，不与源进程共用 |
| 形成引用 | 完整已展示实体和本地 active/stale 授权；目录或裸 ID 不授权；伪造 used IDs 丢弃并告警 |
| 模型与锁 | DSH 模型路由；锁外分析，提交时重检完整快照 |
| Trace task | DSH 公开任务投影，最多 16000 个 Unicode 字符 |
| 单人 Dispute | 本地保存，始终无团队请求或上传队列 |
| auth 故障 | 保留 durable 上传项，等待恢复 |
| Dream | 自管结构化阶段与有界摘要；查证限 read / grep / glob / 只读 claim |
| 证据 | 默认关闭；带版本的实际文件读取才是独立证据；high 禁止事实纠正或提升 |
| Memory | 默认容量 1600 / 1000 字符、十个完成 turn 复核；插件工具批量 ops，源工具还有单动作入口 |
| Memory 分隔符 | 导入保留原始字节；后续工具规范写回为空行包围的 `§`，源端通常只有单换行 |

Dream、形成、Inbox effect、Memory review、会话状态和权限清单属于插件运行时格式。旧 Rust pending checkpoint / safety reviews 没有插件授权清单，不能直接接管；读回通过不表示日志可互换。

插件的 Dream 另有保守保留规则：原 evidence_summary 逐字留存，整合时进入指定存续摘要；新证据说明追加而不擦除旧依据。这是插件的行为约束，Claim / Trace DTO 和 revision 算法没有新增字段或改变。

`/acn-import` 只复制校验通过且归属当前 Agent 的 `claims/`、`traces/` 及 `memories/MEMORY.md` / `USER.md`，跳过已有目标。不导入锁、会话、任务、Dream 日志、上传队列或团队状态，也不自动上传。源目录应停止写入以获得稳定快照；规则、预览及恢复语义见[导入说明](command-reference.md#从已有-acn-目录导入)。

更详细的源用例与差异见[分阶段兼容记录](validation/acn-milestones.md)。结构、引用和模型自评不能证明事实正确或整合语义等价，见[已知限制](outstanding-issues.md)。
