# DSH 兼容记录

## M0 基线（2026-10-21）

| 项目 | 已核对值 |
| --- | --- |
| DSH CLI | `0.2.1-rc.2` |
| 上游源码 | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Cordis | `@deepseek-ai/cordis@4.0.5` |
| Loader / Include | `@deepseek-ai/cordis-plugin-loader@1.0.6` / `@deepseek-ai/cordis-plugin-include@1.0.10` |
| 配置 schema 包 | `@deepseek-ai/schemastery@3.18.5` |
| commands | `@deepseek-ai/dsh-commands@0.2.1-rc.2`，对应上游 `packages/interaction/commands` |
| credentials | `@deepseek-ai/dsh-credentials@0.2.1-rc.2`，对应上游 `packages/credentials/credentials` |
| 测试支持包 | `dsh-loader-smoke`、`dsh-agent-loop-testkit`、`dsh-llm-mock-server` 均固定为 `0.2.1-rc.2` |

包名均已对照对应 `package.json` 并从 npm 安装。宿主 peer 也作为同版本 devDependency 声明；当前精确 DSH peer 版本可以正常安装，无需放宽。工程使用 pnpm `11.25.0`；依赖安装允许 `esbuild`、`koffi`、真实搜索测试所需 `node-pty` 和 `dsh-subprocess-local` 的安装脚本。

## 已实测接口

- bundle manifest 使用 `dsh.bundle.patch`；`engines.dsh` 设置为 `>=0.2.1-rc.2 <0.3.0`。本轮实际验证的运行时为 `0.2.1-rc.2`。
- `dsh --profile <name> --from-default-profile web --dump-config` 可以创建 Web profile 并只输出组合配置，不启动 Web 服务。
- `dsh plugin --profile <name> add <absolute-tarball-path>` 可以安装预构建 tarball。未提前创建 profile 时会使用 base 模板，所以 Web 验收显式先创建 Web profile。
- `dsh --profile <name> --dump-config` 是有效命令；输出包含 `!!js`，离线检查必须声明该 YAML tag，并保持表达式不执行。
- `cordis:group` 支持 `isolate: { acnKnowledge: true }`；知识行可激活，服务在同组上下文可见，根上下文不可见。按 id 禁用知识行后不发布服务，卸载后撤销服务。
- 插件日志 API 是 `ctx.logger.info(...)`。测试用 `ctx.logger.exporter(...)` 捕获激活日志。
- `defineTool` 支持无参数工具及字符串规范输出；临时工具通过真实 Web 会话执行并返回 `pong`，随后已从源码删除。
- npm 声明中的 `FiberState` 是 const enum，发布 JS 没有同名导出。原生 Node 测试 host 使用类型导入，并按上游 driver 使用的 ACTIVE 值 `2` 检查状态，保持 `verbatimModuleSyntax` 开启。

## 工程适配

构建使用 tsdown 生成 ESM，再由 TypeScript 生成 `lib/types/` 声明。M0 导出默认入口、`./knowledge`、patch 和 manifest；M1 新增 `./protocol` 与 `./store`；M2 新增 `./prompt`、`./tools`、`./commands` 和模板。安装脚本从实际安装位置导入公开入口。

运行时导入约束只应用于 `src/` 产品代码；测试 host 需要直接导入 Loader 和宿主测试包。M0 的知识服务仅用于验证生命周期与隔离，对外没有领域方法、配置解析或持久化。

## M2 事件与工具实测（2026-10-21）

