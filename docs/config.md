# 配置

日常配置可在 DSH 的「ACN 插件设置」中完成，包括工作配置、知识处理模型和六项高级参数。完整配置保存在组合中的 `id: acn-knowledge` 行，其他参数可通过 YAML 管理。

## 插件设置

打开 DSH「设置 → ACN 插件设置」或「插件 → ACN记忆框架」，也可以从聊天框的 **ACN** 菜单进入。三个入口共用同一张表单。

| 页签 | 可以做什么 |
| --- | --- |
| **工作配置** | 创建单人或团队 upstream，查看各自的知识与活动；进入「配置」调整启用状态和「设为默认」，保存后生效。 |
| **知识与模型** | 选择后台模型和所有配置的知识根目录。模型检查成功后保存，取消或失败会保留原模型。 |
| **偏好** | 设置结果提示，调整 Inbox 过期、Router 查询总超时、HTTP 单次超时及三项重试参数。 |

每份工作配置有自己的 Agent ID 和知识库。新建时只需填写 Agent ID，显示名称可选。单人使用可自取固定名称，例如 `coding`。以后打开这份配置，开启「连接团队服务」并填写 Router、Maintainer 地址及团队鉴权密钥，继续使用同一个 Agent ID 和知识库。两项地址必须同时填写或留空。需要部署服务时可参考[原 ACN 仓库](https://github.com/FTShare-Lab/agent-claim-network)。

知识根目录支持 `~/`，也支持 Windows 的 `~\`、盘符绝对路径与带空格的路径。默认根目录仍为 `~/.acn-dsh`，在 Windows 上会展开到当前用户主目录，不会相对于项目目录创建 `~` 文件夹。知识目录输入框可填写系统原生路径；高级 YAML 中的 Windows 路径建议使用单引号，例如 `'D:\ACN data'`，避免双引号的转义规则。

Windows 不允许 Agent ID、upstream 标识或旧目录映射使用 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9` 等保留名称，大小写均适用。保存时会提示并保留输入；直接修改 YAML 也不能绕过运行时检查。这只限制本机目录，不修改团队协议中的 Agent ID 规则，macOS 的既有名称仍有效。跨设备复用配置时请选 `coding`、`agent-a` 等中性名称；旧的不可用配置可先停用，再新建合法配置，不会自动改 ID 或迁移数据。

「检查连接」先按保存规则校验填写内容，再分别验证两个服务和认证。格式错误会在操作按钮附近指出对应字段，输入保留；地址格式有效但服务离线时仍可保存。地址支持部署路径前缀，不允许用户名、密码、查询参数或片段。在「团队鉴权密钥」直接输入 key，由 DSH 托管；配置只保存自动生成的引用。模型密钥沿用宿主配置。替换密钥使用新引用，只有配置保存成功后才采用；保存失败保留输入和原密钥。已绑定密钥的团队配置修改 Agent ID 时，需要同时输入新身份密钥，或明确移除绑定。若同时保存为单人模式，自动解除旧身份的密钥绑定，旧凭据保留。「移除密钥绑定」可明确解绑，保存前可以撤销。保存配置不会让正在运行的会话切换客户端或密钥；新启动的会话使用保存后的配置。未发送的会话若已启动旧实例，菜单会显示实际模式，并可点击「按已保存配置启动」。新运行实例恢复旧会话时仍选择原 upstream 和 Agent ID，并保留原知识目录。

新会话优先沿用同项目最近新建的普通会话所选 upstream。读取按创建时间排序，不按最近聊天或查看时间；内部子代理不参与，目录的符号链接别名视为同一项目。最近配置失效或归属无法确认时回退到全局默认；全局默认也为空时，可在首发前从 ACN 菜单明确选择，或不启用 ACN 直接聊天。首发前可以改选，首发后归属固定；派生会话继续继承父归属。已有会话和草稿不因新会话的选择而改绑。

选择资格在安装插件后创建空白会话时记录并持久化。安装前的会话、没有选择配置就开始聊天的会话可以继续普通工作，但不能在已有历史上绑定团队；不会注入 ACN 上下文或收集该会话的知识投影。旧版在未配置时记录的空身份只作为创建资格兼容读取，不授予知识访问权限。无绑定历史与已有绑定失效分别处理：前者不阻止聊天，后者仍需恢复原身份，不能回退到默认配置。

此预选直接读取宿主的公开会话记录，不保存项目默认选项，不恢复历史 Agent，也不因读取历史调用模型或同步团队。项目目录只用来确定会话属于哪个项目，不决定知识位置。

团队启动、实际恢复或手动同步会处理 Inbox。连接、鉴权或内化失败会保留归属并提示原因，允许继续本地工作。单人不发团队请求，仍可通过 `/inbox` 处理已落盘的本地 pending。浏览知识和只读检查历史归属不会同步或调用模型。打开完整会话（包括「打开来源会话」）时，宿主可能恢复 Agent，并按团队启动配置同步 Inbox。结果通过聊天框外的提示展示，避免改变输入框尺寸。

新知识库位于 `<home>/<upstream>/data/agents/<agentId>/`。不同 upstream 即使 Agent ID 相同，本地知识也分开；同一 upstream 的多个项目会话共用知识。两个相同 Agent ID 连接同一团队时，在通过鉴权后对应同一个远端成员。当前 upstream 的 `ACN.md` 在创建会话时冻结，旧会话恢复继续使用原快照。

### 已有配置升级

旧配置仍可读取。第一次在工作配置页保存时，会保留原配置备份 `upstream-migration-v1.yaml`，将原单人入口、旧全局团队和具名连接映射为 upstream。备份和原数据都在知识根目录，迁移不搬动实体文件，也不按相同 Agent ID 合并知识库。旧具名连接的大小写标识保留为内部目录映射，旧会话仍按持久身份找到原数据。原「默认团队候选」不会自动升级为默认入队。

已有有效身份绑定的会话在保存升级后继续使用原配置，包括仍打开的会话和重新恢复的历史；无需重新入队，也不会被新的默认配置接管。迁移会校验全部旧绑定记录，损坏、相互矛盾或与现有身份不匹配的记录不能自动恢复权限。没有绑定的历史仍只能普通聊天，不能借配置升级中途入队。

旧个人目录 `<home>/agents/<agentId>/`、旧团队入口和 `<home>/connections/<连接ID>/agents/<agentId>/` 继续使用原路径。内部迁移映射不在插件设置中开放编辑。修改显示名称不改变目录；修改 Agent ID 或知识根会选择另一份存储，旧数据保留，旧会话需恢复原身份后继续。停用也保留数据，可恢复。

### 接入团队与更换地址

单人期间不积累上传任务，历史 Claim 在接入后仍可本地使用，不会整库补传。已处于团队模式的 upstream 更换地址会沿用知识与上传队列，原待投记录没有固定旧服务器地址。新配置启动后，仍符合重试条件的记录可能发送到新 Maintainer。页面显示当前待投数量并说明影响；需要隔离团队时新建 upstream。

「返回工作配置」和「取消编辑」会放弃当前配置草稿。关闭并重新打开设置可读取最新保存值；保存冲突时可点击「刷新并保留草稿」核对修改。未改动的默认开关跟随最新保存值，主动修改的选择保留在草稿中。模型或偏好单独保存，不会提交正在编辑的工作配置草稿。保存使用宿主的版本校验和原子配置编辑器。有 Agent 正在运行时，先结束当前轮次再保存。

「偏好」中高级参数的「重置为默认值」先填入草稿，点击「保存高级参数」才会生效。沿用插件默认值：Inbox 600 秒、Router 50 秒、HTTP 15 秒、额外重试 3 次、基础等待 500 毫秒、最长等待 8000 毫秒。设置界面将秒换算为配置中的毫秒；HTTP 超时与模型超时独立。显式修改全局 HTTP 超时时，会统一现有工作配置的团队请求超时；只修改其他偏好保留各连接原值。新启动的会话与后台实例采用新参数，已有会话保留启动配置。编辑工作配置的草稿保留期间，请先保存或取消该草稿，再保存高级参数。

## YAML 与完整字段

需要高级配置时，在 profile 的 `cordis.patch.yml` 加入以下覆盖项，并重新启动 profile：

新安装推荐使用 upstream，例如以下两份单人配置。以后在其中一份补填两个 endpoint 即可接入团队。

```yaml
- id: acn-knowledge
  config:
    home: ~/.acn-dsh
    upstream: coding
    upstreams:
      coding:
        name: 日常开发
        agentId: coding
      review:
        name: 独立审查
        agentId: reviewer
```

`upstream` 是没有可用项目历史时的全局默认，可留空；没有历史且未设置全局默认时需明确选择。`upstreams.<标识>` 使用小写字母、数字、下划线和连字符，排除原版保留目录名。每项支持 `name`、`agentId`、`enabled`、`routerEndpoint`、`maintainerEndpoint`、`keyEnv` 和 `timeoutMs`。旧版 `projectUpstreams` 仅兼容读取，不再影响预选，下次保存配置时会移除。`legacyStorage` / `legacyKey` 是升级自动生成的内部目录映射。

以下完整默认模板也保留旧单身份配置，便于兼容已有安装。未列出可选的 `upstreams` 时继续使用旧入口。

<!-- config:complete -->
```yaml
- id: acn-knowledge
  config:
    upstream: ''
    agentId: agent-a
    home: ~/.acn-dsh
    sessionEpoch: 0
    connections: []
    defaultConnection: ''
    legacyEnabled: true
    showCompletion: true
    team:
      routerEndpoint: ''
      maintainerEndpoint: ''
      keyEnv: ''
      timeoutMs: 15000
      routerTimeoutMs: 50000
      retryCount: 3
      retryBaseDelayMs: 500
      retryMaxDelayMs: 8000
    llm:
      provider: ''
      model: ''
      maxOutputTokens: 32768
      timeoutMs: 600000
      structuredRetries: 5
    catalog:
      maxClaims: 20
      maxChars: 24000
    formation:
      recapOnCompaction: true
      idleRecap: true
      recapMinTurns: 10
      recapMinTokens: 100000
      recapBatchIdleMinutes: 5
      recapTailIdleMinutes: 60
      recapScanSeconds: 30
      finalizeIdleMinutes: 0
      finalizeOnDispose: false
    inbox:
      pullOnSessionStart: true
      processingStaleAfterSecs: 600
    dream:
      enabled: true
      minIntervalHours: 24
      minChangedClaims: 5
      checkIntervalHours: 4
      maxModelSteps: 24
      maxWrapUpSteps: 3
      evidenceCalibration: false
      evidenceMaxCalls: 32
      evidenceMaxSteps: 24
      evidenceMaxBytes: 1048576
      evidenceMaxChars: 16000
      evidenceMaxFiles: 256
```

按 id 覆盖会整体替换该行的 config，所以每次覆盖都需包含希望保留的自定义项。未填写的字段由插件补默认值。

旧入口的 `agentId` 只能含小写字母、数字、下划线和连字符。未配置 `upstreams` 且该字段为空时，插件保持未配置状态：只有 ACN 的 `/acn-status`，不注册 Claim 工具与知识段落，不访问知识磁盘。`home` 支持 `~`，实际目录为 `<home>/agents/<agentId>/`，与工作区 cwd 无关。

当前可用的行为配置：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `agentId` | 空 | 旧入口的知识 holder；配置 `upstreams` 后由所选项确定 |
| `home` | `~/.acn-dsh` | 独立数据根目录 |
| `sessionEpoch` | 0 | 更换身份或知识目录时自动保存的会话时间边界，不应手动清零 |
| `connections` | 空数组 | 具名连接：`id`、`name`、`enabled`、`agentId`、两个 endpoint、`keyEnv`、`timeoutMs`；ID 确定存储位置，不应重用为另一团队 |
| `defaultConnection` | 空 | 团队菜单候选，不自动接入 |
| `legacyEnabled` | true | 是否启用旧版 `team` 连接；停用保留原数据 |
| `showCompletion` | true | 显示来源会话的知识处理结果 |
| `catalog.maxClaims` | 20 | 冻结目录条数上限；显式设置更大值仍有效 |
| `catalog.maxChars` | 24000 | 目录的 Unicode 字符上限 |
| `llm.provider` / `llm.model` | 空 | 指定后台路由；为空时形成用本会话路由，Inbox / Dream 用持久的同一知识身份下最近会话路由 |
| `llm.maxOutputTokens` | 32768 | 后台模型输出 token 上限；显式配置优先于默认值 |
| `llm.timeoutMs` | 600000 | 每次后台模型请求的超时毫秒数；Dream 每次尝试重新计时，不是整次整理总时限 |
| `llm.structuredRetries` | 5 | 结构和引用校验的最大模型响应次数 |
| `formation.recapOnCompaction` | true | 压缩后入队 Recap |
| `formation.idleRecap` | true | 启用批量和尾部空闲 Recap；不影响手动、压缩及归档 |
| `formation.recapMinTurns` | 10 | 批量门槛：尚未处理的已完成人工轮次 |
| `formation.recapMinTokens` | 100000 | 批量门槛：尚未处理公开投影的估算 token，与轮次取“或” |
| `formation.recapBatchIdleMinutes` | 5 | 达到批量门槛后仍需满足的空闲分钟数 |
| `formation.recapTailIdleMinutes` | 60 | 少量未处理内容的空闲分钟数 |
| `formation.recapScanSeconds` | 30 | 自动空闲扫描间隔，达到条件后入持久队列 |
| `formation.finalizeIdleMinutes` | 0 | 旧版定时 Finalize 兼容项；0 关闭，显式开启会增加独立触发 |
| `formation.finalizeOnDispose` | false | 旧版释放会话收尾兼容项；默认不因关闭或重启立即收尾 |
| `team.routerEndpoint` / `team.maintainerEndpoint` | 空 | 旧版全局连接的 HTTP(S) 服务，可带路径前缀；新会话按工作配置选择连接 |
| `team.keyEnv` | 空 | 每次请求经 DSH 凭据服务解析引用；无该服务时兼容同名环境变量 |
| `team.timeoutMs` | 15000 | 每次 HTTP 尝试（含响应正文）的总超时 |
| `team.routerTimeoutMs` | 50000 | Router 查询与范围概览的总超时，包含额外重试与等待；连接检查最长 15 秒且不重试 |
| `team.retryCount` | 3 | 首次请求后的重试次数 |
| `team.retryBaseDelayMs` / `team.retryMaxDelayMs` | 500 / 8000 | 指数退避起点与上限，带 ±20% 抖动 |
| `inbox.pullOnSessionStart` | true | 实际启动 / 恢复 Agent 时同步；知识浏览和只读归属检查不触发。打开完整会话可能恢复 Agent；同步失败仍可继续本地工作 |
| `inbox.processingStaleAfterSecs` | 600 | 独立存储租约的过期窗口；独占 worker 接管后可立即回收孤儿租约 |
| `dream.enabled` | true | 是否允许自动与手动 Dream |
| `dream.checkIntervalHours` | 4 | 自动检查间隔小时数 |
| `dream.minIntervalHours` | 24 | 上次成功后的自动冷却小时数 |
| `dream.minChangedClaims` | 5 | 自动运行所需的不同自有变更 Claim 数 |
| `dream.maxModelSteps` | 24 | 每次 Dream 探索请求上限，最多 128；失败重试也计次 |
| `dream.maxWrapUpSteps` | 3 | 探索结束后的额外收尾请求上限，最多 8；耗尽后终结本次 |
| `dream.evidenceCalibration` | false | 启用受限文件查证与自身 medium/low Claim 校准 |
| `dream.evidenceMaxCalls` | 32 | 每个候选组的工具调用总预算，最多 256；失败请求也计次 |
| `dream.evidenceMaxSteps` | 24 | 旧查证适配器的每组模型步数上限，最多 128；当前自主流程使用整次 Dream 额度 |
| `dream.evidenceMaxBytes` | 1048576 | 每组累计文件读取字节预算，最多 16777216；先保留额度再读取 |
| `dream.evidenceMaxChars` | 16000 | 每次读取或搜索返回文本上限，最多 64000；读取仅返回完整行 |
| `dream.evidenceMaxFiles` | 256 | 每组搜索累计检查的目录项预算，最多 4096 |

选择单人配置的会话使用其单人空间，不发团队请求或创建上传项。完全未选择工作配置的会话只进行普通聊天，不访问 ACN 存储。旧版全局 `team` 配置继续服务已有绑定的会话；新配置使用 `upstreams`，通过会话输入框旁的 ACN 菜单选择。以下仅为旧格式兼容示例：

```yaml
- id: acn-knowledge
  config:
    agentId: agent-a
    team:
      routerEndpoint: https://router.example.com/acn
      maintainerEndpoint: https://maintainer.example.com/acn
      keyEnv: ACN_TEAM_CREDENTIAL
```

文件校准可在同一知识行的完整自定义配置中加入 `dream: { evidenceCalibration: true }`。`/dream` 使用命令会话的 cwd；自动任务使用最近普通会话 cwd，缺省为宿主启动 cwd，创建任务后冻结工作区。查证不提供命令执行或联网检索工具；独立证据限于带版本的文件读取。限额写入每组清单，失败、暂停与重启不返还已用额度；修改配置不会扩大原组授权。已经 prepared 的提交仍按固定目标和版本依赖恢复。

可在工作配置中直接输入团队鉴权密钥并保存，也可在启动宿主的环境中提供对应凭据。每次请求重新解析宿主托管值或兼容的环境变量，在插件设置中替换密钥会使用新引用，配置保存成功后才采用；驻留的旧会话实例保留原连接和密钥；重启或释放后重新加载实例时，仍固定原 upstream、Agent ID 和私有快照，但使用该 upstream 当前保存的服务地址与凭据。旧凭据不自动删除，避免影响仍驻留的其他实例。回环地址直连；其他地址遵循 HTTP(S)_PROXY 与 NO_PROXY。两个服务在启用时各做一次异步 health；失败会显示在 `/acn-status`，不会撤销本地知识服务。鉴权错误每次服务生命周期只警告一次。


配置校验要求团队 endpoint 同时为空或同时为 HTTP(S) URL，不接受内嵌用户名、密码、query 或 fragment；`llm.provider`/`model` 必须成对；数值必须处于规定范围。配置错误只报告字段名。

`team.keyEnv` 和 `upstreams.<标识>.keyEnv` 是内部凭据引用，不接受密钥正文。正常使用时在「团队鉴权密钥」直接输入 key，引用由界面自动生成。字段默认掩码显示，右侧按钮切换本次输入的显隐；保存配置时写入 DSH 托管存储，检查连接时只临时使用。已保存密钥只返回可用状态，留空保留原值。旧环境变量引用继续兼容，托管值优先。宿主缺少凭据托管服务时，插件设置无法保存新密钥，仍可临时检查连接或沿用已有引用；其他方式见下节。

### 凭据托管不可用时的高级配置

常规使用时，在插件设置中输入密钥并由 DSH 托管。缺少托管服务或需要通过环境变量提供凭据时，可选择固定引用名，例如 `ACN_TEAM_TOKEN`，在启动 DSH 的进程环境中将它设置为团队管理员提供的密钥，并在该 upstream 的 YAML 中配置相同引用：

```yaml
upstreams:
  coding:
    agentId: coding
    routerEndpoint: https://router.example.org
    maintainerEndpoint: https://maintainer.example.org
    keyEnv: ACN_TEAM_TOKEN
```

密钥正文不写入 YAML。完全退出应用后，从包含该变量的环境启动 DSH；另开终端设置变量不会改变已运行的桌面进程。此方式用于环境变量兼容场景；通过插件设置保存密钥时无需操作环境变量。

### 组件开关

各插件可以按行 id 单独禁用，例如：

```yaml
- id: acn-tools
  disabled: true
```

可分别禁用 `acn-tools`、`acn-prompt`、`acn-formation`、`acn-inbox`、`acn-dream` 和 `acn-commands`。禁用 formation 会撤销 `/recap` 和 `/acn-finalize`，Inbox 仍可运行；禁用 inbox 会撤销 `/inbox`，已有消息和任务保留；禁用 dream 会撤销 `/dream`，中止调用并保留进度，prepared 组先到达安全点。上传投递属于知识服务，禁用 Inbox 或 Dream 不会停止已形成知识的投递。`/acn-status retry` 共用知识服务的 worker。禁用知识行时，其依赖贡献全部撤销。客户端仍在时不阻止普通聊天，并提供插件管理入口；恢复后会自动重读状态，已固定的身份仍不能中途更换。

## 会话压缩与知识复盘

**会话压缩由 DSH 负责**：对话变长时，将较早的聊天内容归纳为摘要，减少模型需要读取的上下文，让当前会话继续工作。压缩策略由 DSH 的会话模式管理；兼容基线的标准模式已经提供压缩功能和 `/compact` 命令，日常使用 ACN 无需额外添加压缩组件。需要调整压缩策略时，参考 [DSH 压缩说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/README.zh.md)。

**知识复盘由 ACN 负责**：从工作对话中提炼值得复用的结论，保存为知识，供后续任务查阅。默认在 DSH 成功产生压缩结果后，ACN 会对尚未处理的对应历史安排复盘；如果本次没有实际压缩，就不会通过这条路径触发复盘。

空闲自动复盘、手动 `/recap` 和 `/acn-finalize` 都可以独立运行，不要求先执行 `/compact`。完整触发条件见[知识形成与失败重试](command-reference.md#知识形成与失败重试)。

所有正整数配置必须是安全整数；`team.retryCount` 与 `formation.finalizeIdleMinutes` 可为 0。证据预算和 review 输入另有表中上限，未知字段拒绝；最大退避不得小于起始退避。模型供应端的凭据由宿主管理，插件不新增密钥配置。

`dream.maxModelSteps` 是探索额度，`dream.maxWrapUpSteps` 是额外收尾额度；默认总计最多 27 次对话模型请求。工具反馈、格式修复及请求重试均计次，先持久记账再发送，崩溃和抢占不返还。收尾禁止扩展探索，保留已提交结果并记录未完成项，然后结束本次。下次 `/dream` 创建新的当前 Claim 快照，不恢复旧草稿。`evidenceMaxSteps` 仅供旧受限查证适配器兼容。

### 工作配置的启用和停用

在「工作配置」列表打开所需配置，在编辑页调整「启用此配置」并保存。停用保留数据与配置标识；启用不会恢复旧字段，当前草稿中的 Agent ID 和团队地址随保存一起生效，也不自动设为全局默认。若要让身份不匹配的旧会话继续，应把 Agent ID 改回该会话原来的值并保存。
