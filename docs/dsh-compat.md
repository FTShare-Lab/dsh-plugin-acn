# DSH 兼容边界

兼容基线为 DSH `0.2.1-rc.2`，对应源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。声明 `engines.dsh: >=0.2.1-rc.2 <0.3.0` 不代表逐版本实测。Node 支持 `^22.19.0 || >=24.0.0`，CI 配置使用 Node 22 / 24。

身份持久化使用宿主公开的 `appendPluginRecord` / `pluginRecordOf`，不修改会话日志格式。

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

原生工具、程序桥、Loader 单行禁用、安装、恢复会话、证据子会话和 Memory 路径保护都有自动化测试。宿主升级后应重新检查工具门禁、事件、压缩、模型取消和卸载边界，再按[开发指南](development.md)验证。

## 安装包与界面资源

预构建包包含双语 locale、图标、README 和图文指南。`meta.detail` 指向包内的中英文 README；安装检查会确认正文和相对图片完整。长文详情的显示取决于宿主支持，兼容基线尚未验证该界面的渲染；网页配置页与长文详情是不同入口。

当前采用预构建 `.tgz` 安装，源码仓库不跟踪 `lib/`，也未配置 Git 安装用的 `prepare`。从 Git 获取源码后应先构建打包，不能把仓库地址直接当作已支持的安装入口。
