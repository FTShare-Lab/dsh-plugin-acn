// 查证权限与回执由插件写入独立清单；模型只能引用，不能提交自己构造的文件版本。
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import type { StoreContext } from '../store/context.js';
import type { Claim } from '../protocol/claim.js';
import { ClaimIdSchema } from '../protocol/ids.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { KeySchema, requireDream, DreamValidationError } from './schema.js';
import { ReceiptSchema, independentReceipt, type Receipts } from './evidence.js';
import { authorizeFile, discoverable, readEvidenceFile, receiptCurrent } from './evidence-files.js';
import { claimRevision } from '../protocol/revision.js';
import { valueHash } from './plan.js';

export const ReadArgs = z.strictObject({ path: z.string().min(1), claim_ids: z.array(ClaimIdSchema).min(1), start: z.number().int().positive().default(1), count: z.number().int().positive().max(2000).default(200) });
export const GlobArgs = z.strictObject({ query: z.string().max(200).default('') });
export const GrepArgs = z.strictObject({ query: z.string().min(1).max(200) });
export const ClaimArgs = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('list') }), z.strictObject({ action: z.literal('read'), id: ClaimIdSchema })]);
export const EvidenceTools = { read: ReadArgs, glob: GlobArgs, grep: GrepArgs, claim: ClaimArgs };
export type EvidenceTool = keyof typeof EvidenceTools;
const LimitsSchema = z.strictObject({ calls: z.number().int().positive(), steps: z.number().int().positive(), bytes: z.number().int().positive(), chars: z.number().int().positive(), files: z.number().int().positive() });
export const EvidenceManifestSchema = z.strictObject({ schemaVersion: z.literal(1), job_id: KeySchema, group_id: KeySchema, workspace_root: z.string(), claim_versions: z.record(ClaimIdSchema, z.string()), receipts: z.record(z.string(), ReceiptSchema), calls: z.number().int().nonnegative(), model_steps: z.number().int().nonnegative(), bytes_read: z.number().int().nonnegative(), files_examined: z.number().int().nonnegative(), limits: LimitsSchema, completed: z.boolean() });
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
export const privateDataHome = (context: StoreContext): string => dirname(dirname(context.paths.root));
export class EvidenceStore {
  readonly path: string;
  constructor(readonly context: StoreContext, readonly jobId: string, readonly groupId: string) { this.path = join(context.paths.dreamJob(jobId), 'evidence', `${KeySchema.parse(groupId)}.yaml`); }
  async read(): Promise<EvidenceManifest | null> {
    const manifest = await readYamlOr(this.path, EvidenceManifestSchema, () => null);
    requireDream(manifest === null || manifest.job_id === this.jobId && manifest.group_id === this.groupId, '查证清单身份与任务不一致。'); return manifest;
  }
  private save(manifest: EvidenceManifest): Promise<void> { return writeYamlAtomic(this.path, manifest, EvidenceManifestSchema, this.context.logger); }
  async initialize(workspace: string, claims: readonly Claim[], config: ResolvedConfig['dream'], signal?: AbortSignal): Promise<EvidenceManifest> {
    return withFileLock(`${this.path}.lock`, async () => {
      signal?.throwIfAborted();
      // 旧清单不延续已撤销的新读取权限；prepared 恢复只走 authorize，不重新初始化。
      requireDream(config.evidenceCalibration, '证据校准未启用。');
      const prior = await this.read(); const versions = Object.fromEntries(claims.map((claim) => [claim.id, claimRevision(claim)]));
      requireDream(claims.length > 0 && claims.every((claim) => claim.holder === this.context.agentId && claim.confidence !== 'high' && claim.status !== 'deprecated'), '受限查证仅接受自身 medium/low 候选。');
      if (prior !== null) { requireDream(prior.workspace_root === workspace && valueHash(prior.claim_versions) === valueHash(versions), '查证权限不能换工作区或 Claim 版本。'); return prior; }
      const manifest: EvidenceManifest = { schemaVersion: 1, job_id: this.jobId, group_id: this.groupId, workspace_root: workspace, claim_versions: versions, receipts: {}, calls: 0, model_steps: 0, bytes_read: 0, files_examined: 0, limits: { calls: config.evidenceMaxCalls, steps: config.evidenceMaxSteps, bytes: config.evidenceMaxBytes, chars: config.evidenceMaxChars, files: config.evidenceMaxFiles }, completed: false };
      await this.save(manifest); return manifest;
    }, { signal });
  }
  async admitStep(signal: AbortSignal): Promise<void> { await withFileLock(`${this.path}.lock`, async () => { signal.throwIfAborted(); const manifest = await this.read(); requireDream(manifest !== null && !manifest.completed && manifest.model_steps < manifest.limits.steps, '查证模型步数预算已用尽。'); manifest.model_steps += 1; await this.save(manifest); }, { signal }); }
  async reopen(signal: AbortSignal): Promise<void> { await withFileLock(`${this.path}.lock`, async () => { signal.throwIfAborted(); const manifest = await this.read(); requireDream(manifest !== null, '缺少查证清单。'); manifest.completed = false; await this.save(manifest); }, { signal }); }
  async complete(signal: AbortSignal): Promise<void> { await withFileLock(`${this.path}.lock`, async () => { signal.throwIfAborted(); const manifest = await this.read(); requireDream(manifest !== null, '缺少查证清单。'); manifest.completed = true; await this.save(manifest); }, { signal }); }
  async current(manifest: EvidenceManifest): Promise<boolean> { for (const receipt of Object.values(manifest.receipts)) if (!await receiptCurrent(receipt, manifest.workspace_root, privateDataHome(this.context))) return false; return true; }
  // 在知识锁内仅做只读校验；不再获取 evidence 锁，也不调用模型或网络。
  async authorize(receipts: Receipts, workspace: string | undefined, before: readonly Claim[]): Promise<boolean> {
    if (Object.keys(receipts).length === 0) return true;
    const manifest = await this.read(); requireDream(manifest !== null && manifest.completed && manifest.workspace_root === workspace, '证据缺少已完成的插件查证清单或工作区授权。');
    for (const [id, raw] of Object.entries(receipts)) {
      const receipt = independentReceipt(receipts, id); const original = manifest.receipts[id];
      requireDream(receipt !== null && original !== undefined && valueHash(raw) === valueHash(original), '证据回执并非由本组受限读取产生。');
      requireDream(receipt.input.claim_ids !== undefined && receipt.input.claim_ids.length > 0 && receipt.input.claim_ids.every((id) => before.some((claim) => claim.id === id && manifest.claim_versions[id] === claimRevision(claim) && claim.confidence !== 'high')), '证据授权的 Claim 或原始版本不一致。');
      if (!await receiptCurrent(receipt, manifest.workspace_root, privateDataHome(this.context))) return false;
    }
    return true;
  }
  async execute(name: EvidenceTool, args: unknown, claims: readonly Claim[], signal: AbortSignal): Promise<z.infer<ReturnType<typeof z.json>>> {
    return withFileLock(`${this.path}.lock`, async () => {
      signal.throwIfAborted(); const manifest = await this.read(); requireDream(manifest !== null && !manifest.completed, '查证已结束或尚未授权。');
      requireDream(manifest.calls < manifest.limits.calls, '查证工具调用预算已用尽。'); manifest.calls += 1; await this.save(manifest);
      const eligible = claims.filter((claim) => manifest.claim_versions[claim.id] === claimRevision(claim));
      if (name === 'claim') { const input = ClaimArgs.parse(args); if (input.action === 'list') return z.json().parse(eligible); const claim = eligible.find((claim) => claim.id === input.id); requireDream(claim !== undefined, '只读 claim 不能访问候选以外的知识。'); return z.json().parse(claim); }
      const load = async (path: string) => {
        signal.throwIfAborted(); const allowed = await authorizeFile(manifest.workspace_root, privateDataHome(this.context), path); const stat = await fs.lstat(allowed);
        requireDream(stat.isFile() && stat.nlink === 1 && stat.size + 1 <= manifest.limits.bytes - manifest.bytes_read, '查证文件或总字节预算不允许本次读取。');
        // 先保留预算再读文件，崩溃不能把已经执行的读取额度返还。
        manifest.bytes_read += stat.size + 1; await this.save(manifest);
        return readEvidenceFile(manifest.workspace_root, privateDataHome(this.context), path, stat.size);
      };
      if (name === 'read') {
        const input = ReadArgs.parse(args); requireDream(new Set(input.claim_ids).size === input.claim_ids.length && input.claim_ids.every((id) => eligible.some((claim) => claim.id === id)), `读取证据必须明确绑定本组可校准 Claim，允许的 claim_ids：${eligible.map((claim) => claim.id).join(', ')}。`);
        const file = await load(input.path); const lines = file.content.split('\n');
        requireDream(input.start <= lines.length, '读取起始行超过文件。');
        const selected: string[] = []; let chars = 0;
        for (const line of lines.slice(input.start - 1, input.start - 1 + input.count)) { if (chars + line.length + 1 > manifest.limits.chars) break; selected.push(line); chars += line.length + 1; }
        requireDream(selected.length > 0, '单行超过查证字符预算，请缩小文件内容。');
        const receipt = ReceiptSchema.parse({ tool: 'file_read', input: { path: file.path, claim_ids: input.claim_ids, show_linenos: false, start: input.start, count: input.count }, output: { content: selected.join('\n'), page: { returned_start: input.start, returned_end: input.start + selected.length - 1, total_lines: lines.length, truncated: input.start + selected.length - 1 < lines.length }, file_version: { path: file.path, revision: file.revision } } });
        const evidence_id = `file_${randomUUID().replaceAll('-', '')}`; manifest.receipts[evidence_id] = receipt; await this.save(manifest); signal.throwIfAborted();
        return z.json().parse({ evidence_id, ...receipt });
      }
      const input = name === 'glob' ? GlobArgs.parse(args) : GrepArgs.parse(args); const matches: object[] = []; let chars = 0; let truncated = false;
      const walk = async (directory: string): Promise<void> => {
        const dir = await fs.opendir(directory);
        for await (const entry of dir) {
          signal.throwIfAborted(); if (manifest.files_examined >= manifest.limits.files) { truncated = true; break; }
          manifest.files_examined += 1; await this.save(manifest);
          if (!discoverable(entry.name) || entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          try {
            await authorizeFile(manifest.workspace_root, privateDataHome(this.context), path);
            if (entry.isDirectory()) { await walk(path); if (truncated) break; }
            else if (entry.isFile()) {
              const label = relative(manifest.workspace_root, path);
              if (name === 'glob') { if (!label.includes(input.query)) continue; if (chars + label.length > manifest.limits.chars) { truncated = true; break; } matches.push({ path: label }); chars += label.length; }
              else {
                const file = await load(path);
                for (const [index, line] of file.content.split('\n').entries()) if (line.includes(input.query)) { if (chars + line.length + label.length > manifest.limits.chars) { truncated = true; break; } matches.push({ path: label, line: index + 1, text: line }); chars += line.length + label.length; }
                if (truncated) break;
              }
            }
          } catch (error) { if (!(error instanceof DreamValidationError)) throw error; }
        }
      };
      await walk(manifest.workspace_root); await this.save(manifest); return z.json().parse({ matches, truncated, independent_evidence: false });
    }, { signal });
  }
}
