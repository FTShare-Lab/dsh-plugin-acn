# M6 证据校准测试覆盖

日期：2026-10-22。参考 ACN 0.3.3 / `c542b19`；宿主 0.2.1-rc.2。范围是默认关闭的受限文件查证、独立证据、置信度和本地提交恢复；M7 Memory 与 M8 真实模型质量抽样尚未实施。

Node 22.23.3 与 24.22.0 各通过 520 项常规测试（39 文件）、5 项真实服务契约和 41 份 Rust YAML 读回。相对 M5 新增 89 项常规测试，其中 85 项覆盖本阶段证据领域和宿主流程，另外 4 项为两份协议 fixture、一份模板和一个 Loader 场景。详见本地验收记录；远端 CI 未运行。

| 参考行为 / 测试 | 插件验证 |
| --- | --- |
| `dream_b_requires_new_evidence_then_accepts_a_supported_scope_change` | evidence-validation / evidence-integration：真实 read 回执、逐 Claim basis、新 evidence_summary 与全文/证据复核后修改范围并提高置信度 |
| `dream_b_without_direct_evidence_can_finish_with_original_unchanged` | 无读取回执时明确 keep，原始 Claim 不变；搜索、旧 Claim/Trace、命令输出不能授权修改 |
| `dream_high_evidence_change_returns_feedback_and_can_finish_unchanged` | 默认关闭、原始 high 候选被拒；降低 high 后再纠正也被拒，high 的纯 A 清理仍允许 |
| `dream_validation_does_not_accept_a_file_changed_after_exploration` | 查证后材料变化在后续阶段跳过，复核期间变化在提交重检中跳过；不应用旧授权 |
| `dream_review_cannot_remove_factual_rules_without_new_evidence` | corrected 必须引用真实新证据、更新摘要；无证据、伪造 ID/引文、无版本回执、旧哈希均失败 |
| `dream_review_correction_checks_claim_specific_receipt_and_original_high` | 每条 Claim 的依据和复核引用均限定其自己的 read 授权；拒绝借用其他候选和 A/C high 纠正 |
| `dream_review_accepts_body_quotes_without_display_line_numbers` / `does_not_strip_unconfirmed_line_prefixes` | 严格确认连续行号及完整页范围；不剥离物理正文中的数字前缀，保留正文缩进 |
| `dream_review_reports_all_bad_evidence_locations_and_bounded_source_previews` | 收集 preservation/support 的全部错误位置，最多展示 8 处，每处源预览不超过 240 字符 |
| 文件查证 / 沙箱边界 | evidence-permissions：工作区外、遍历、Memory/USER、环境/凭据/隐藏路径、私有数据根、符号/硬链接、目录、二进制/无效 UTF-8 均拒绝 |
| 宿主工具权限 | flow/dream-evidence：真实 AgentLoop 中发布前安装限制；native/PTC 主环境均拒绝全局/新增 scoped/保留传输/写入工具；策略 allow 不覆盖最终 guard |
| 上下文和生命周期 | 完整系统段、required context 遮蔽、无 Claim 目录/变化提示回流、候选外只读访问拒绝；无形成/Inbox/Dream 子触发；超时、停止、步数上限均排空子循环 |
| 并发 / 额度 | 并发真实读取回执无丢失，四工具严格 schema；两个并发子会话各自冻结工作区。失败、重启不返还调用/步数/字节/目录项预算，completed 清单不可追加 |
| prepared / partial recovery | evidence-crash：真实 SIGKILL 验证权限、预占预算、回执、查证完成、prepared、pending、首个 Claim、组完成、Trace、applied、DreamState；部分写入后证据过期保留已生效目标并跳过剩余 |
| 故障与协议 | 恢复 I/O 故障阻止其他任务领取且 attempt 为零；真实证据清单与 Validation 哈希重新核对，模型自造回执不获授权；新增 Rust checkpoint/validation 镜像往返 |
| 真实团队与安装 | 新增 Maintainer 上传 → Router 检索校准后正文与置信度；默认和启用校准两条真实 tarball 安装流程，校准通过实际受限子会话读取 |

## 明确的实现适配

主 Dream 仍使用 M5 的有界结构化阶段，B 在草稿前增加受限子会话。工具是规划白名单子集：read/grep/glob/只读 claim。没有暴露 Web、命令、通用代码、编辑、上传或子委托；不把源端 shell 沙箱测试算作已移植。文件工具是插件自建的有界能力，不继承宿主同名工具。grep/glob 是字面搜索，不支持 shell、任意正则或网络扩展。

权限清单、原始 cwd、Claim 版本及预算属于插件私有状态。独立证据仍使用源端 file_read / file_version 的 JSON 形状，增加 claim_ids 绑定。空 receipts 的 M5 checkpoint 继续恢复；来自其他运行时且无本插件授权清单的旧 safety_reviews 会明确拒绝。格式读回不能替代运行时权限授权。

置信度没有自动打分或“读取即升级”规则。硬校验要求新版本直接证据、逐 Claim 引用、新摘要和原始 medium/low；模型仍须判断相关性与支持力度，可保留原值或整组保持原样。测试和同模型复核不证明材料真实、结论正确或信息语义等价。