- `tests/flow/pre-step.test.ts`：pre-step 开始前，Inbox 消息已被 claim。监听器内调用 `agent.inject()` 不进入当前请求，下一步骤才可见；即使模型已结束回答，待处理注入还会引发一个额外请求。
- pre-step waterfall 返回值可追加 `messages`，追加消息进入当前获准步骤，并以公开的 `user/message` 持久化。实现保留原 decision 的其余字段，不提前写通知游标。请求拒绝或取消时，尚未准入的提示可在下次步骤重试。
- 通过 `session/event` 观测真正准入的消息，再更新插件本地游标；真实 JSONL 会话 dispose/resume 测试验证目录保持一致，已准入版本不重复追加。没有使用已弃用的同步历史读取或第三方无权调用的 plugin record。
- `AssembleContext.agent` 可读取 `agent.session.id`。测试通过 `assembleContextFor(agent)` 组装；Loader host 也验证全局贡献通过 agent 上下文取得冻结目录。
- 内置段落 order 为 persona prefix `0`、policy `500/600`、PTC `800`、文件引用 `900`、首个工具说明 `1000` 起。知识说明与目录使用 `700/710`，处于 persona 之后、工具说明之前，且 `interpolate:false` 保留数据中的模板样式字符。
- `defineTool` 的隐式参数根对象开放，无法直接表达动作专属顶层联合。插件保留 `defineTool` 的规范输出/执行包装器，替换其模型参数投影为 zod 的顶层 `oneOf`；每个分支 `additionalProperties:false`，领域层再次严格校验。Zod 的非枚举 `~standard` 元数据会导致宿主的 lossless JSON 检查失败，因此投影先经过纯 JSON 归一化；真实 Loader 和 HTTP 模型请求已覆盖此边界。
- `tools/pre-execute` 支持 deny，最终 `tools.guard` 是单调拒绝。子代理身份从受保护的 SessionHeader 读取，origin 或 delegationDepth 任一标记触发写入门禁，read 放行。
- commands 注册与卸载均由插件 fiber 管理。真实 registry 的命令执行、状态命令未配置提示、工具/段落/命令各行禁用和卸载撤销均有测试。
- 安装目录缺少宿主 peer 的物理副本时，普通 Node 导入或只调用底层 `boot()` 都不代表 CLI 环境。安装验收按 CLI 的链路先调用 `createRuntimeResolution` 并挂载 `PluginPackages`，再加载实际安装的 bundle；断言选中的是 profile 内的物理包，并验证 Claim list、模板与状态命令。保持宿主 peer 的共享实例约定。
- `dsh-agent-loop-testkit` 负责依赖和生产 loop，不提供模型；脚本 adapter 验证多步工具流，`dsh-llm-mock-server` 加真实 Messages HTTP adapter 验证 list/read/update 与 tool_result 回传。

模板使用内存 Loader；文件在激活时异步读取。Nunjucks 默认保留末尾换行，参考引擎默认去掉每个模板的一次末尾换行，实现对此显式对齐，五组参考快照逐字一致。

受限探索子代理已在 M6 验证；M7 已验证普通会话文件工具对私有 Agent 数据的路径保护，范围见文末。


## M3 形成接口实测（2026-10-22）

