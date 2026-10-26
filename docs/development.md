# 开发指南

本文面向插件维护者。安装配置见[使用指南](user-guide.md)，模块职责见[架构](architecture.md)。

## 构建与自动化检查

使用 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.25.0`。以下命令应串行执行：测试、契约脚本、打包和安装检查都会使用或重建同一个 `lib/`。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test
ACN_REPO=/path/to/reference pnpm test:compat
ACN_REPO=/path/to/reference pnpm test:contract
pnpm build
pnpm pack --pack-destination .artifacts
pnpm smoke:install
```

`ACN_REPO` 指向参考 ACN 源码仓库，版本与提交基线见[ACN 兼容边界](acn-compat.md)。这些检查需要 Rust 工具链；脚本会按需读取参考仓库的 `export_env.sh`。普通单元与集成测试使用临时目录和本地测试模型，不依赖真实模型服务。

| 检查入口 | 验证范围 |
| --- | --- |
| `pnpm test` | 工具与宿主接入、存储、权限、并发、进程崩溃和恢复 |
| `pnpm test:compat` | 已提交的协议 fixture，以及 TypeScript 写出的 YAML 能否被 Rust 读回 |
| `pnpm test:contract` | 在临时目录启动真实 Router / Maintainer，验证查询、上传、Inbox 和整合依赖 |
| `pnpm smoke:install` | 新 DSH profile 中的实际包安装、Loader 生命周期、公开资源和不兼容引擎拒绝 |
| `pnpm check:security` | 版本控制文本中的凭据、邮箱、个人路径，以及可达提交邮箱 |
| `pnpm check:docs` | Markdown 相对链接与标题锚点 |

安装包包含运行 JS、类型声明、提示词、组合 patch、双语说明、本地化资源、图标、使用截图和许可证；不包含源码测试、依赖缓存、临时项目或运行日志。安装检查使用独立的 `DSH_HOME`，不会修改日常 profile。

安全扫描不识别截图文字。更新图片时应检查可见内容，使用中性示例，避免展示实际数据路径、提供商别名、邮箱或凭据。

## 隔离网页调试

选择本机 Web profile 已配置的模型提供商，并将 `your-provider` 替换成它的 ID：

```sh
export ACN_ACCEPTANCE_PROVIDER=your-provider
pnpm smoke:web
```

脚本默认使用 `deepseek-v4-flash-api`；可通过 `ACN_ACCEPTANCE_MODEL_ID` 选择该提供商下其他已配置模型。凭据只传给子进程，模型请求会访问所选提供商。脚本创建临时工作区、知识目录和 DSH profile，并输出网页地址；日常配置不变。停止脚本会结束其创建的服务。

只验证安装与网页配置时使用：

```sh
ACN_WEB_INSTALL=browser pnpm smoke:web
```

此模式不预装 ACN、不预填其配置，也不生成 seed Claim。按[使用指南](user-guide.md)安装输出的 tarball，填写配置并保存。以相同 `ACN_WEB_HOME` 重启，可检查保存与恢复；已有 profile 不会再次初始化。

不调用真实模型的流程调试可使用 `ACN_WEB_MODEL=local pnpm smoke:web`。这是预设响应的本地测试模型，不适合评价知识质量。

建议检查以下稳定行为，而不是只看任务是否显示成功：

- 安装、启用、保存、重读草稿与重启后，身份、目录和模型配置符合预期。
- 完成一项小任务并 Finalize 后，能从新会话检索 Claim、读取 Trace，并保留适用范围与未验证条件。
- Memory 更新后，新会话读取新快照，原会话继续使用原快照；私有内容不直接进入 Claim 或团队上传。
- 模型输出不合法、服务不可达或进程中断时，任务状态可解释，恢复后没有重复提交或丢失输入。

## 本地团队调试

同时启动参考服务和一个可从网页安装插件的隔离 DSH：

```sh
ACN_REPO=/path/to/reference \
ACN_CONTRACT_WEB_HOME=/path/to/isolated-web-check \
pnpm test:contract
```

该命令先构建 Router / Maintainer，再为 `agent-a`、`agent-b` 生成临时凭据，启动两项服务和网页宿主。页面中的认证变量名分别填写 `ACN_TEST_TEAM_CREDENTIAL` 与 `ACN_TEST_OTHER_CREDENTIAL`；地址使用脚本实际输出的回环 endpoint。停止脚本会结束这些服务并清理临时团队数据。

此模式默认不启用 Router 模型检索或 Maintainer 自动仲裁，只验证通信。需要评价模型仲裁时，应另行在服务端配置 Maintainer 模型并启用仲裁；推荐保持 Router 为词法检索，避免[已知重排限制](outstanding-issues.md#团队仲裁与信息边界)。插件中的模型选项不会替团队服务配置模型。

接入已经启动的测试服务时，为 `pnpm smoke:web` 同时提供 `ACN_WEB_TEAM_ROUTER`、`ACN_WEB_TEAM_MAINTAINER`，并用 `ACN_WEB_TEAM_KEY_ENV` 指定认证环境变量名。默认变量名为 `ACN_WEB_TEAM_CREDENTIAL`。少配一个 endpoint 会启动失败；凭据不写入配置文件。

多个成员分别设置独立的 `ACN_WEB_HOME`、不同的 `ACN_WEB_AGENT_ID` 和对应凭据。可用 `ACN_WEB_SEED_CLAIM=false` 从空知识开始，避免多个成员生成同一个 seed ID。`ACN_WEB_TEAM_TIMEOUT_MS` 控制团队请求超时，默认 15000 毫秒。

团队检查应覆盖 A 形成并上传知识、B 检索和复用、冲突上报、Maintainer 给出建议、各成员 Inbox 内化、修订回传，以及 Dream 整理后的依赖交付。仲裁完成、建议送达和本地内化是不同阶段，应分别确认；服务断开后的补送也应检查。

## Dream 恢复调试

设置 `ACN_WEB_EVIDENCE_CALIBRATION=true` 可在隔离宿主启用文件查证，默认关闭。先运行 `pnpm build`，再执行 `node scripts/seed-dream-preservation.mjs legacy` 或 `fresh`，可创建带版本限制的合成材料。

以输出的根目录作为 `ACN_WEB_HOME` 启动 `pnpm smoke:web`。新任务场景可同时设置 `ACN_WEB_DISABLE_MEMORY_REVIEW=true`，保留预置 review 排队任务，检查禁用处理器不会阻塞 Dream。随后运行 `/dream`，通过 `/acn-status` 和 `/claim show <id>` 核对恢复结果、证据摘要与来源承接。脚本不导入日常知识。

## CI 配置

工作流定义在 `.github/workflows/ci.yml`，检查矩阵使用 Node 22 / 24。团队契约 job 需要仓库变量 `ACN_REFERENCE_REPOSITORY`，其值为参考源码仓库；私有跨仓库访问另用 `ACN_REFERENCE_TOKEN` secret。缺少参考仓库变量会明确失败，不会跳过契约检查。

参考提交与 fixture 应一起维护。升级 ACN 或 DSH 后，先核对协议、事件、工具门禁、模型取消和卸载边界，再运行上述检查。测试是否通过以本次命令退出码及 CI 结果为准，不把旧报告的通过数量当作当前结论。
