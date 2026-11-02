# 配置

配置集中在组合中的 `id: acn-knowledge` 行，可通过网页编辑常用字段，也可用 YAML 管理高级参数。

## 网页配置

打开 DSH「设置 → ACN 插件设置」或「插件 → ACN记忆框架」。也可以在聊天框的 **ACN** 菜单中打开设置。三个入口共用同一张表单，默认显示「单人设置」。

| 页签 | 可以做什么 |
| --- | --- |
| **单人设置** | 设置个人 Agent ID、知识目录，然后点击「保存并应用」。个人模式可自取固定名称，如 `personal`；同一身份下的不同项目共享知识与私有记忆。 |
| **团队连接** | 添加或编辑成员、Router、Maintainer、认证环境变量名和超时。「检查连接」验证服务和认证，也可先离线保存。默认候选只在会话菜单中标注，不会自动加入团队。 |
| **知识与模型** | 选择后台模型、开关来源会话的结果提示，或进入「知识与活动」。指定模型探测成功才保存；失败或取消后仍用原模型。 |

「重新加载已保存配置」会丢弃未保存的修改，不会触发同步或删除数据。模型和偏好单独保存，不会顺便提交尚未保存的身份或连接草稿。

新会话默认使用单人模式。在首发前从聊天框的 ACN 菜单选择连接，插件先同步收件、完成本地内化并冻结知识基线；失败时保留选择和输入，提供重试、取消等待及设置入口。首发后归属固定，不能切换到其他连接。单人模式没有「同步收件」。团队同步的结果短暂显示在聊天框外；如需处理，重新打开 ACN 菜单即可查看原因、重试或取消等待。没有收件、内化、投递或警告的空同步仍有活动记录，不会再弹一次后台结果。恢复旧团队会话保留原基线，实际继续工作时才排队后台同步。

个人知识仍位于 `<home>/agents/<agentId>/`；新团队连接的知识与私有 Memory 位于 `<home>/connections/<连接ID>/agents/<成员ID>/`，不同连接彼此隔离。旧版 `team` 配置显示为「原有团队连接」，原数据不搬迁；此时新增个人空间位于 `<home>/personal/agents/<agentId>/`。旧会话保留原身份；网页新会话不会自动接入旧团队连接。

知识与活动页面只读公开知识及任务摘要，不展示 `MEMORY.md` / `USER.md`。浏览不会启动同步、后台模型或 Dream。停用连接仍可浏览保留数据，但不能同步和重试；恢复原连接后旧会话可继续。删除连接保留磁盘数据，恢复旧会话需要恢复原连接 ID 和身份配置。

网页保存通过宿主配置编辑器写入当前 profile 的 `cordis.patch.yml`，保留高级字段及其他插件配置，并等待依赖组件重载。修改 Agent ID 或知识目录只切换存储，不迁移、不删除数据；身份不再匹配的旧会话会被阻止。保存时若有 Agent 正在执行，应先结束当前轮次。

多窗口或外部文件变更会通过版本校验拒绝覆盖，页面保留草稿。连接中断时应先重读确认结果，再重试保存。认证字段只接受环境变量名，模型密钥沿用宿主配置，不另行保存在插件中。

## YAML 与完整字段

需要高级配置时，在 profile 的 `cordis.patch.yml` 加入以下覆盖项，并重新启动 profile：

<!-- config:complete -->
```yaml
- id: acn-knowledge
  config:
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

`agentId` 只能含小写字母、数字、下划线和连字符。为空时插件保持未配置状态：只有 ACN 的 `/acn-status`，不注册 Claim 工具与知识段落，不访问知识磁盘。`home` 支持 `~`，实际目录为 `<home>/agents/<agentId>/`，与工作区 cwd 无关。

当前可用的行为配置：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `agentId` | 空 | 当前知识 holder |
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
| `inbox.pullOnSessionStart` | true | 实际启动 / 继续工作时后台同步；只打开历史不触发。显式首次选择始终等待准备完成 |
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

未选择团队的会话使用单人空间，不发团队请求或创建上传项。旧版全局 `team` 配置继续服务已有会话；新配置建议使用 `connections` 并在网页按会话选择。旧格式示例：

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
