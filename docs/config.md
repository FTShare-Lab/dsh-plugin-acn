# 配置

配置集中在组合中的 `id: acn-knowledge` 行，可通过网页编辑常用字段，也可用 YAML 管理高级参数。

## 网页配置

安装后进入「插件 → ACN记忆框架」，在插件详情页填写并保存：

| 网页字段 | 持久配置 | 说明 |
| --- | --- | --- |
| Agent ID | `agentId` | 小写字母、数字、下划线或连字符；个人模式可自取固定名称，团队成员须用唯一且与服务授权匹配的 ID |
| 知识目录 | `home` | 主机路径，实际目录为 `<home>/agents/<agentId>/` |
| ACN 后台模型 | `llm.provider` / `llm.model` | 从宿主已注册模型中选择，或沿用会话模型 |
| 运行模式 | 两个 endpoint | 单人模式保存时清空团队地址和认证引用 |
| Router / Maintainer 地址 | `team.routerEndpoint` / `team.maintainerEndpoint` | 团队模式必须同时填写 |
| 团队认证环境变量名 | `team.keyEnv` | 只填变量名；值由启动 DSH 的环境提供，不在本页录入或回显 |
| 团队请求超时 | `team.timeoutMs` | 正整数毫秒；模型处理较慢时应增加，例如 180000 |

如宿主已配置 `deepseek-v4-flash-api`，直接从列表选择即可。此选项覆盖 Recap、Finalize、Inbox、Dream 与 Memory review 的后台路由；聊天模型仍使用会话自己的选择器。列表没有所需模型时，先在 DSH 的模型设置中配置，再点击「重新加载已保存配置」。

页面顶部固定显示保存栏。修改字段后会提示“有未保存的更改”，只有点击「保存并应用」才生效；成功、冲突或失败结果也显示在保存栏中。「重新加载已保存配置」旁明确提示“将丢弃未保存的修改”，点击后丢弃当前草稿，恢复已保存值。

个人模式下，Agent ID 可自取任意符合格式的固定名称，例如 `personal`。它仍用于区分本地存储：同一知识目录与 ID 下，不同项目和会话共用知识与私有记忆，不会随项目自动分配 ID。设定后建议保持不变；需要隔离时使用独立配置及不同 ID 或目录。团队模式下，ID 还用于标识知识归属，须与服务授权一致且避免成员重名。

「保存并应用」通过宿主配置编辑器写入当前 profile 的 `cordis.patch.yml`，保留未展示的高级字段和其他插件配置，并等待知识服务及依赖组件完成重载。不是将存储配置标成可热更新后直接改值。保存后新建会话；旧会话已有目录与 Memory 快照不会被改写。修改 `agentId` / `home` 只切换存储，不搬迁、不删除旧数据。

多窗口并发保存或文件外部修改时，版本不一致会拒绝覆盖，页面保留草稿。请先重新加载，核对后再提交。非法路径、单边团队地址、模型失效和参数错误均拒绝保存。如果连接中断，页面会明确提示无法确认结果，应先重读；宿主文件权限或更高优先级覆盖导致保存失败时，检查宿主状态后重试。单独禁用知识行时请先在插件管理器启用该行再保存。

保存时若还有 Agent 正在执行，页面会要求先结束当前轮次；应用期间也禁止新的模型步骤和 ACN 工具/命令进入。存活会话保留首次所属存储绑定；外部配置引发的预重载也不能让它改绑。发生外部身份冲突时会保留外部字段并补写会话时间边界，页面仍返回冲突，当前草稿不生效。修改身份或目录会自动记录 `sessionEpoch`，旧会话及来源无法验证的历史派生会话不能访问新身份的数据，恢复旧会话也不会绕过此限制；请新建会话。只改模型或团队连接时，存活会话沿用已有的冻结 Claim 目录与私有 Memory，下一次模型调用才使用新配置。原目录的数据不会迁移或删除。

身份绑定还随宿主会话日志持久化；停止 DSH 后修改 YAML 中的身份或目录，再重启，也必须新建会话。升级前没有身份绑定记录的历史会话无法确认归属，启用 ACN 后会提示新建会话，不会删除历史或知识。全新子会话可以继承已验证父会话的身份；未配置 Agent ID 时不会阻止宿主原有会话运行。

## YAML 与完整字段

需要高级配置时，在 profile 的 `cordis.patch.yml` 加入以下覆盖项，并重新启动 profile：

