# M5 Dream 的来源、适配与验证

参考 ACN `0.3.3` / `c542b19` 的 `src/agent/session_engine/dream*.rs`、`src/agent/consolidation_delivery.rs`、`maintainer_upload.rs` 及两个 Dream 模板。移植范围为质量清理、主题整合、逐组执行与依赖交付；独立证据读取和事实校准属于 M6。

## 主链路与所有权

`src/dream/service.ts` 负责自动资格、持久候选、阶段调用、暂停与压缩；`plan.ts` 展开操作并检查来源、置信度、coverage、改写和环；`review.ts` 检查逐 Claim 名称、信息去向与 before/after 全文引用。`checkpoint.ts` 在知识锁内提交，`sync.ts` 只重绑上传依赖，`audit.ts` 保存可读审计。插件仅适配宿主路由、事件和命令。

源端用工具在长会话中登记、读取、修复和逐组提交。插件使用 candidates / draft / review / sync_review 的结构化阶段，候选批次整体校验后固定登记，逐组保留原文、草稿、验证哈希和反馈。不能通过返回较小候选、换组 ID 或空 finish 静默遗漏工作。没有最少修改条数。未运行源端的工具授权循环，不把阶段适配宣称为工具 API 相同。

## 源用例对应

| 源端用例组 | 插件验证 |
| --- | --- |
| `dream_template_errors_are_isolated_from_foreground_sessions`、`dream_finish_reminder_survives_retry_and_allows_zero_changes`、`dream_finish_only_requires_review_and_accepts_legacy_empty_groups` | `tests/dream/integration.test.ts` 的模板故障、零变更/明确保留；`tests/compat/protocol.test.ts` 的旧空组/新增字段默认值 |
| `dream_finish_reminder_allows_quality_cleanup_without_file_evidence`、`dream_quality_shorthand_preserves_content_and_records_explicit_basis`、`dream_quality_shorthand_cannot_bypass_other_change_requirements` | 纯 A 废弃简写保留历史正文，自动生成 change_basis；拒绝改写历史、重复/遗漏依据、假证据与非法动作字段 |
| `dream_name_review_binds_final_name_and_legacy_execution_remains_replayable` | 最终名称及理由绑定、废弃历史名称、旧持久 ClaimReview 默认字段、验证哈希变化 |
| `dream_self_review_repairs_in_same_context_and_writes_auditable_results`、`dream_incremental_missing_review_keeps_other_committed_groups` | 同候选原文和反馈重拟草稿、双复核缺失拒绝、已完成组保留；逐组 YAML 与 Markdown 审计 |
| `dream_audit_failure_prevents_claim_commit`、`dream_incremental_rejects_stale_validation_and_failed_audit_before_write`、`dream_write_error_keeps_unknown_commit_until_durable_recovery` | 审计路径故障阻止 Claim / Trace；清除故障后恢复 prepared，模型不重放；旧哈希和并发版本变化拒绝/跳过 |
| `dream_group_execution_survives_restart_and_finishes_without_replaying`、`dream_incremental_execution_is_durable_before_finish_and_idempotent`、`dream_incremental_recovers_prepared_group_without_reexecuting_model` | 真实 SIGKILL、反复恢复、固定 Trace/版本/上传依赖、成功冷却只在最终 checkpoint 完成时推进 |
| `dream_candidates_block_finish_after_other_work_and_survive_recovery`、`dream_candidate_withdrawal_and_failed_review_cannot_silently_abandon_work`、`dream_candidate_refinement_cannot_drop_claims_or_reuse_partial_validation`、`dream_candidate_registration_is_atomic_and_preserves_ownership_and_high_gate`、`dream_rejected_execution_replay_and_recovery_keep_candidate_pending` | 完整登记批次校验、候选不重叠、已读/holder 门禁、草稿必须精确覆盖当前候选、失败仍 pending、停止/修复/恢复沿原候选；M5 禁止全部事实纠正而非只保护 high |
| `dream_compaction_runs_at_tool_boundary_and_resumes_after_provider_failure` | 插件自管阶段边界：完整历史先归档、有界预览、摘要大小限制；压缩失败后重试，已提交组不重新生成 |
| `dream_review_reports_exact_gaps_but_allows_sentence_separators`、`dream_review_rejects_omitted_alternative_even_with_valid_existing_quotes`、`dream_review_rejects_uncovered_new_output_and_wrong_claim_quotes`、`dream_review_rejects_stale_version_and_deprecated_destinations`、`dream_review_requires_name_coverage_on_both_sides` | `tests/dream/validation.test.ts`：原文逐字片段、双向四字段覆盖、缺口反馈、否定/数字/比较符号/备选行动、错侧/错 ID、废弃不能承接、旧验证哈希 |
| `dream_review_cannot_remove_factual_rules_without_new_evidence`、无直接证据或 high 事实纠正的保留路径 | 拒绝 corrected、factual_correction=true、新 evidence 回执、证据组和置信度提升；结构化错误反馈后允许明确保留 |
| `dream_stop_interrupts_initial_snapshot_lock_wait`、`dream_stop_interrupts_provider_and_resumes_staged_candidate`、`dream_stop_preserves_applied_group_and_resumes_below_automatic_threshold`、`dream_stop_before_prepared_rejects_write_without_losing_draft`、`dream_stop_during_prepared_waits_for_commit_then_preserves_receipt` | `tests/dream/concurrency.test.ts`、`integration.test.ts`：锁等待取消、模型取消、草稿和已完成组保留、prepared 前无效果、prepared 后提交收敛、手动继续原 job |
| `dream_recovery_failure_does_not_spend_session_job_attempts`、`dream_ipc_recovery_defers_remote_upload_without_losing_pending_claims` | worker 领取前恢复、失败不消耗其他 job attempt、不消费 Inbox；本地恢复不依赖团队服务、队列在网络故障后保持。插件没有源端 supervisor IPC，不测试不存在的 IPC 接口 |
| `dream_sync_review_is_version_bound_audited_and_never_modifies_claims`、`consolidation_delivery.rs` / `maintainer_upload.rs` 中依赖交付用例 | `tests/dream/delivery.test.ts`：精确当前确认、显式传递链、防环、清理保留传递依赖、普通修订阻塞、重新 active 取消旧依赖、同步名称/去向/来源/版本校验、只改队列 |

