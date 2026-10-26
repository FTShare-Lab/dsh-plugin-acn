// 与参考模板引擎的快照逐字比较，并确认私有双文件从不进入 Claim 提示词。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { ScriptAdapter } from '../flow/adapter.js';
import { flowHarness } from '../flow/harness.js';

describe('knowledge templates', () => {
  it.each([
    ['knowledge.j2', { agent_id: 'agent-a', team: false }, 'knowledge-solo'],
    ['knowledge.j2', { agent_id: 'agent-a', team: true }, 'knowledge-team'],
    ['session_recap.j2', { memory_enabled: false }, 'session-recap'],
    ['inbox_policy_update_internalize.j2', {}, 'inbox-policy-update'],
    ['inbox_claim_attribute_update_internalize.j2', {}, 'inbox-claim-attribute-update'],
    ['claim_dream.j2', {}, 'claim-dream'], ['dream_compaction.j2', {}, 'dream-compaction'],
    ['dream_evidence.j2', {}, 'dream-evidence'],
    ['what_is_memory.j2', {}, 'what_is_memory'], ['memory.j2', { memory_md: 'Example frozen private notes.', user_md: 'Example frozen user preference.' }, 'memory'],
    ['memory_review_system.j2', { agent_id: 'agent-a' }, 'memory-review-system'], ['memory_review.j2', {}, 'memory-review'],
    ['what_is_claim.j2', {}, 'what_is_claim'], ['what_is_dispute.j2', {}, 'what_is_dispute'], ['what_is_policy.j2', {}, 'what_is_policy'],
  ])('matches the reference engine for %s %j', async (name, context, snapshot) => {
    if (typeof name !== 'string' || typeof snapshot !== 'string' || typeof context !== 'object') throw new Error('Invalid template case.');
    const render = await loadPromptRenderer();
    expect(render(name, context)).toBe(await fs.readFile(new URL(`../fixtures/prompts/${snapshot}.txt`, import.meta.url), 'utf8'));
  });
  it('user_md_never_in_claim_prompts and no private Memory snapshot is read', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      await fs.mkdir(flow.knowledge.context().paths.memories, { recursive: true });
      await fs.writeFile(join(flow.knowledge.context().paths.memories, 'USER.md'), 'PRIVATE_USER_MARKER');
      await fs.writeFile(join(flow.knowledge.context().paths.memories, 'MEMORY.md'), 'PRIVATE_MEMORY_MARKER');
      const agent = await flow.create();
      const assembly = await flow.ctx.systemPrompt.assemble(assembleContextFor(agent));
      const text = assembly.sections.map((section) => section.text).join('\n');
      expect(text).not.toContain('PRIVATE_USER_MARKER'); expect(text).not.toContain('PRIVATE_MEMORY_MARKER');
      expect(text).not.toContain('router scope overview'); expect(text).not.toContain('consult_router');
      expect(text).not.toContain('!command'); expect(text).not.toContain('file_edit_authority_enabled');
    } finally { await flow.close(); }
  });
});
