// 模板异步预读到内存，渲染阶段不进行同步文件 I/O。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';

const templateNames = ['memory.j2', 'what_is_memory.j2', 'memory_review.j2', 'memory_review_system.j2', 'claim_dream.j2', 'claim_dream_legacy.j2', 'dream_compaction.j2', 'dream_evidence.j2', 'knowledge.j2', 'session_recap.j2', 'inbox_policy_update_internalize.j2', 'inbox_claim_attribute_update_internalize.j2', 'what_is_claim.j2', 'what_is_dispute.j2', 'what_is_policy.j2'] as const;
class MemoryLoader extends nunjucks.Loader {
  constructor(private readonly sources: Readonly<Record<string, string>>) { super(); }
  getSource(name: string) {
    const src = this.sources[name];
    if (src === undefined) throw new Error('Unknown knowledge template.');
    // 参考引擎默认移除每个模板末尾的一次换行，包含模板也遵守同一规则。
    return { src: src.endsWith('\n') ? src.slice(0, -1) : src, path: name, noCache: false };
  }
}
export function promptRenderer(sources: Readonly<Record<string, string>>) {
  const environment = new nunjucks.Environment(new MemoryLoader(sources), { autoescape: false, throwOnUndefined: true });
  return (name: string, context: object): string => environment.render(name, context);
}
export async function loadPromptRenderer() {
  const root = dirname(fileURLToPath(import.meta.resolve('@ftai/dsh-plugin-acn/package.json')));
  const sources = await Promise.all(templateNames.map(async (name) => [name, await readFile(join(root, 'prompts', name), 'utf8')] as const));
  return promptRenderer(Object.fromEntries(sources));
}
