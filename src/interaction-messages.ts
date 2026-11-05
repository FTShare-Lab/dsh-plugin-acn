// 对外消息保留稳定分类；旧中文记录也能在英文页面给出可执行的恢复说明。
import { z } from 'zod';
export const MessageInfoSchema = z.object({ code: z.string(), count: z.number().optional(), entityId: z.string().optional(), status: z.number().optional() });
export type MessageInfo = z.infer<typeof MessageInfoSchema>;
const messages = {
  check_auth: ['认证未通过，请检查 Agent ID 和团队鉴权密钥。', 'Authentication failed. Check the Agent ID and team authentication key.'],
  check_timeout: ['连接超时，请检查服务状态和网络后重试。', 'The connection timed out. Check the service and network, then retry.'],
  check_dns: ['无法解析服务域名，请检查地址和网络。', 'The service hostname could not be resolved. Check the URL and network.'],
  check_unreachable: ['无法连接服务，请检查地址、端口和服务是否已启动。', 'The service could not be reached. Check its address, port and whether it is running.'],
  check_network: ['网络连接失败，请检查网络或代理后重试。', 'The network connection failed. Check the network or proxy and retry.'],
  check_service: ['服务暂时不可用，请检查服务状态后重试。', 'The service is temporarily unavailable. Check its status and retry.'],
  check_protocol: ['服务响应不符合 ACN 协议，请联系团队管理员检查服务版本。', 'The response does not match the ACN protocol. Ask your team administrator to check the service version.'],
  check_client: ['服务拒绝了请求，请检查服务地址和访问权限。', 'The service rejected the request. Check its URL and access permissions.'],
  check_offline: ['部分团队服务不可用；可保存配置并继续本地工作，团队同步前需恢复连接。', 'Some team services are unavailable. You can save and continue local work; restore the connection before team sync.'],
  team_check_ok: ['连接与认证通过', 'Connection and authentication passed'],
  team_check_failed: ['未通过，请检查地址、服务状态和团队鉴权密钥。', 'Check the service URL, availability and team authentication key.'],
  delivery_ack: ['已标记知悉；该争议仍未成功投递。', 'Acknowledged. This dispute was not successfully delivered.'],
  delivery_complete: ['本轮团队投递已完成。', 'This delivery attempt completed.'],
  delivery_incomplete: ['团队投递未全部完成，请查看活动中的具体原因。', 'Team delivery did not fully complete. Review the reasons in Activity.'],
  delivery_wait: ['仍有投递正在进行或等待依赖，待投记录已保留。', 'Delivery is still in progress or waiting for dependencies. Pending records are retained.'],
  dream_new: ['已创建新的 Dream 请求，将重新读取当前知识。', 'A new Dream request was created and will read current knowledge.'],
  service_inactive: ['知识组件尚未启用，聊天仍可继续。请在插件管理中启用 ACN 知识组件。', 'The knowledge component is inactive. Chat remains available. Enable the ACN knowledge component in the plugin manager.'],
  invalid_request: ['请求字段不合法，请重新加载页面。', 'The request is invalid. Reopen the ACN page and retry.'],
  select_identity: ['请选择可用的知识身份。', 'Select an available work configuration.'],
  identity_unavailable: ['知识身份不可用。', 'This knowledge identity is unavailable. Restore its work configuration first.'],
  retry_disabled: ['连接已停用或删除，不能重试。', 'This configuration is disabled or missing. Restore it in ACN settings before retrying.'],
  retry_queued: ['任务已重新入队。', 'The task has been queued again.'],
  session_unavailable: ['会话不可用，请重新打开或新建会话。', 'The session is unavailable. Reopen it or start a new session.'],
  session_unbound: ['本会话未启用 ACN，聊天仍可继续。只有安装插件后新建且尚未发送消息的会话可选择工作配置；如需使用 ACN，请新建会话。', 'ACN is not enabled for this session; ordinary chat remains available. Only blank sessions created after installation can choose a work configuration. Start a new session to use ACN.'],
  session_optional: ['本会话尚未启用 ACN，可直接聊天，或在首条消息前选择工作配置。', 'ACN is not enabled for this session. You can chat normally, or choose a work configuration before the first message.'],
  recap_disabled: ['知识形成组件未启用。', 'Knowledge formation is inactive. Enable the formation component in the plugin manager.'],
  recap_empty: ['没有可复盘的新增内容。', 'There is no new completed content to recap.'],
  recap_queued: ['复盘已入队，可在处理活动中查看。', 'The recap is queued. View it in Activity.'],
  solo_check: ['单人配置不需要连接检查；请先填写两个团队地址。', 'Solo configurations need no team check. Enter both team service URLs first.'],
  agent_required: ['请先填写 Agent ID。', 'Enter an Agent ID first.'],
  check_cancelled: ['检查已取消。', 'The check was cancelled.'],
  team_checked: ['团队连接检查通过。', 'Team connection and authentication checks passed.'],
  team_unavailable: ['部分服务不可用；可离线保存，使用前需恢复连接。', 'Some team services are unavailable. You can save offline; restore connectivity before using them.'],
  model_automatic: ['沿用会话模型；首次同步前请先选择聊天模型。', 'Following the session model. Select a chat model before the first sync.'],
  model_checked: ['知识模型检查通过。', 'The knowledge model check passed.'],
  model_check_failed: ['模型未正常完成检查，保留原模型。请检查模型配置或重试。', 'The model did not complete the check. The previous model is retained. Check its configuration and retry.'],
  operation_failed: ['操作未完成。请检查连接、知识模型和本地存储后重试。', 'The operation did not complete. Check the team connection, knowledge model and local storage, then retry.'],
  configuration_busy: ['ACN 配置正在应用，请稍后重试。', 'ACN configuration is being applied. Retry shortly.'],
  key_invalid: ['请检查团队配置，并填写有效的鉴权密钥。', 'Check the team configuration and enter a valid authentication key.'],
  key_check_failed: ['检查未完成，请核对团队配置后重试。', 'The check did not complete. Review the team settings and retry.'],
  key_unmanaged: ['当前 DSH 未提供凭据托管，无法在此页保存新密钥。仍可输入临时密钥检查连接；保存新密钥需使用支持凭据托管的 DSH。已有环境变量引用可继续沿用，高级配置方法见插件配置文档。', 'This DSH has no credential storage, so this page cannot save a new key. You can check a temporary key or retain an existing environment reference. Saving a key requires DSH credential storage; see the plugin configuration guide for advanced setup.'],
  key_readonly: ['当前密钥存储只读，无法保存新密钥；仍可检查连接，或留空保留现有密钥。', 'Credential storage is read-only. You can check a draft key or keep the current key, but cannot save a replacement.'],
  key_immutable: ['已有密钥引用不能覆盖，请重新输入并保存为新引用。', 'An existing credential reference cannot be overwritten. Enter the key again and save a new reference.'],
  key_in_use: ['密钥已被配置或会话使用，保留现有凭据。', 'The key is in use by a configuration or session and has been retained.'],
  key_stored: ['凭据已保存到 DSH 托管存储，完成配置保存后，新启动的会话才会采用；已有会话保留原连接。', 'The new credential is stored. New sessions adopt it after the configuration saves; existing sessions retain their connection.'],
  key_failed: ['凭据操作未完成，请检查宿主凭据服务后重试。', 'The credential operation failed. Check the host credential service and retry.'],
  blank_identity: ['请从 ACN 菜单选择可用的工作配置，初始化当前空白会话。', 'Choose a work configuration from the ACN menu to initialize this blank session.'],
  bound_identity: ['工作配置已停用、缺失或 Agent ID 已改变；请在设置中恢复同一配置及原 Agent ID，或使用新会话。', 'The work configuration is disabled, missing, or its Agent ID changed. Restore the same configuration and original Agent ID, or start a new session.'],
  connection_changed: ['已保存新连接，当前会话仍使用启动时的配置。', 'The new connection is saved. This session retains its startup configuration.'],
  sync_retry: ['上次同步未完成，可继续本地工作或重试同步。', 'The last sync did not finish. Continue with local knowledge or retry sync.'],
  sync_cancelled: ['已取消同步等待，已持久化的收件保留，可继续使用本地知识。', 'Sync waiting was cancelled. Received items are retained; continue with local knowledge.'],
  sync_wait: ['正在同步团队收件并准备本地知识…', 'Synchronizing the team Inbox and preparing local knowledge…'],
  sync_cancelling: ['正在结束同步并准备本地知识，已持久化的收件保留。', 'Ending sync waiting and preparing local knowledge. Received items are retained.'],
  solo_ready: ['单人模式已就绪，不连接团队服务。', 'Solo mode is ready. No team services are contacted.'],
} as const;
export type MessageCode = keyof typeof messages;
export const messageInfo = (message: string, kind?: string): MessageInfo => {
  const known = Object.entries(messages).find(([, value]) => value[0] === message);
  if (known !== undefined) return { code: known[0] };
  const entityId = message.match(/\b(?:claim|dispute)_[0-9a-f]{8}\b/)?.[0];
  const statusText = message.match(/status=(\d{3})/)?.[1]; const status = statusText === undefined ? undefined : Number(statusText);
  let code = kind === undefined ? '' : `task.${kind}`;
  if (!code && /Router 概览暂不可用|Maintainer 收件或确认未完成|同步失败/.test(message)) code = 'sync_partial';
  if (!code && /收件同步完成：拉取 (\d+) 条/.test(message)) return { code: 'sync_complete', count: Number(message.match(/拉取 (\d+) 条/)?.[1] ?? 0) };
  if (!code && /Router 概览暂不可用|Maintainer 收件或确认未完成|同步失败/.test(message)) code = 'sync_partial';
  if (!code && /会话.*身份|知识归属|原连接|原 Agent ID/.test(message)) code = 'bound_identity';
  if (!code && /只能重试已失败/.test(message)) code = 'retry_state';
  if (!code && /^(router|maintainer) POST/u.test(message)) code = /鉴权|认证/.test(message) ? 'delivery.auth' : 'delivery.retryable';
  if (!code && /鉴权|认证/.test(message)) code = 'task.model_auth';
  if (!code && /409/.test(message)) code = 'delivery.rejected';
  if (!code && /待上传版本/.test(message)) code = 'delivery.version';
  if (!code && /收件|同步/.test(message)) code = 'sync_partial';
  return { code: code || 'legacy', ...(entityId === undefined ? {} : { entityId }), ...(status === undefined ? {} : { status }) };
};
const recovery: Record<string, string> = {
  transcript_occupied: 'Session projection files are not writable or a lock timed out after bounded retries. Check file usage and directory permissions, then retry the original task. No knowledge model call was made.',
  transcript_space: 'Local storage space or quota is exhausted. Restore capacity, then retry the original task; incomplete input was not sent to the knowledge model.',
  transcript_corrupt: 'Session projections conflict or are corrupt. Keep the original data and contact the maintainer; missing input was not skipped.',
  transcript_source: 'The original session log could not be replayed. Restore the original session and work configuration, then retry.',
  transcript_io: 'Session projection I/O failed. Check local storage, then retry the task or recap again; no knowledge model call was made.',
  transcript_limit: 'A single session projection exceeds the size limit. Keep the original session and contact the maintainer; oversized input cannot be silently skipped.',
  formation_enqueue: 'The formation task could not be queued. Projections are retained. Check local storage and recap again.',
  handler_inactive: 'The required background component is inactive. Enable it in the DSH plugin manager, then retry.',
  context_limit: 'The model context limit was reached. Select a knowledge model with enough context and retry.',
  structured_output: 'The model repeatedly returned invalid JSON. Retry or choose another knowledge model.',
  structured_output_limit: 'The model output was truncated. Increase the output limit or choose another knowledge model, then retry.',
  structured_output_content: 'The model returned unsupported response content. Retry or choose another knowledge model.',
  model_response: 'The model response format was invalid. Retry or choose another knowledge model.',
  identity: 'Restore the original work configuration and Agent ID, or start a new session.',
  bound: 'This session identity is fixed. Start a new session to choose a different configuration.',
  connection: 'Restore this work configuration and its team connection in ACN settings before retrying.',
  empty: 'There are no owned active or stale claims to organize. Form reusable knowledge first.',
  disabled: 'Dream is disabled. Enable the Dream component and dream.enabled in plugin configuration before retrying.',
  validation: 'This operation does not match the current task state. Refresh Activity and select the current failed or paused task.',
  inbox: 'Inbox processing did not finish. Review the failed task in Activity and check the knowledge model or team connection.',
  model_auth: 'Model authentication failed. Check the model provider credentials in DSH settings, then retry.',
  model_quota: 'The model quota is exhausted. Restore provider quota or select another knowledge model, then retry.',
  model_context: 'The model context limit was reached. Select a model with enough context, then retry.',
  model_request: 'The model rejected the request. Check the model parameters and output limits, then retry.',
  model_rate_limit: 'The model rate limit was reached. Wait or reduce provider concurrency, then retry.',
  model_server: 'The model service is unavailable. Wait or choose another knowledge model, then retry.',
  model_empty: 'The model returned an empty response. Retry or choose another knowledge model.',
  timeout: 'The model request timed out. Check connectivity or timeout settings, then retry.',
  transport: 'The model connection failed. Restore connectivity to the provider, then retry.',
  route: 'No usable knowledge model route is available. Choose a knowledge model in ACN settings, then retry.',
  dream_tool_json: 'The model returned invalid tool-argument JSON after two retries. Progress and used budget are retained. Retry later or change the knowledge model.',
  dream_timeout: 'A Dream model request timed out. Progress and used budget are retained. Restore model connectivity and retry.',
  dream_output_limit: 'Dream reached the model output limit. Progress and used budget are retained. Adjust the output limit or choose another knowledge model, then retry.',
  dream_incomplete: 'Dream did not finish normally. Progress and used budget are retained. Review activity and retry.',
  model_malformed: 'The model response format is invalid. Progress is retained. Retry or choose another knowledge model.',
  structured_invalid: 'The model repeatedly returned invalid structured output. Retry or choose another knowledge model.',
  knowledge_busy: 'The knowledge store is busy. Wait for the current commit to finish, then retry.',
  storage: 'Local storage could not be read or committed. Check directory permissions and available disk space, then retry.',
};
export function displayMessage(message: string, copy: (zh: string, en: string) => string, info?: MessageInfo): string {
  if (message === '' || copy('中文', 'English') === '中文') return message;
  const descriptor = info ?? messageInfo(message);
  const key = descriptor.code;
  const fixed = messages[key as MessageCode];
  let text: string;
  if (fixed !== undefined) text = fixed[1];
  else if (key.startsWith('task.')) text = recovery[key.slice(5)] ?? 'The background task failed. Check the knowledge model and local storage, then retry.';
  else if (key === 'sync_complete') text = `Inbox sync completed: ${descriptor.count ?? 0} received. Local knowledge is ready.`;
  else if (key === 'sync_partial') text = 'Team sync did not fully complete. Check the Router and Maintainer URLs, team authentication key, knowledge model and local storage; local work can continue.';
  else if (key === 'retry_state') text = 'Only failed tasks can be retried. Refresh Activity and choose the current failed task.';
  else if (key === 'delivery.rejected') text = 'The team service rejected this dispute (409). Automatic retries stopped. Review the related claims before forming a new dispute.';
  else if (key === 'delivery.auth') text = 'Team delivery authentication failed. Check the member ID and team key in ACN settings, then retry delivery.';
  else if (key === 'delivery.dependency') text = 'Waiting for consolidation carrier acknowledgement. Delivery resumes when dependencies are ready.';
  else if (['delivery.retryable', 'delivery.client', 'delivery.protocol'].includes(key)) text = 'Team delivery failed. Check the team URLs, connectivity, permissions and service version, then retry delivery.';
  else if (key === 'delivery.version') text = 'The queued claim differs from the current local version. Review the current claim in a team session before sharing it again.';
  else text = /^[^\u0080-\uFFFF]*$/u.test(message) ? message : 'The operation could not complete. Review the work configuration, team connection and knowledge model, then retry.';
  return text + (descriptor.entityId === undefined ? '' : ` ${descriptor.entityId}`) + (descriptor.status === undefined ? '' : ` [${descriptor.status}]`);
}

export function commandMessage(message: string, kind?: string): string {
  if (/^[^\u0080-\uFFFF]*$/u.test(message)) return message;
  return `${message}\n${displayMessage(message, (_zh, en) => en, messageInfo(message, kind))}`;
}