- 后台调用使用 `llm.prepareCall({provider,model,maxTokens}, signal)` 后的固定 call.config 与 stream，标准 BlockAssembler 组装；不设置只接受内置值的 purpose。生产 AgentLoop、真实 Messages adapter 和回环 mock server 均通过。
- GenerateOptions 有 tools 声明，没有 responseFormat 或强制 tool choice。工具 schema 无法保证模型必须调用，因此采用 JSON schema system 指令、严格 zod / 语义校验及反馈重试；拒绝工具调用、附件、截断输出。没有调用宿主私有能力。
- `request/header.data.header.config` 提供实际 provider/model。监听时把当前会话路由持久化；会话任务不使用其他会话的 last_route。全局路由文件仅供后续无会话任务使用。
- `session/event` 是 emit，不能靠返回 Promise 阻塞宿主。适配器同步投影，形成服务串行排队持久化；命令、后台任务、dispose 清理等待此前事件写入。不回读已弃用的同步历史，也不调用受限 plugin record。
- 压缩 summary 的 shadowedRange 是 surface 顺序，重复压缩后 start 可能大于 end。实现取 shadowedSeqs 与 end 的数值最大值，避免遗漏旧 range 中较新的事件；相邻的 surface replace user/message 不作为新证据再记录。
- 状态 idle 启动计时，running 取消；用可控时钟验证到期触发及 Recap / idle / dispose 重叠去重。子代理 SessionHeader 门禁同时覆盖事件投影、Finalize 与 retry。
- Cordis 4 的 inject 对象是服务名到拦截配置的映射，不是 required/optional 结构。基础命令始终依赖知识服务和 commands；Finalize 通过子级 ctx.inject 动态依赖 acnFormation，启停会自动注册 / 撤销。ctx.get 用于 retry 的可选服务查询。
- HTTP 500/503 实际归一为 SERVER，连接失败归一为 TRANSPORT；分类处理宿主稳定 code，并保留流内 failure.status。真实 HTTP 测试覆盖 500/503 后的成功重试，而非只依赖自定义错误样本。
- bundle 新增 `./formation` 插件与 `./formation-core` 无宿主核心入口，服务在 group 内隔离。真实 tarball 安装后调用普通会话与 `/acn-finalize`，得到一个 Claim 和一个 Trace；formation 单行禁用和卸载均验证。

新增 session_recap 模板由同一参考 PromptRegistry 生成快照，再与 Nunjucks 逐字比较。当前共六组模板快照；只适配 JSON 提交方式，并保持知识质量、隐私和引用纪律。

## M4 团队模式实测（2026-10-22）

- 知识服务拥有一个共享 worker；Formation 和 Inbox 仅注册各自任务处理器。停用 Formation 时 Inbox 可独立使用宿主 llm；停用 Inbox 时撤销 `/inbox` 并保留消息/任务。`/acn-status retry` 直接使用知识 worker。
- Inbox 监听公开 `agent/created` 的 startup/resume 及 `session/event` 的 request/header。事件异步写入受管理串行队列，无会话任务从 runtime/last_route 取最近路由；形成任务保持自身会话路由边界。
- 团队工具通过实际 DSL schema、生产 tools 执行器和 AgentLoop 验证；领域失败是规范值。候选正文与来源记录完整，retrieval_debug 不提交给模型。scope 概览进入冻结目录，与本地目录共用字符预算。
- Inbox 完成走知识服务的统一版本和变化通知，后续获准请求准入一条累计变化消息。命令/后台输出不写普通模型历史，私有双文件不参与内化。
- bundle 为六行，隔离 acnKnowledge/acnFormation/acnInbox；公开 inbox/team/upload 核心入口不要求宿主运行时。九个 Loader 场景与实际 tarball 安装都通过。安装包执行普通请求、Finalize、本地 Inbox，得到 2 Claim / 2 Trace 和 done 标记。

## M5 Dream 宿主适配（2026-10-22）

- bundle 增加 acn-dream，七行组合隔离 acnDream；公开 dream-core 不加载宿主运行时，类型和两个模板随包发布。
- 所有非子会话的 agent/created 触发资格检查；插件激活与四小时计时器同样检查。request/header 只保存 provider/model，后台调用等待路由写入完成，不写普通对话历史。
- /dream、/dream stop 通过动态依赖注册；禁用 Dream 行撤销命令和处理器，取消外部调用，prepared 组先收敛，任务与草稿保留。子会话不能触发或停止。
- 使用宿主 prepareCall、BlockAssembler、独立结构化 schema 与无工具请求。模型原文、草稿和验证保存在 Dream 私有记录中；普通会话仅在下一获准步骤收到知识身份变化提示。
- 未采用宿主子 agent，选择自管阶段与有界摘要。两个 Dream 模板由参考 PromptRegistry 渲染插件适配文本，连同原有模板共 10 份逐字比较；不宣称与源端完整 Dream 工具提示词相同。
- 新增两个 Inbox 模板后共八组 Rust/Nunjucks 快照；模型 transport 沿用 M3 的统一适配，未新增专用 provider 请求通道。

