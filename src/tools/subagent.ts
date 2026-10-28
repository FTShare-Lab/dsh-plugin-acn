// 父会话权限不随子代理继承；来源与深度任一标记都足以触发只读门禁。
export function isSubagent(header: { origin?: string; delegationDepth?: number }): boolean {
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
}
export function isEvidenceAgent(header: { origin?: string; agentPreset?: string }): boolean { return header.origin === 'subagent' && (header.agentPreset === 'acn-evidence' || header.agentPreset === 'acn-dream'); }
