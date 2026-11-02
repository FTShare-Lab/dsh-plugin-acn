# 配置

配置集中在组合中的 `id: acn-knowledge` 行，可通过网页编辑常用字段，也可用 YAML 管理高级参数。

## 网页配置

打开 DSH「设置 → ACN 插件设置」或「插件 → ACN记忆框架」，也可以从聊天框的 **ACN** 菜单进入。三个入口共用同一张表单。

| 页签 | 可以做什么 |
| --- | --- |
| **工作配置** | 创建单人或团队 upstream，查看各自的知识与活动，设置真正用于新会话的全局默认配置。 |
| **知识与模型** | 选择后台模型、结果提示和所有配置的知识根目录。模型检查成功后保存，取消或失败会保留原模型。 |

每份工作配置有自己的 Agent ID 和知识库。新建时只需填写 Agent ID，显示名称可选。单人使用可自取固定名称，例如 `coding`。以后打开这份配置，开启「连接团队服务」并填写 Router、Maintainer 地址及凭据环境变量名，继续使用同一个 Agent ID 和知识库。两项地址必须同时填写或留空。需要部署服务时可参考[原 ACN 仓库](https://github.com/FTShare-Lab/agent-claim-network)。

「检查连接」分别验证两个服务和认证，也可离线保存。凭据只填写环境变量名，模型密钥沿用宿主配置。保存配置不会让正在运行的会话切换客户端；新启动的会话使用保存后的配置。未发送的会话若已启动旧实例，菜单会显示实际模式，并可点击「按已保存配置启动」。新运行实例恢复旧会话时仍选择原 upstream 和 Agent ID，并保留原知识目录与 Memory 快照。

新会话优先沿用同项目最近新建的普通会话所选 upstream。读取按创建时间排序，不按最近聊天或查看时间；内部子代理不参与，目录的符号链接别名视为同一项目。最近配置失效或归属无法确认时回退到全局默认；全局默认也为空时，需在 ACN 菜单明确选择。首发前可以改选，首发后归属固定；派生会话继续继承父归属。已有会话和草稿不因新会话的选择而改绑。

此预选直接读取宿主的公开会话记录，不保存项目默认选项，不恢复历史 Agent，也不因读取历史调用模型或同步团队。项目目录只用来确定会话属于哪个项目，不决定知识位置。

团队启动、实际恢复或手动同步会处理 Inbox。连接、鉴权或内化失败会保留归属并提示原因，允许继续本地工作。单人不发团队请求，仍可通过 `/inbox` 处理已落盘的本地 pending。浏览知识和历史不会同步或调用模型。结果通过聊天框外的提示展示，避免改变输入框尺寸。

新知识库位于 `<home>/<upstream>/data/agents/<agentId>/`。不同 upstream 即使 Agent ID 相同，本地知识也分开；同一 upstream 的多个项目会话共用知识。两个相同 Agent ID 连接同一团队时，在通过鉴权后对应同一个远端成员。当前 upstream 的 `ACN.md` 在创建会话时冻结，旧会话恢复继续使用原快照。

### 已有配置升级

旧配置仍可读取。第一次在工作配置页保存时，会保留原配置备份 `upstream-migration-v1.yaml`，将原单人入口、旧全局团队和具名连接映射为 upstream。备份和原数据都在知识根目录，迁移不搬动实体文件，也不按相同 Agent ID 合并知识库。旧具名连接的大小写标识保留为内部目录映射，旧会话仍按持久身份找到原数据。原「默认团队候选」不会自动升级为默认入队。

旧个人目录 `<home>/agents/<agentId>/`、旧团队入口和 `<home>/connections/<连接ID>/agents/<agentId>/` 继续使用原路径。网页不允许修改内部迁移映射。修改显示名称不改变目录；修改 Agent ID 或知识根会选择另一份存储，旧数据保留，旧会话需恢复原身份后继续。停用也保留数据，可恢复。

### 接入团队与更换地址

单人期间不积累上传任务，历史 Claim 在接入后仍可本地使用，不会整库补传。已处于团队模式的 upstream 更换地址会沿用知识与上传队列，原待投记录没有固定旧服务器地址。新配置启动后，仍符合重试条件的记录可能发送到新 Maintainer。页面显示当前待投数量并说明影响；需要隔离团队时新建 upstream。

「重新加载已保存配置」将丢弃未保存的修改。模型或偏好单独保存，不会提交正在编辑的工作配置草稿。保存使用宿主的版本校验和原子配置编辑器，其他窗口有修改时保留当前草稿并提示重新读取。有 Agent 正在运行时，先结束当前轮次再保存。

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
    memory:
      enabled: true
      memoryCharLimit: 1600
      userCharLimit: 1000
      safetyScan: true
      review:
        enabled: true
        intervalTurns: 10
        maxTranscriptChars: 32000
```

按 id 覆盖会整体替换该行的 config，所以每次覆盖都需包含希望保留的自定义项。未填写的字段由插件补默认值。

旧入口的 `agentId` 只能含小写字母、数字、下划线和连字符。未配置 `upstreams` 且该字段为空时，插件保持未配置状态：只有 ACN 的 `/acn-status`，不注册 Claim 工具与知识段落，不访问知识磁盘。`home` 支持 `~`，实际目录为 `<home>/agents/<agentId>/`，与工作区 cwd 无关。

当前可用的行为配置：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `agentId` | 空 | 旧入口的知识 holder；配置 `upstreams` 后由所选项确定 |
| `home` | `~/.acn-dsh` | 独立数据根目录 |
| `sessionEpoch` | 0 | 网页切换身份或目录时自动保存的会话时间边界，不应手动清零 |
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
| `team.routerEndpoint` / `team.maintainerEndpoint` | 空 | 旧版全局连接的 HTTP(S) 服务，可带路径前缀；网页新会话仍默认单人 |
| `team.keyEnv` | 空 | 每次请求从该环境变量读取团队凭据 |
| `team.timeoutMs` | 15000 | 每次 HTTP 尝试（含响应正文）的总超时 |
| `team.retryCount` | 3 | 首次请求后的重试次数 |
| `team.retryBaseDelayMs` / `team.retryMaxDelayMs` | 500 / 8000 | 指数退避起点与上限，带 ±20% 抖动 |
| `inbox.pullOnSessionStart` | true | 实际启动 / 继续工作时后台同步；只打开历史不触发。同步失败时提示原因并继续本地工作 |
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
| `memory.enabled` | true | 注册私有 Memory 工具、冻结段落和 review；关闭保留文件 |
| `memory.memoryCharLimit` / `memory.userCharLimit` | 1600 / 1000 | 与当前 ACN 默认容量一致；规范化后 Unicode 字符数，包含条目分隔符 |
| `memory.safetyScan` | true | 扫描 add / replace 新内容的不可见字符和危险模式；不阻止删除旧内容 |
| `memory.review.enabled` | true | 是否注册持久 Memory 复核处理器 |
| `memory.review.intervalTurns` | 10 | 每 N 个完成的人工用户 turn 复核最近 N 个 turn |
| `memory.review.maxTranscriptChars` | 32000 | 私有复核投影的总字符上限，最多 128000；截断显式标记 |

未选择团队的会话使用单人空间，不发团队请求或创建上传项。旧版全局 `team` 配置继续服务已有会话；新配置使用 `upstreams`，在网页按会话选择。以下仅为旧格式兼容示例：

```yaml
- id: acn-knowledge
  config:
    agentId: agent-a
    team:
      routerEndpoint: https://router.example.com/acn
      maintainerEndpoint: https://maintainer.example.com/acn
      keyEnv: ACN_TEAM_CREDENTIAL
```

文件校准可在同一知识行的完整自定义配置中加入 `dream: { evidenceCalibration: true }`。`/dream` 使用命令会话的 cwd；自动任务使用最近普通会话 cwd，缺省为宿主启动 cwd，创建任务后冻结工作区。查证不提供命令或 Web 工具；独立证据限于带版本的文件读取。限额写入每组清单，失败、暂停与重启不返还已用额度；修改配置不会扩大原组授权。已经 prepared 的提交仍按固定目标和版本依赖恢复。

在启动宿主的环境中提供对应凭据。每次请求读取环境变量，轮换后无需重建客户端。回环地址直连；其他地址遵循 HTTP(S)_PROXY 与 NO_PROXY。两个服务在启用时各做一次异步 health；失败会显示在 `/acn-status`，不会撤销本地知识服务。鉴权错误每次服务生命周期只警告一次。

Memory review 使用自身会话路由，或显式 `llm.provider` / `llm.model`，不会借用其他会话的路由。关闭 review 保留已排队任务，重新启用后继续。关闭 Memory 或单独禁用其行都会撤销工具、快照和 review；知识行仍保护普通文件工具访问私有 Agent 数据。已持久化的双文件事务会在知识服务启动时恢复。

配置校验要求团队 endpoint 同时为空或同时为 HTTP(S) URL，不接受内嵌用户名、密码、query 或 fragment；`llm.provider`/`model` 必须成对；数值必须处于规定范围。配置错误只报告字段名。

团队凭据只允许配置环境变量名 `team.keyEnv`，不接受密钥正文。各插件可以按行 id 单独禁用，例如：

```yaml
- id: acn-tools
  disabled: true
```

可分别禁用 `acn-tools`、`acn-prompt`、`acn-formation`、`acn-inbox`、`acn-dream`、`acn-memory` 和 `acn-commands`。禁用 formation 会撤销 `/recap` 和 `/acn-finalize`，Inbox 仍可运行；禁用 inbox 会撤销 `/inbox`，已有消息和任务保留；禁用 dream 会撤销 `/dream`，中止调用并保留进度，prepared 组先到达安全点。Memory 独立于 Claim 工具、知识提示词及 formation，禁用这些行仍可使用 Memory。上传投递属于知识服务，禁用 Inbox、Dream 或 Memory 不会停止已形成知识的投递。`/acn-status retry` 共用知识服务的 worker。禁用知识行时，其依赖贡献全部撤销。

## 宿主压缩与 Recap

DSH `0.2.1-rc.2` 的 Web 模板默认关闭压缩插件。需要 `/compact` 和压缩后自动 Recap 时，在同一个 profile patch 加入：

```yaml
- id: compaction-basic
  disabled: false
  config:
    auto: false
    retainTokens: 0
    headroomTokens: 4096
    maxTokens: 4096
- id: command-compact
  disabled: false
```

这是宿主配置，不属于 `acn-knowledge.config`。示例选择手动压缩且不保留旧区间，便于观察 Recap；日常使用可按宿主说明配置保留窗口和自动阈值。压缩使用宿主模型；成功产生压缩结果才触发 Recap。没有需要压缩的区间或摘要没有缩小上下文时，宿主可能不产生压缩，不能据此认定 Recap 已执行。`/recap` 和 `/acn-finalize` 可独立使用。

所有正整数配置必须是安全整数；`team.retryCount` 与 `formation.finalizeIdleMinutes` 可为 0。证据预算和 review 输入另有表中上限，未知字段拒绝；最大退避不得小于起始退避。模型供应端的凭据由宿主管理，插件不新增密钥配置。

`dream.maxModelSteps` 是探索额度，`dream.maxWrapUpSteps` 是额外收尾额度；默认总计最多 27 次对话模型请求。工具反馈、格式修复及请求重试均计次，先持久记账再发送，崩溃和抢占不返还。收尾禁止扩展探索，保留已提交结果并记录未完成项，然后结束本次。下次 `/dream` 创建新的当前 Claim 快照，不恢复旧草稿。`evidenceMaxSteps` 仅供旧受限查证适配器兼容。
