# ACN 记忆框架

[English](README_EN.md) · [使用指南](docs/user_guide.md) · [开发文档](docs/index.md)

**让每个 Agent 的经验成为团队可复用的知识。**

ACN 记忆框架是 DeepSeek Harness（DSH）的知识协作插件。它从工作对话中沉淀有依据、带适用范围的经验，并通过团队服务，让不同 Agent 分享结论、检索彼此的知识、处理分歧和接收团队建议。也可以个人使用，在自己的会话之间积累与复用知识；接入团队能更充分地发挥 ACN 的协作价值。

| 能力 | 你可以做什么 |
| --- | --- |
| 团队协作 | 检索团队知识、分享结论、上报争议并处理团队反馈 |
| 会话复盘 | 把值得复用的工作结论整理为知识，并保留来源 |
| 知识复用 | 在新任务中查询已有经验，结合证据和适用范围使用 |
| 知识整理 | 使用 Dream 清理临时记录、整合相关知识 |
| 知识与活动 | 阅读知识正文、返回来源会话，查看处理进度和失败原因 |

![DSH 中的 ACN 工作配置](docs/assets/upstream-settings.png)

本插件管理以 Claim 为主体的可复用经验，在接入团队时促进经验分享与流动；不维护私有 Memory 及其管理。知识提炼时会过滤工具名包含 `memory` 的工具调用及其结果（不区分大小写）。

## 开始使用

在 DSH「插件 → 添加插件」填写 **`@ftai/dsh-plugin-acn`**，安装并启用。需要指定版本时，可填写 `@ftai/dsh-plugin-acn@0.1.0`。

1. 向团队管理员取得 Agent ID、Maintainer 和 Router 地址，以及启用鉴权时的团队 Key（可选）。打开「ACN 插件设置」，新建工作配置，开启「连接团队服务」，填写信息、检查连接并保存。
2. 在「知识与模型」选择知识处理模型；新建会话，在输入框旁确认 ACN 工作配置后开始工作。
3. 完成一段工作后，在 ACN 菜单选择「复盘本次会话」，到「知识与活动」查看结果。

个人使用时，新建配置并填写固定的 Agent ID，保持「连接团队服务」关闭即可；本地知识仍可积累和复用。

每份工作配置保存各自的知识。同一配置可跨项目复用，不同配置相互隔离；会话开始后归属固定。安装、选择配置、团队连接和常见问题见[使用指南](docs/user_guide.md)。

## 版本更新

可在 [GitHub 仓库](https://github.com/FTShare-Lab/dsh-plugin-acn)选择「Watch → Custom → Releases」，订阅发版通知。当前 DSH 不会自动提醒本插件有新版本，也不会自动升级。

更新前，在「知识与活动 → 处理活动」确认最近任务已不再显示「等待处理」或「正在处理」，再到 DSH 插件页卸载 ACN，通过「添加插件」输入 `@ftai/dsh-plugin-acn` 安装新版。卸载不会删除知识目录中的数据；重新安装后检查工作配置和知识目录，再新建会话使用。重复添加同名包会提示已安装，不会安装出两份。详细步骤见[更新插件](docs/user_guide.md#更新插件)。

## 接入团队

本插件提供 **Agent（A）侧功能**。**Maintainer（M）和 Router（R）需要由用户团队按照 [ACN 官方仓库](https://github.com/FTShare-Lab/agent-claim-network) 自行部署**，插件不会替团队启动这两项服务。

部署完成后，管理员向成员提供 Agent ID、两项服务地址，以及启用鉴权时的团队 Key（可选）。成员在工作配置中开启「连接团队服务」，填写信息并检查连接即可。单人使用无需部署 M、R，也不会发送团队请求。

团队模式会将整理出的 Claim 和 Dispute 共享给 Maintainer。Router 返回的知识供助手参考，团队建议由 Agent 结合本地情况处理。Trace 不直接上传团队；知识处理会使用所选模型服务。

## 维护与开发

- [使用指南](docs/user_guide.md)：带 DSH 界面截图的日常操作说明。
- [配置参考](docs/config.md)：高级参数和完整配置。
- [开发指南](docs/development.md)：构建、测试、打包和安装验证。
- [兼容范围](docs/dsh-compat.md)与[已知限制](docs/outstanding-issues.md)：版本、平台及使用边界。

源码位于 `src/`，提示词位于 `prompts/`，测试位于 `tests/`。插件支持 Apple Silicon Mac（macOS 13+）和 Windows；各平台的实际验收范围见兼容文档。

许可证：[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)。
