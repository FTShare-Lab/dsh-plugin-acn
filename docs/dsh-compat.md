# DSH 兼容边界

兼容基线为 DSH `0.2.1-rc.2`，对应源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。声明 `engines.dsh: >=0.2.1-rc.2 <0.3.0` 不代表逐版本实测。Node 支持 `^22.19.0 || >=24.0.0`，CI 配置使用 Node 22 / 24。

身份持久化使用宿主公开的 `appendPluginRecord` / `pluginRecordOf`，不修改会话日志格式。

## 平台

本插件支持 Apple silicon Mac（macOS 13 或更高）和 Windows，与 DSH 桌面版保持一致。两个平台使用同一插件安装包，包含 JavaScript 与静态资源，不含平台专用二进制。独立 CLI 需满足上述 Node 版本要求，桌面应用使用自身运行时。

私有文件读取会检查符号链接、硬链接以及路径与打开文件的身份；在 Windows 缺少 `O_NOFOLLOW` 等 POSIX 标志时仍执行这些检查。普通文件工具仅拒绝指向私有数据的硬链接，公开项目的硬链接不阻断搜索。安装验收使用 Node 脚本和系统临时目录；Windows 主 CI 配置覆盖 Node 22 / 24 的全量测试与基线 CLI 安装，另保留 rc.5 CLI 安装检查。

Windows 导入命令保留原生路径的反斜杠，支持盘符、UNC、含空格的引号路径与 `~\` 主目录前缀。Agent ID、配置标识等本地目录名会拒绝 `con`、`nul`、`com1` 等 Windows 设备保留名称；其他平台已有合法名称继续兼容。

安装由宿主读取 tarball 的 `dsh.bundle.patch`，八行组合（插件配置入口和七个领域组件）按隔离服务依赖装配。只有 `plugins/` 与 `dsh-adapter/` 导入宿主运行时；协议与核心模块可独立使用。按 id 覆盖整体替换 config，插件再补字段默认值。

| 公开接口 | 用途与约束 |
| --- | --- |
| `agent/created` serial、SessionHeader | 冻结知识目录，身份和子代理权限来自宿主 |
| systemPrompt sections | 同步读已准备缓存；数据不做模板插值 |
| `agent/pre-step`、`agent/request`、`session/event` | 请求准入后的知识变化、路由与公开投影 |
| tools DSL、renderer、最终 guard | 原生 / 程序桥工具结果、权限与路径门禁 |
| `llm.prepareCall`、stream、BlockAssembler | 宿主模型路由、结构化后台调用及取消 |
| `agents.create` setup / dispose | 隔离只读证据子会话、专属系统上下文与预算 |
| `dsh.client`、`plugins.bundle.config`、`settings.section`、ModuleLoader | 配置入口与 ACN 插件设置，宿主共享 React |
| `conversation.input.left`、conversation blocks、`uiWorkspace.openSession` | 会话团队选择、首次准备反馈、知识活动与返回来源 |
| `sessionPersistence.list/open`、`sessions.list` | 同项目按创建时间选择最近普通会话的 upstream，只读历史，不恢复 Agent |
| `sessionController.inspect` / `resolveAgent` | 只读历史与显式恢复分离，不因浏览启动同步 |
| `uiWorkspace.pickDirectory`、`sessionController.openWorkspacePath` | 目录选择与系统文件管理器由桌面宿主提供，选择只更新草稿；打开前展开主目录并检查目录存在 |
| Typert Remote / Gateway、`configEditor.edit` | 宿主认证、严格入参、profile 文件锁、原子写和普通字段重载 |
| `workspaceRegistry.archiveSession`、`archivedSessionIds` | 归档前冻结范围，归档后暂停；包裹公开方法，卸载时恢复。宿主升级需重验普通及停止归档 |
| `credentials.resolve/describe/set` | 每次团队请求解析引用，设置页只回传可用状态；密码独立写入宿主托管存储 |
| `commands.register` | 命令不进入普通模型历史，贡献随依赖卸载撤销 |
| fs 路径解析、写 / 编辑意图 | 已知文件工具的私有路径保护；没有通用读取前 hook |

知识、任务及恢复状态保存在插件自身目录；身份绑定通过宿主公开插件记录接口写入会话日志，不自行改写宿主日志格式。Recap 监听宿主实际成功压缩的结果，不改变 DSH 的压缩策略。兼容基线的[标准模式](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/web-app/presets/standard.patch.yml)已提供 `compaction-basic` 和 `command-compact`；顶层同名行因能力由会话模式管理而停用，不能据此判断客户端关闭了压缩。两项功能的关系见[会话压缩与知识复盘](config.md#会话压缩与知识复盘)。DSH 当前工作区可能与启动目录不同，需在客户端选择实际项目；验收脚本显式配置临时默认工作区。

原生工具、程序桥、Loader 单行禁用、安装、恢复会话、证据子会话和 知识目录保护都有自动化测试。宿主升级后应重新检查工具门禁、事件、压缩、模型取消和卸载边界，再按[开发指南](development.md)验证。

模型适配器可能只转发工具 Schema 的顶层 `properties` 和 `required`。Claim、Router 查询和 Dream 只读 Claim 因此同时提供顶层参数字段与完整的动作联合约束，避免模型收到空参数说明。执行时仍按具体动作严格校验；展示全部动作的字段不代表可以混用字段，也不放宽 revision、所有权或只读限制。

## 操作系统

两个受支持桌面平台的实际验收范围如下。

| 平台 | 当前覆盖与验证边界 |
| --- | --- |
| Apple silicon Mac（macOS 13 或更高） | 本机全量测试、真实安装与插件界面回归；继续保留 POSIX 文件打开标志和权限检查 |
| Windows | 已在 Windows 11、DSH `0.2.1-rc.5` 实机验证预构建包安装、配置与默认切换、原生目录选择和打开、中文及空格路径、知识浏览与来源跳转、宽窄窗口、Recap 和 Dream 重试；实际团队服务的连接检查与收件同步通过，模型流程使用本地模拟服务 |

macOS 和 Windows 本机自动化均已通过，包含符号链接路径保护测试。Windows 上运行这类测试需允许测试账户创建符号链接，普通用户安装和使用插件无需此权限。路径单测中的 UNC 支持仅验证解析，不代表已验证 SMB 共享存储的锁、原子发布或断电恢复。

知识目录建议位于当前用户独占的本地磁盘；普通文件工具不能绕过领域接口访问 ACN 数据。Windows 目录应具有正确的 ACL；保护范围见[已知限制](outstanding-issues.md#领域文件访问)。

## 安装包与界面资源

预构建包包含双语 locale、图标、README 和图文指南。`meta.detail` 指向包内的中英文 README；安装检查会确认正文和相对图片完整。长文详情的显示取决于宿主支持，兼容基线尚未验证该界面的渲染；插件设置界面与 README 介绍区是不同入口。

插件已发布到 npm，在 DSH「添加插件」中填写 `@ftai/dsh-plugin-acn` 即可安装，也可使用 GitHub Release 中的预构建 `.tgz`。源码仓库不跟踪 `lib/`，也未配置 Git 安装用的 `prepare`。从 Git 获取源码后应先构建打包，不能把仓库地址直接当作已支持的安装入口。
