# AGENTS.md

整体使用中文与用户交互。仓库入口见 `README.md` 和 `docs/index.md`；开发与验证命令见 `docs/development.md`。

- 以当前源码和现行文档为准。文档保留稳定行为、架构约束与可复现的验证方法，不累积按日期或开发阶段编写的过程报告。
- TypeScript 使用 strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。禁止 `any` 和非空断言；确需例外时就近说明原因。
- 所有 I/O 使用异步 API；不允许悬空 Promise；持有知识、队列等领域数据锁时不等待网络或 LLM。方案指定的 worker / delivery 生命周期租约只保证单消费者，可以覆盖外部调用；释放前必须停止受保护的工作。
- 只有 `src/dsh-adapter/` 与 `src/plugins/` 可以导入 `@deepseek-ai/*` 的运行时值，类型导入不受限。测试及测试 host 可以直接使用宿主测试包。
- 模块边界使用带 `kind` 的自定义错误；工具将领域失败返回为规范值，对基础设施错误抛异常。
- 路径使用 `node:path` 的 `join` / `resolve`；通过 `os.homedir()` 展开 `~`。
- 使用 `ctx.logger` 记录日志。日志不包含 key、Memory 正文或 USER 内容。
- 每个代码模块顶部用一两行中文说明职责，注释解释约束与原因。
- 代码、注释、fixture 和示例不使用外部产品名描述实现来源或兼容对象；协议和包导入所必需的名称除外。
- 仓库任何位置禁止明文 secret、内网域名、真实用户名或内部账号；示例使用中性名称和标准保留域名。
- 公开文档和截图不包含本机提供商别名、实际数据路径或邮箱；提交使用公开维护者署名和空邮箱，不能继承全局个人邮箱。公司版权署名保留。
- Memory / USER 保持私有；团队服务不能直接修改本地知识；单人模式不发团队请求、不积累上传队列。
- 自动化测试使用真实临时文件和本地测试模型；人工验收可按用户指定使用本机已配置模型，不把一次实测当作模型质量保证。
- 完成后运行 `pnpm typecheck`、`pnpm lint`、`pnpm check:security`、`pnpm check:docs`、`pnpm test`、`pnpm build`、`pnpm pack`；安装变化还运行 `pnpm smoke:install`，另跑 `pnpm test:contract` 验证团队契约。
- 用户可见行为和实测兼容结论同步到 README 与 `docs/`；遗留问题写 `docs/outstanding-issues.md`，不新增 TODO/FIXME。
- 分支使用 `feature/`、`fix/`、`chore/`；提交使用简洁中文描述。保留用户已有变更。