涉及版本化文件证据、行号定位、B 纠正成功及受限外部探索的用例留在 M6。源端对工具 `dream_register_candidate` 的动态扩组/撤回，以固定候选 + 当前完整 ID 集合校验替代；没有假装提供该工具。

## 崩溃、并发与真实服务

`tests/dream/crash.test.ts` 在独立进程实际 SIGKILL：逐组 prepared、pending 指针、承接正文、来源废弃、上传队列、组完成、Trace、applied、DreamState、pending 删除；最终 checkpoint 的 prepared、Trace、applied、DreamState、pending 删除；同步复核 prepared、队列重绑、applied。新实例反复恢复，使用固定目标与回执，模型不得再次调用。另在部分写入后引入第三版本，验证保留用户编辑、已生效目标与阻塞旧弃用。

并发测试使用真实文件锁覆盖重复提交去重、两个旧快照竞争、完整当前图的来源环复查、手动请求合并、锁等待取消、Inbox 抢占与恢复失败屏障。另起独立进程只写共享队列的暂停标记，验证持有者在模型等待时取消、prepared 后完成本组即停，不能依赖发送命令进程的内存取消控制器。共享 worker 的多进程单消费者/持有者强杀接管继续由 M3 的真实双进程测试覆盖；不以 Promise 并发冒充独立进程。

`tests/contract/team.test.ts` 新增真实 Router / Maintainer 契约：Dream 本地整理后，注入承接 503，确认来源弃用未发出；恢复代理后观察 Maintainer 成功收到承接再收到弃用，Router 仅保留完整存续知识。模型均为本地替身，团队后端为真实二进制。

宿主流程覆盖 `/dream`、`/dream stop`、禁用行撤销、全局最近路由、下一普通请求的变化提示、子会话拒绝与自动资格。实际 tarball 安装后由真实 runtime resolution 加载，运行 Finalize、Inbox、Dream 并检查逐组报告；10 个 Loader 场景覆盖七行组合。

## 兼容和质量边界

39 份跨语言夹具包括原有 32 份协议格式及 7 份 Dream 状态、检查点、旧字段、验证输入和 pending 路径。公开 DTO 的原有 JSON 字节和 9 份 Claim revision 不变；Dream 内嵌通用 JSON Value，比较对象语义与实际 Rust YAML 读回，另核对验证哈希。私有类型由导出器按当前字段镜像，未宣称可调用源端私有类型。10 份模板快照由真实参考模板引擎渲染插件适配后的模板，再与运行引擎逐字比较。

硬校验确认结构、引用文本覆盖、权限、版本、来源和恢复纪律。全文引用可以发现遗漏，不能证明两个片段语义等价；模型自复核可以错误分类情景材料。测试替身保证可重现的系统行为，真实知识质量评估留在 M8。
