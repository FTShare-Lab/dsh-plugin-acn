# DSH 兼容边界

实测宿主为 DSH `0.2.1-rc.2`，对应源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。声明 `engines.dsh: >=0.2.1-rc.2 <0.3.0` 不代表逐版本实测。Node 支持 `^22.19.0 || >=24.0.0`，发布验收使用 Node 22 / 24。

2026-10-25 的实际使用审核补充 Node `26.4.0` 本地验证，未据此推断其他未测版本。[结果与限制](validation/2026-10-25-usage-audit.md)。身份持久化使用宿主公开的 `appendPluginRecord` / `pluginRecordOf`，不修改会话日志格式。

安装由宿主读取 tarball 的 `dsh.bundle.patch`，九行组合（网页配置入口和八个领域组件）按隔离服务依赖装配。只有 `plugins/` 与 `dsh-adapter/` 导入宿主运行时；协议与核心模块可独立使用。按 id 覆盖整体替换 config，插件再补字段默认值。

| 公开接口 | 用途与约束 |
| --- | --- |
| `agent/created` serial、SessionHeader | 冻结目录 / Memory，身份和子代理权限来自宿主 |
| systemPrompt sections | 同步读已准备缓存；数据不做模板插值 |
| `agent/pre-step`、`agent/request`、`session/event` | 请求准入后的知识变化、路由与公开投影 |
| tools DSL、renderer、最终 guard | 原生 / 程序桥工具结果、权限与路径门禁 |
| `llm.prepareCall`、stream、BlockAssembler | 宿主模型路由、结构化后台调用及取消 |
| `agents.create` setup / dispose | 隔离只读证据子会话、专属系统上下文与预算 |
| `dsh.client`、`plugins.bundle.config`、ModuleLoader | 网页入口、插件详情表单、宿主共享 React |
| Typert Remote / Gateway、`configEditor.edit` | 宿主认证、严格入参、profile 文件锁、原子写和普通字段重载 |
| `commands.register` | 命令不进入普通模型历史，贡献随依赖卸载撤销 |
| fs 路径解析、写 / 编辑意图 | 已知文件工具的私有路径保护；没有通用读取前 hook |

知识、任务及恢复状态保存在插件自身目录；身份绑定通过宿主公开插件记录接口写入会话日志，不自行改写宿主日志格式。Recap 监听真实压缩结果；此版 Web 模板默认关闭 `compaction-basic` 和 `command-compact`，需要按[配置](config.md#宿主压缩与-recap)启用。Web 默认工作区也可能与启动 cwd 不同，需在宿主选择项目；验收脚本显式配置临时默认工作区。

原生工具、程序桥、Loader 单行禁用、真实安装、恢复会话、证据子会话和 Memory 路径保护都有测试。最终结果见[验收](acceptance.md)，历史细节见[分阶段适配](validation/dsh-milestones.md)。宿主升级后应重新检查工具门禁、事件、压缩、模型取消和卸载边界，再跑完整验收。

## 分发与展示

本机插件发现页使用用户添加的索引，没有默认官方上架入口。当前预构建包包含双语 locale、图标、README 和图文指南；按新版上游规范声明了 `meta.detail`，但本机 rc.2 未验证新版长文详情渲染。公开仓库、npm 发布和索引收录均待后续决定，详见[发布准备](release.md)。