<!-- config:complete -->
```yaml
- id: acn-knowledge
  config:
    agentId: agent-a
    home: ~/.acn-dsh
    sessionEpoch: 0
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
      maxClaims: 200
      maxChars: 24000
    formation:
      recapOnCompaction: true
      finalizeIdleMinutes: 30
      finalizeOnDispose: true
    inbox:
      pullOnSessionStart: true
      processingStaleAfterSecs: 600
    dream:
      enabled: true
      minIntervalHours: 24
      minChangedClaims: 5
      checkIntervalHours: 4
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
| `catalog.maxClaims` | 200 | 冻结目录条数上限 |
| `catalog.maxChars` | 24000 | 目录的 Unicode 字符上限 |
| `llm.provider` / `llm.model` | 空 | 指定后台路由；为空时形成用本会话路由，Inbox / Dream 用持久的最近任意会话路由 |
| `llm.maxOutputTokens` | 32768 | 后台模型输出 token 上限；显式配置优先于默认值 |
| `llm.timeoutMs` | 600000 | 每次后台传输调用超时毫秒数 |
| `llm.structuredRetries` | 5 | 结构和引用校验的最大模型响应次数 |
| `formation.recapOnCompaction` | true | 压缩后入队 Recap |
| `formation.finalizeIdleMinutes` | 30 | 空闲 Finalize 分钟数；0 禁用空闲触发 |
| `formation.finalizeOnDispose` | true | 会话关闭时入队 Finalize |
| `team.routerEndpoint` / `team.maintainerEndpoint` | 空 | 成对配置团队 HTTP(S) 服务，可带路径前缀 |
| `team.keyEnv` | 空 | 每次请求从该环境变量读取团队凭据 |
| `team.timeoutMs` | 15000 | 每次 HTTP 尝试（含响应正文）的总超时 |
| `team.retryCount` | 3 | 首次请求后的重试次数 |
| `team.retryBaseDelayMs` / `team.retryMaxDelayMs` | 500 / 8000 | 指数退避起点与上限，带 ±20% 抖动 |
| `inbox.pullOnSessionStart` | true | startup / resume 时排队同步与内化 |
| `inbox.processingStaleAfterSecs` | 600 | 独立存储租约的过期窗口；独占 worker 接管后可立即回收孤儿租约 |
| `dream.enabled` | true | 是否允许自动与手动 Dream |
| `dream.checkIntervalHours` | 4 | 自动检查间隔小时数 |
| `dream.minIntervalHours` | 24 | 上次成功后的自动冷却小时数 |
| `dream.minChangedClaims` | 5 | 自动运行所需的不同自有变更 Claim 数 |
| `dream.evidenceCalibration` | false | 启用受限文件查证与自身 medium/low Claim 校准 |
| `dream.evidenceMaxCalls` | 32 | 每个候选组的工具调用总预算，最多 256；失败请求也计次 |
| `dream.evidenceMaxSteps` | 24 | 每组查证模型步数，最多 128；重启不会返还已用步数 |
| `dream.evidenceMaxBytes` | 1048576 | 每组累计文件读取字节预算，最多 16777216；先保留额度再读取 |
| `dream.evidenceMaxChars` | 16000 | 每次读取或搜索返回文本上限，最多 64000；读取仅返回完整行 |
| `dream.evidenceMaxFiles` | 256 | 每组搜索累计检查的目录项预算，最多 4096 |
| `memory.enabled` | true | 注册私有 Memory 工具、冻结段落和 review；关闭保留文件 |
| `memory.memoryCharLimit` / `memory.userCharLimit` | 1600 / 1000 | 与当前 ACN 默认容量一致；规范化后 Unicode 字符数，包含条目分隔符 |
| `memory.safetyScan` | true | 扫描 add / replace 新内容的不可见字符和危险模式；不阻止删除旧内容 |
| `memory.review.enabled` | true | 是否注册持久 Memory 复核处理器 |
| `memory.review.intervalTurns` | 10 | 每 N 个完成的人工用户 turn 复核最近 N 个 turn |
| `memory.review.maxTranscriptChars` | 32000 | 私有复核投影的总字符上限，最多 128000；截断显式标记 |

两个团队 endpoint 均为空时为单人模式。单人模式没有团队网络请求、上传队列或编辑补传记录。团队配置示例：

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

可分别禁用 `acn-tools`、`acn-prompt`、`acn-formation`、`acn-inbox`、`acn-dream`、`acn-memory` 和 `acn-commands`。禁用 formation 会撤销 `/acn-finalize`，Inbox 仍可运行；禁用 inbox 会撤销 `/inbox`，已有消息和任务保留；禁用 dream 会撤销 `/dream`，中止调用并保留进度，prepared 组先到达安全点。Memory 独立于 Claim 工具、知识提示词及 formation，禁用这些行仍可使用 Memory。上传投递属于知识服务，禁用 Inbox、Dream 或 Memory 不会停止已形成知识的投递。`/acn-status retry` 共用知识服务的 worker。禁用知识行时，其依赖贡献全部撤销。

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

这是宿主配置，不属于 `acn-knowledge.config`。示例选择手动压缩且不保留旧区间，便于观察 Recap；日常使用可按宿主说明配置保留窗口和自动阈值。压缩使用宿主模型；成功产生压缩结果才触发 Recap。没有需要压缩的区间或摘要没有缩小上下文时，宿主可能不产生压缩，不能据此认定 Recap 已执行。`/acn-finalize` 可独立使用。

所有正整数配置必须是安全整数；`team.retryCount` 与 `formation.finalizeIdleMinutes` 可为 0。证据预算和 review 输入另有表中上限，未知字段拒绝；最大退避不得小于起始退避。模型供应端的凭据由宿主管理，插件不新增密钥配置。
