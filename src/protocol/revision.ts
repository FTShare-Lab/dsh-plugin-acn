// 完整 Claim 的规范 JSON 与 revision，避免依赖输入键的插入顺序。
import { createHash } from 'node:crypto';
import { ClaimSchema } from './claim.js';

export function canonicalJson(value: unknown): string { return JSON.stringify(ClaimSchema.parse(value)); }
export function claimRevision(value: unknown): string { return `sha256-v1:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
