# M2 测试覆盖与移植范围

基线仍为 ACN `0.3.3` / `c542b19` 和 DSH `0.2.1-rc.2`。测试使用真实临时文件，Agent 流程使用生产 AgentLoop 与注册表；HTTP 模型测试只连接本机 mock server。

| 参考语义 | 已覆盖用例 |
| --- | --- |
| `src/agent/claims.rs` | 同 revision 并发只有一个写入者、只读不等待知识锁、未来与同秒时间戳严格推进、可编辑字段/不可变字段、空修订与文本安全、Trace Unicode 分页及输入/输出过滤 |
| `src/tool/claim.rs` | 模型 list/read/update 全链路、过期 revision 的规范 conflict、外部 holder 拒绝、动作专属字段、可选 null、Trace 工具回查、领域失败和基础设施异常区分 |
| Claim 目录与 `claim_context.rs` | 有界摘要、冻结与 resume/compact/fork、clear 重建基线、fork 独立通知游标、完整基线包含目录外实体、累计 created/updated/deprecated/removed 身份变化、按知识版本去重 |
| 单人边界 | fetch 为零、无上传目录/编辑补传、未配置身份无知识磁盘、私有双文件不进入 Claim prompt |
| 宿主集成 | pre-step 生效时机、当前请求消息准入、拒绝与取消后重试、真实 JSONL resume、子代理 origin/depth 门禁、命令不调用模型、卸载撤销贡献 |
| 发布组合 | Loader 激活和 realm 隔离、分别禁用 tools/prompt/commands、schema JSON 投影、模板与声明打包、已安装公开入口导入 |

`tests/unit/knowledge.test.ts` 覆盖领域服务、目录和会话文件；`tests/flow/claim.test.ts` 验证真实工具和生命周期；`tests/flow/http-model.test.ts` 用真实 HTTP 适配器完成 list/read/update 工具结果回传。跨进程修改通过独立 Node 进程消费发布的存储入口执行。

`tests/unit/prompt.test.ts` 对四个适配模板的五组输入逐字比较参考引擎结果，包括 solo/team 主模板。主模板只提取知识语义，省去原 Agent 的通用工具、TUI 和 Memory 指引；Claim 定义中的一处“临时待办”措辞做了等义替换。基准由参考仓库的公开 `PromptRegistry` 使用本插件模板渲染，验证的是适配模板在 MiniJinja 与 Nunjucks 的一致性，不宣称完整原始 system prompt 不变。

未移植部分：

- Dream 未完成提交的读写门禁、front edit 与整合 carrier 的联动：M5；M1 队列依赖规则仍保留原测试。
- 团队网络投递与远端错误降级：M4；当前只验证本地编辑日志和持久队列存储，不连接团队 endpoint。
- 形成时的引用校验、伪造引用拒绝、Prompt 中的新 Claim 草稿与 Trace 生成：M3。
- 私有 Memory 容量、路径拦截与工具写入：M7；本轮只验证 Claim 提示词不读取私有双文件。

方案摘要的“仅语义变化时推进时间”已按当前源码修正：接受的修订总是推进到 `max(now_seconds, previous+1s)`。修订结果和分页字段保持源端结构；revision 冲突按插件规范返回结构化领域结果。
