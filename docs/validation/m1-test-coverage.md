# M1 测试覆盖与移植范围

所有文件存储测试都使用真实临时目录。并发与崩溃用例通过独立 Node 子进程消费构建后的 `store` 入口。下列来源路径相对于 ACN `0.3.3`。

| 来源 | 已覆盖的语义 | 本仓库测试 |
| --- | --- | --- |
| `src/claim/id.rs` | ID 格式、错误前缀和后缀、AgentId、Claim/Policy SourceId、语义与纳秒变化、Trace 输入/输出边界、显式盐的确定性 | `tests/unit/protocol.test.ts` |
| `src/claim/{claim,trace,dispute,policy,inbox,arbitration}.rs` | YAML 往返、枚举大小写、默认数组、可选字段、旧 Policy/Dispute、Policy 来源、两类 Inbox、仲裁旧字段、上报生命周期 | `tests/compat/protocol.test.ts`、`tests/unit/protocol.test.ts` |
| `src/time.rs` | UTC offset、亚秒精度、整秒无小数、可选时间、闰秒、超九位小数；拒绝不可回读的超界年份 | 同上 |
| `src/storage/yaml.rs` | 往返、覆盖、缺失文件 I/O 错误、独占临时文件与符号链接保护 | `tests/store/storage.test.ts` |
| `src/storage/paths.rs` | Agent 目录、实体和锁路径、私有双文件、标识符路径穿越拒绝 | 同上 |
| `src/agent/fs.rs` Claim/Trace | 缺失目录为空、正文读写、损坏 YAML 跳过并警告 | 同上 |
| `src/agent/fs.rs` 去重台账 | 排序去重键、保留首条 Dispute、多实例更新不丢记录 | 同上 |
| `src/agent/fs.rs` Inbox | 领取/释放/完成、过期恢复、active/done 碰撞、重复快照校验、损坏及冲突拒绝、时间相同时按写入顺序排序 | `tests/store/inbox.test.ts` |
| `src/agent/claims.rs` pending edit | 未落盘丢弃、已落盘补传、被更新版本取代、同秒正文变化、单人模式保留记录 | `tests/store/storage.test.ts` |
| `src/agent/maintainer_upload.rs` | 读取/合并、旧版本不覆盖新版本、按 id+revision 清理、durable 标识、Dispute 去重及整合依赖保留 | 同上 |

新增的系统级回归在 `tests/store/concurrency.test.ts`：

- 10 个进程同时写一个 Claim，读取始终完整，最终为其中一个完整版本。
- 10 个进程合并不同 Claim 到同一队列，最终不丢条目。
- 10 个进程领取一条 Inbox，仅一个进程获得租约。
- 在 fsync 后、rename 前 SIGKILL，旧正文保留；新临时文件先保留，过期后可清理。
- SIGKILL 留下 processing 租约或锁目录，修改 mtime 模拟到期后恢复或接管。
- 分别在编辑 journal、本地 Claim、持久队列完成后 SIGKILL，恢复不重放未成功修订、不重复入队。
- 文件锁超时、异常释放和反向获取拒绝。

未移植部分及原因：

| 来源 | 留待阶段 |
| --- | --- |
| Rust DefaultHasher/SipHash 的具体后缀数值断言 | TS 按方案使用 SHA-256；测试格式、字段边界和确定性，不要求两种算法生成同一 ID |
| `src/storage/yaml.rs::write_text_atomic_if_unchanged` 的 stale guard、权限变化检测等用例 | 当前没有该 API 的调用方；Memory/文件安全相关能力在 M7 按实际需要接入 |
| `src/storage/paths.rs` 的 Router/Maintainer/team store/supervisor 路径 | 不属于插件；插件 jobs/session 路径按独立格式测试 |
| `src/agent/fs.rs` Memory 操作、容量、安全扫描和并发 add 保留 | M7；M1 只覆盖基础双文件 I/O 和锁 |
| `src/agent/claims.rs` 工具分页、完整 update 事务、Dream 阻塞/整合交付门禁 | M2 / M5；M1 覆盖存储、日志格式和编辑恢复 |
| 上传网络投递、鉴权降级、整合送达顺序 | M4 / M5；M1 不发起网络请求 |
| Inbox LLM 内化、effect prepared/applied 和仲裁业务应用 | M4；M1 负责消息文件和租约 |

`tests/fixtures/protocol/manifest.json` 区分公开类型的基准与复刻的私有格式。JSON 字节和 revision 比较通过后，`pnpm test:compat` 还会让 Rust 读回 TypeScript YAML。
