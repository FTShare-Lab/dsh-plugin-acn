// 工具可展示的领域错误不携带正文、配置值或底层文件系统异常。
export type KnowledgeErrorKind = 'validation' | 'not_found' | 'ownership' | 'safety' | 'unconfigured' | 'conflict';
export class KnowledgeError extends Error {
  constructor(readonly kind: KnowledgeErrorKind, message: string) { super(message); this.name = 'KnowledgeError'; }
}
export class RevisionConflict extends KnowledgeError {
  constructor(readonly currentRevision: string) { super('conflict', `Claim revision conflict; current revision: ${currentRevision}`); this.name = 'RevisionConflict'; }
}
