// 存储错误只携带分类和位置，不把待写入的业务正文放进错误信息。
export class StoreError extends Error {
  constructor(readonly kind: 'io' | 'decode' | 'encode' | 'conflict' | 'ownership' | 'lock_timeout' | 'lock_order' | 'lock_compromised', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}
export class LockTimeoutError extends StoreError {
  constructor(path: string) { super('lock_timeout', `Timed out acquiring lock: ${path}`); this.name = 'LockTimeoutError'; }
}
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
