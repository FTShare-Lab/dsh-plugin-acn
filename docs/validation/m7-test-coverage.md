# M7 测试移植与边界

参考版本 ACN 0.3.3 / `c542b19`，宿主 0.2.1-rc.2 / `687f282e`。以下是当前源码用例与插件测试的对应，不将历史清单视为实现证据。

## 源用例对应

| 源测试 | 插件验证 |
| --- | --- |
| `memory.rs::add_appends_delimited_entry` | operations：trim、追加、Unicode 字符与方案分隔符计数 |
| `snapshot_dedupes_entries_without_requiring_writeback` | operations：读取去重不改变原始文本 |
| `add_duplicate_is_success_noop`、`duplicate_add_in_batch_does_not_hide_later_change` | operations：重复 add 与后续有效修改分别判定，按整批最终结果 no_op |
| `replace_to_existing_entry_dedupes_result` | operations：替换到已有条目后去重 |
| `replace_requires_unique_substring`、`remove_requires_existing_substring` | operations + storage + flow：0 / 多条拒绝，唯一整条替换/删除，同条多次出现仍允许 |
| `capacity_error_returns_current_entries` | operations + flow：用量/超量/候选条目，双文件整批不写 |
| `add_rejects_reserved_delimiter_inside_entry`、`replace_rejects_reserved_delimiter_inside_new_text` | operations：保留 §、空白新条目拒绝 |
| `prompt_block_renders_capacity_and_entries` | operations：标题、百分比、容量、分隔符、空段落 |
| `memory_safety.rs::rejects_invisible_unicode`、`rejects_bidi_and_format_controls` | operations：22 个控制/格式字符及范围代表值 |
| `rejects_prompt_injection`、`rejects_prompt_injection_with_newline_spacing`、`rejects_system_prompt_override_variant` | operations：大小写、换行、空白与指令覆盖变体 |
| `rejects_secret_exfiltration`、`rejects_secret_exfiltration_without_shell_dollar`、`rejects_secret_file_reads`、`rejects_secret_file_upload`、`rejects_ssh_backdoor` | operations：18 个危险字符串；示例使用保留域名和环境变量名 |
| `allows_normal_acn_memory_text`、`scans_add_and_replace_but_not_remove` | operations + storage：普通多语言文本通过；新值扫描，删除危险旧文允许 |
| `agent/fs.rs::local_fs_memory_store_missing_files_read_empty`、`apply_ops_writes_both_files`、`concurrent_instances_preserve_all_adds` | storage：真实临时磁盘、缺省空文件、双文件写入、20 次并发跨实例写入 |
| `local_fs_memory_store_capacity_error_does_not_write`、`safety_scan_rejects_add_without_write`、`safety_scan_rejects_batch_without_partial_write`、`safety_scan_rejects_replace_without_write`、`safety_scan_allows_remove`、`safety_scan_can_be_disabled` | storage + operations：整批失败保持原始字节、安全扫描与关闭、旧危险内容清理 |
| `tool/memory.rs::memory_tool_applies_actions_to_store`、`memory_tool_requires_action_specific_fields`、`memory_tool_capacity_error_includes_current_entries`、`memory_tool_substring_error_hides_needle` | flow/memory：实际工具 add/replace/remove，严格字段、容量反馈、不回显定位文本 |
| `memory_tool_requires_store` | 未配置 Loader 场景无 Memory 工具/段落；关闭配置及卸载单独验证 |
| `memory_action_add_rejects_dangerous_content_without_write`、`memory_action_add_rejects_invisible_unicode_without_write`、`memory_action_replace_rejects_dangerous_content_without_write`、`memory_action_remove_allows_dangerous_existing_content` | 同一领域扫描入口的 operations/storage 测试 + 实际工具安全错误反馈，基础设施错误另返回 isError |

## 插件新增验证

- 冻结：新会话/clear、resume/compact/fork、同时恢复合并其他 state 字段、模板式数据不插值、真实持久会话、冻结 state 发布后的 SIGKILL。
- 权限：native 子会话和 delegationDepth、外层 allow、禁用 Claim tools 行仍拒绝 Memory 越权、关闭 Memory 保留文件；实际 read/write/edit/grep/glob、写意图事件、canonical 别名、硬链接、其他 Agent、快照、回执和搜索祖先。正常审批可执行公共路径，审批期间 cwd 改变仍拒绝。
- review：N 次完成的人工 turn、失败/内部 turn 不计数、独立最近窗口、Unicode 总容量及遗漏标记、Memory call/result 过滤、自身路由、schema/安全修复、固定 warning、任务/审计无正文、并发工具编辑 CAS 跳过、空 ops、卸载取消与重新处理。
- 私有投影：真实 native 工具 → Finalize/Trace；真实程序桥 + 测试执行后端 → Memory 私有子调用过滤、公共 Claim 正文/来源保留。普通助手主动复述没有语义级脱敏保证。
- SIGKILL：snapshot、pending、MEMORY、USER、receipt、pending 删除、review prepared、review applied、outbox、enqueued 共 10 个不同边界，16 个强杀场景；包含第三版本、完成回执后外部修改、review 无模型恢复和 outbox 幂等。
- 双文件文件类型：符号/硬链接、目录、无效 UTF-8 均拒绝；取消不准备事务，重复调用 ID 重放及不同请求复用 ID 冲突。
- 兼容与安装：新增 6 组真实 Rust Memory DTO、4 份适配模板快照、3 个 Loader 场景、1 项真实团队服务契约；三个实际安装 profile 验证默认、证据校准和 Memory。

## 适配范围

插件按方案采用 bulk ops 与较宽分隔符；参考工具当前为单 action。匹配语义与扫描移植自源实现，字符容量按方案分隔符计算。持久双文件事务、会话 state、review 窗口/outbox/checkpoint 为插件实现，不跨运行时接管。

当前路径保护使用宿主工具最终门禁和已有写意图事件，保护整个私有 Agent 根；基线没有读取前 hook。它不是 OS 沙箱，也不保护任意 shell / Node I/O / 自定义工具或对抗性外部路径竞争。真实模型语义质量留在 M8；独立 CLI review 的模型登录限制另记于验收记录。