## M6 受限子会话实测（2026-10-22）

- agents.create 的异步 setup 在 Session/Agent 发布前完成，允许安装 scoped 工具、restrict、guard、完整系统段和事件监听。origin=subagent 的新会话不继承普通历史；创建方持有 handle 并在取消或正常结束时 dispose，等待 loop 排空。
- restrict({allow:[]}) 清除继承工具，但不能限制同作用域新增工具，保留的 PTC transport 也不能靠名称 restrict。因此查证强制 presentAs('native')，注册插件自有 read/grep/glob/只读 claim，并由最终单调 guard 对名称及动作严格校验。真实调用验证全局工具、后加 scoped 工具、run_code 和 Claim update 都被拒绝，即使 pre-execute 策略返回 allow。
- complete 系统段在 assembly waterfall 后恢复；interpolate=false 避免数据插值。suppressRuntimeContext 仅去掉可选项；refreshContext 会恢复 required 项。子作用域以相同 context 名注册空贡献，并清空 assembly contexts/variables，实际模型请求中没有环境私有标记。普通 Claim 目录和变化提示也跳过查证会话。
- 真实子循环验证 read 回执、native/PTC 主环境、并发不同 cwd、参数被 pre-execute 改写后仍做路径校验、步数预算、超时、停止和 dispose；没有用模型自述代替工具执行结果。校准使用与后台相同的 provider/model 路由和输出/超时上限。
- bundle 的真实安装验证新增启用校准场景：从安装目录加载 evidence 核心及模板，创建受限子会话读取临时工作区，在文件新证据支持下修订 medium Claim，得到 2 Claim / 4 Trace / done / Dream report。默认关闭场景继续通过。

## M7 Memory 宿主实测（2026-10-22）

- 八行 bundle 新增 acn-memory，隔离 acnMemory，公开 memory-core 无宿主运行时依赖。14 个真实 Loader 场景覆盖单行禁用、Memory 配置关闭、卸载和完整流程；安装包额外执行实际 Memory 工具、新会话快照和后台 review。
- agent/created 的 serial 准备写入持久冻结 state，acn:memory 以 order 720、interpolate=false 读取同步缓存。真实 AgentLoop 验证当前会话不刷新、新会话读取新值、持久 resume 使用旧值；领域测试覆盖 clear/compact/fork 与并发恢复。
- 基线 fs 只提供 fs/write-intent、fs/edit-intent 和 fs/observed，没有读取前事件。普通文件路径保护使用已有工具 pre-execute 和最终单调 guard，另监听两个写意图事件；不虚构 fs/read hook。
- 工具执行参数在宿主创建执行对象时已 deep-freeze，不能原地改写。保护层记录本次执行的参数指纹和真实 cwd，在最终 guard 检查。正常 ask 决策先检查路径，审批后的 cwd 变化仍拒绝；短路 allow 不能绕过未完成的检查。
- 文件工具通过公开 fs.resolve/contains/processPath 映射检查 canonical 路径，不解析 opaque targetKey。FsLocal + workingDirectory + 真实 read/write/edit + subprocess/ripgrep 的 grep/glob 已执行，覆盖别名、其他 Agent、state/receipt、搜索祖先、硬链接及实时 cwd。搜索对本机多链接文件保守拒绝，元数据检查最多 100000 个目录项。
- 程序模式使用真实 ToolRuntime 桥和测试执行后端；Memory 子调用正常落盘，外层 run_code 源码/回显及 Memory 子调用不进入形成，公共 Claim 子调用正文和引用仍保留。未把测试执行后端算成真实 Node 程序沙箱验收。
- 路径保护覆盖已知工具；任意 shell、直接文件 I/O、自定义工具、外部路径竞争及未实测远端 provider 的边界见使用说明。M6 受限 child 在开启完整 Memory bundle 的安装流程继续回归。
