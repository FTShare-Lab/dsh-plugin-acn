# ACN记忆框架 · agent-claim-network

[English](README_EN.md)

**从agent工作轨迹中沉淀可复用的知识与记忆，让知识经验在团队中流动。**

ACN 是 DeepSeek Harness（DSH）的记忆插件。它把工作中的经验整理成可引用、可修订的知识，让新会话有机会复用之前的成果；也可连接 ACN 团队服务，在多个 Agent 之间分享知识和处理争议。

本仓库包含插件的 TypeScript 实现、网页配置界面、模型提示词和自动化测试。Router 与 Maintainer 是独立部署的 ACN 服务，插件提供与它们通信的客户端。

DSH 继续负责 Agent 主循环、上下文压缩、会话和读写文件等默认工具。ACN 负责知识与记忆，不替换这些宿主能力。

## 从哪里开始

- **第一次安装：** [带截图的使用指南](docs/user-guide.md)，从本地安装包到模型配置，再完成一次知识形成与复用。
- **已经在使用：** [配置说明](docs/config.md)、[命令与行为参考](docs/command-reference.md)、[常见限制](docs/outstanding-issues.md)。
- **参与开发：** [架构说明](docs/architecture.md)、[开发指南](docs/development.md)。

![DSH 中的 ACN 配置页](docs/assets/config-identity.jpg)

## 能做什么

| 能力 | 使用效果 |
| --- | --- |
| Claim 知识与 Trace 来源 | 保存带适用范围、证据摘要和置信度的经验；按需检索、阅读、修订并追溯工作来源 |
| Recap / Finalize | 手动 `/recap`、批量或尾部空闲、宿主压缩及归档收尾时提炼知识；只处理增量，归档后暂停自动触发 |
| 私有 Memory | 用 `MEMORY.md` / `USER.md` 保存个人经验与偏好，新会话读取冻结快照；不直接上传团队 |
| Dream | 清理一次性记录、整合同主题知识；可选工作区文件查证，保留原证据与限制 |
| 团队协作 | 经 Router 查找共享知识，经 Maintainer 投递和接收建议，内化后才改变本地知识 |
| 持久任务与迁移 | 中断后恢复后台任务；只读导入已有 ACN 的 Claim、Trace 和私有文件 |

单人模式无需团队服务，也不会发送团队请求。同一知识目录与 Agent ID 下的不同项目共用知识和私有记忆；需要项目隔离时使用独立配置。后台模型和聊天模型分别选择，均可使用 DSH 中已配置的模型。

ACN 后台任务默认输出上限为 32768 token，可通过 `llm.maxOutputTokens` 调整；已有显式配置保持生效，详见[配置参考](docs/config.md)。

## 安装概览

当前 `0.1.0` 尚未发布，可从源码构建本地安装包，需要 Node `^22.19.0 || >=24.0.0` 与 pnpm `11.25.0`：

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
```

启动 DSH，在「插件 → 添加插件」的下拉菜单选择「安装第三方插件」，填入生成的 `.tgz` 的绝对路径，安装后点击「立即启用」。打开 **ACN记忆框架**，填写固定 Agent ID、知识目录、后台模型和运行模式，点击 **保存并应用**，再新建会话运行 `/acn-status`。

DSH 版本声明范围为 `>=0.2.1-rc.2 <0.3.0`，兼容基线为 `0.2.1-rc.2`。包名为 `dsh-plugin-acn`；中文名为 **ACN记忆框架**，英文名为 **agent-claim-network**。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/` | 知识、记忆、存储、团队客户端，以及 DSH 适配和网页配置界面 |
| `prompts/` | 知识形成、整理、内化与记忆复核的模型提示词 |
| `cordis.patch.yml` | 插件组件的组合与注册配置 |
| `locale/` | 中英文本地化资源 |
| `tests/` | 单元、集成、协议契约、并发与崩溃恢复测试 |
| `scripts/` | 兼容性检查、安装检查和本地团队服务测试脚本 |
| `docs/` | 使用、配置、架构和开发文档 |

## 开发与测试

安装依赖后，在仓库根目录运行：

```sh
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test
```

`pnpm test` 会先构建插件。常规自动化测试使用临时目录和本地测试模型；团队契约测试需要独立的 ACN 源码仓库。构建、测试、打包和安装检查应串行执行，完整命令见[开发指南](docs/development.md)。

## 团队使用与限制

团队成员各自维护本地知识，通过 Router 发现其他成员分享的 Claim。遇到知识冲突时，可向 Maintainer 提交争议；处理建议通过 Inbox 送达成员，经各自内化后更新本地知识。

当前建议使用**不启用 LLM 重排的 Router**；启用重排时，候选集合变化可能阻止自动仲裁采纳。知识复用依赖 Agent 的检索与应用；Claim 的证据记录和 Dream 的引用校验不能保证结论正确，使用时仍需关注适用范围与证据限制。

[文档导航](docs/index.md) · [架构](docs/architecture.md) · [开发指南](docs/development.md) · [更新记录](CHANGELOG.md)

许可证：[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)。
