// 团队错误只公开操作、分类和状态码；不携带请求、响应正文或底层网络错误。
export type TeamErrorKind = 'auth' | 'client' | 'legacy_route' | 'retryable' | 'protocol' | 'cancelled';
export class TeamError extends Error {
  constructor(readonly kind: TeamErrorKind, readonly service: 'router' | 'maintainer', readonly operation: string, readonly status?: number) {
    const hint = kind === 'auth' ? '鉴权失败，请检查 agentId 和 team.keyEnv 对应的凭据。'
      : kind === 'legacy_route' ? '服务端不支持 Inbox receipt ACK，请升级团队服务。'
      : kind === 'retryable' ? '服务暂时不可用，本地知识和待投递任务已保留。'
      : kind === 'protocol' ? '响应不符合团队协议，请检查服务版本。'
      : kind === 'cancelled' ? '请求已取消。' : '请求被服务端拒绝，请检查请求权限与参数。';
    super(`${service} ${operation}：${hint}${status === undefined ? '' : ` status=${status}`}`);
  }
}
