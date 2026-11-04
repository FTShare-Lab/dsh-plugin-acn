# ACN记忆框架 · agent-claim-network

[English](README_EN.md) · [使用说明书（HTML）](docs/user-guide.html) · [文档导航](docs/index.md)

**从agent工作轨迹中沉淀可复用的知识与记忆，让知识经验在团队中流动。**

ACN记忆框架是 DeepSeek Harness（DSH）的知识与记忆插件。它从工作对话中提炼有依据、带适用范围的经验，让后续会话可以查询和复用；也能连接 ACN 团队服务，让多个 Agent 共享知识、处理冲突。

本仓库包含插件的 TypeScript 实现、网页配置界面、模型提示词和测试。DSH 继续负责 Agent 主循环、上下文压缩、会话和默认文件工具；本插件负责知识与记忆。Router 和 Maintainer 由团队另行部署。

## 主要能力

| 能力 | 用途 |
| --- | --- |
| 工作复盘 | 从新增对话中提炼 Claim，记录 Trace 来源；支持手动复盘、空闲自动复盘和归档收尾 |
| 知识复用 | Agent 按需查询已有经验，结合适用范围、证据和当前任务判断是否采用 |
| 团队协作 | 通过 Router 查找团队知识，通过 Maintainer 共享结论、上报争议并接收处理建议 |
| Dream 整理 | 清理临时记录、整合相关知识；保留版本、例外与证据限制，并限制单次模型请求次数 |
| 私有 Memory | 保存持续有用的个人经验与偏好，与团队共享知识分开管理 |
| 知识与活动 | 在网页查看知识、来源、后台进度、投递状态和失败后的恢复入口 |

每份“工作配置”都有自己的 Agent ID、知识和私有记忆，可以单人使用，也可接入团队。同一配置下的项目共享知识，不同配置相互隔离。单人模式无需团队服务，不发送团队请求。

![DSH 中的 ACN 插件设置](docs/assets/upstream-settings.jpg)

## 安装与开始使用

当前 `0.1.0` 尚未公开发布。已有可信 `.tgz` 安装包时，可直接在 DSH 网页安装；从源码构建需要 Node `^22.19.0 || >=24.0.0` 与 pnpm `11.25.0`：

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
```

1. 启动 DSH，在「插件 → 添加插件 → 安装第三方插件」填写安装包在 **DSH 所在电脑上的绝对路径**，安装并启用。
2. 打开「设置 → ACN 插件设置」，新建工作配置，填写 Agent ID 并保存。单人使用可自取固定名称；团队成员使用管理员确认的身份。
3. 在「知识与模型」选择知识处理模型。它与聊天框旁的对话模型分别设置；知识目录通常保留默认值即可。
4. 新建空白会话，在首条消息前确认 ACN 工作配置，然后正常开展工作。完成一段有价值的工作后，可在「ACN → 复盘本次会话」主动整理，再到「知识与活动」查看结果。

新会话优先沿用同项目最近新建会话的有效配置，否则使用全局默认；首发后归属固定。安装前的旧会话、未选择配置就已开始聊天的会话仍可普通聊天，但不能中途启用 ACN，需另建会话使用知识与记忆。

完整图解见 **[使用说明书（HTML）](docs/user-guide.html)**。下载该文件后直接用浏览器打开即可，图片已内嵌，无需联网，也可打印或另存为 PDF。[Markdown 入口](docs/user-guide.md)适合在仓库中快速查阅。

## 团队使用

向管理员取得 Router、Maintainer 地址与对应 Agent ID；启用鉴权时还需团队密钥。在工作配置中开启「连接团队服务」，填写、检查并保存。密钥可直接输入，默认隐藏明文，由 DSH 托管；插件配置只保存内部引用。

成员复盘形成的共享知识进入团队投递队列，其他成员按需通过 Router 查询。Maintainer 的建议先进入收件箱，经本地 Agent 内化后才可能修改本地知识。**本地处理完成、团队投递完成和成员采用是不同阶段**；仲裁反馈发给直接涉争 Claim 的持有者，并非向所有成员广播。

Trace 与私有 Memory 不直接上传团队。私有记忆复核仍会使用所选模型服务。当前建议 Router 不启用 LLM 重排，以免候选集合变化阻止自动仲裁采纳；部署与边界见[使用说明书的团队章节](docs/user-guide.html#team)及[兼容限制](docs/outstanding-issues.md)。

## 兼容与文档

DSH 声明支持范围为 `>=0.2.1-rc.2 <0.3.0`。macOS 已完成本机验收；Windows 已补齐路径、文件保护和 CI，尚未完成 Windows 桌面实机验收。同一 JavaScript 安装包用于宿主支持的平台，详见 [DSH 兼容边界](docs/dsh-compat.md)。

| 需要了解 | 文档 |
| --- | --- |
| 安装、配置、日常操作和常见问题 | [使用说明书（HTML）](docs/user-guide.html) |
| 参数、目录、模型和配置生效规则 | [配置说明](docs/config.md) |
| 命令、工具、数据迁移与恢复 | [命令与行为参考](docs/command-reference.md) |
| 模块职责与数据所有权 | [架构说明](docs/architecture.md) |
| 构建、测试和安装检查 | [开发指南](docs/development.md) |

## 仓库结构与开发

`src/` 为实现与网页界面，`prompts/` 为知识处理提示词，`tests/` 为回归和团队契约测试，`scripts/` 为验证脚本，`docs/` 为文档。`cordis.patch.yml` 注册插件组件，`locale/` 提供中英文本地化。

```sh
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test
```

自动化测试使用临时目录和本地测试模型。团队契约测试还需要独立的 ACN 源码仓库；完整验证流程见[开发指南](docs/development.md)。版本变化见[更新记录](CHANGELOG.md)。

许可证：[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)。

## ACN 原仓库

ACN 原生应用、Router 和 Maintainer 的源码与部署说明见 [FTShare-Lab/agent-claim-network](https://github.com/FTShare-Lab/agent-claim-network)。本仓库维护其 DSH 插件实现。
