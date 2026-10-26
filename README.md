# ACN记忆框架 · agent-claim-network

[English](README_EN.md)

**从agent工作轨迹中沉淀可复用的知识与记忆，让知识经验在团队中流动。**

ACN 是 DeepSeek Harness（DSH）的记忆插件。它把工作中的经验整理成可引用、可修订的知识，让新会话有机会复用之前的成果；也可连接 ACN 团队服务，在多个 Agent 之间分享知识和处理争议。

DSH 继续负责 Agent 主循环、上下文压缩、会话和读写文件等默认工具。ACN 负责知识与记忆，不替换这些宿主能力。

## 从哪里开始

- **第一次安装：** [带截图的使用指南](docs/user-guide.md)，从本地安装包到模型配置，再完成一次知识形成与复用。
- **已经在使用：** [配置说明](docs/config.md)、[命令与行为参考](docs/command-reference.md)、[常见限制](docs/outstanding-issues.md)。
- **准备分发：** [插件市场与发布准备](docs/release.md)。当前 `0.1.0` 未发布，公开仓库地址尚未指定。

![真实 DSH 中的 ACN 配置页](docs/assets/config-identity.jpg)

## 能做什么

| 能力 | 使用效果 |
| --- | --- |
| Claim 知识与 Trace 来源 | 保存带适用范围、证据摘要和置信度的经验；按需检索、阅读、修订并追溯工作来源 |
| Recap / Finalize | 在宿主压缩后或工作收尾时分析对话，形成值得复用的知识；可手动触发并查看任务结果 |
| 私有 Memory | 用 `MEMORY.md` / `USER.md` 保存个人经验与偏好，新会话读取冻结快照；不直接上传团队 |
| Dream | 清理一次性记录、整合同主题知识；可选工作区文件查证，保留原证据与限制 |
| 团队协作 | 经 Router 查找共享知识，经 Maintainer 投递和接收建议，内化后才改变本地知识 |
| 持久任务与迁移 | 中断后恢复后台任务；只读导入已有 ACN 的 Claim、Trace 和私有文件 |

单人模式无需团队服务，也不会发送团队请求。同一知识目录与 Agent ID 下的不同项目共用知识和私有记忆；需要项目隔离时使用独立配置。后台模型和聊天模型分别选择，可都使用已在 DSH 配置的 `deepseek-v4-flash-api`。

## 安装概览

当前提供源码构建的本地包，需要 Node `^22.19.0 || >=24.0.0` 与 pnpm `11.25.0`：

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
```

启动 DSH，在「插件 → 添加插件」的下拉菜单选择「安装第三方插件」，填入生成的 `.tgz` 的绝对路径，安装后点击「立即启用」。打开 **ACN记忆框架**，填写固定 Agent ID、知识目录、后台模型和运行模式，点击 **保存并应用**，再新建会话运行 `/acn-status`。

已实测 DSH `0.2.1-rc.2`。声明范围 `>=0.2.1-rc.2 <0.3.0` 不表示每个版本均已测试。包名仍为 `dsh-plugin-acn`；中文名为 **ACN记忆框架**，英文名为 **agent-claim-network**。

## 实际效果与边界

[EatWhich 团队开发验收](docs/validation/2026-10-26-eatwhich-team-development.md)让三个真实 DSH 身份围绕同一小程序开发功能，使用 `deepseek-v4-flash-api` 完成知识发现、争议处理、建议传播、内化和 Dream。关闭 Router 的模型重排后，两条原争议均在首轮自动采纳，裁决送达三个成员，错误知识收窄后回传团队。

这证明了该配置下的通信和使用链路，不代表知识永远正确或 Agent 总会主动检索。当前建议使用**不启用 LLM 重排的 Router**；启用重排时，候选集合波动可能阻止自动仲裁采纳。此项参考服务限制尚未修改。Dream 的严格引用校验也不能替代对知识语义和适用范围的判断。

[文档导航](docs/index.md) · [完整验收](docs/acceptance.md) · [架构](docs/architecture.md) · [开发与复验](docs/development.md) · [更新记录](CHANGELOG.md)

许可证：[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)。
