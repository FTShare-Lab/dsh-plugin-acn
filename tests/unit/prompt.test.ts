// 与参考模板引擎的快照逐字比较，并确认私有双文件从不进入 Claim 提示词。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { ScriptAdapter } from '../flow/adapter.js';
import { flowHarness } from '../flow/harness.js';

describe('knowledge templates', () => {
  it('restores scoped team retrieval and applicability discipline without adding host harness instructions', async () => {
    const render = await loadPromptRenderer(); const team = render('knowledge.j2', { agent_id: 'agent-a', team: true });
    expect(team).not.toContain('团队传输接入前'); expect(team).not.toContain('插件不在 session 启动时注入'); expect(team).toContain('session 启动时 router 记录的团队 claim 范围快照');
    for (const phrase of ['mode="overview"', 'mode="query"', 'semantic_query', 'disputes', '异常路径', '版本快照', '不能盲目重试', '作为 `expected_revision`', '不改来源链、不写 dispute', '主路径成立不代表方案已经完整']) expect(team).toContain(phrase);
    expect(team).not.toContain('policy 是 maintainer');
    const solo = render('knowledge.j2', { agent_id: 'agent-a', team: false }); expect(solo).not.toContain('consult_router'); expect(solo).toContain('适用条件');
    const dream = render('claim_dream.j2', {}); expect(dream).toContain('dream_apply_group'); expect(dream).toContain('dream_record_candidates'); expect(dream).toContain('探索模型请求额度'); expect(dream).toContain('额外有限的收尾'); expect(dream).toContain('下次 Dream 重新读取当时的 Claim'); expect(dream).not.toContain('self_review 必须');
  });
  it('preserves Memory selection discipline in both foreground and background prompts', async () => {
    const render = await loadPromptRenderer();
    const memory = render('memory.j2', { memory_md: 'FROZEN_PRIVATE_MARKER', user_md: '' });
    const review = render('memory_review_system.j2', { agent_id: 'agent-a' });
    for (const prompt of [memory, review]) {
      for (const rule of ['正向反馈和负向纠正都应作为潜在 memory 信号判断', '容易从当前代码、文档、git 或快速搜索重新发现的事实也不要保存', 'PR/issue/commit 编号', '“用户偏好简洁回答” ✓；“永远简洁回答” ✗', '降低 persistent memory 系统提供的信息密度', '增/删 文本使用的语言应该与使用 `memory` 工具时用户与 agent 交互的语言保持一致', '必须写成绝对时间']) expect(prompt).toContain(rule);
      expect(prompt).toContain('`ops` 数组'); expect(prompt).toContain('不进入 Recap/Finalize、Inbox 或 Dream 输入');
      expect(prompt).not.toContain('可以不保存'); expect(prompt).not.toContain('action="add"');
    }
    expect(memory).toContain('FROZEN_PRIVATE_MARKER'); expect(review).not.toContain('FROZEN_PRIVATE_MARKER');
    expect(review).toContain('不要直接重复 `add`'); expect(review).toContain('只返回符合 schema 的 {"ops": [...]}');
    expect(review).toContain('`memory_entries` / `user_entries`'); expect(review).toContain('截断或缺失内容');
    expect(render('memory_review.j2', {})).toContain('只返回 {"ops": []}'); expect(render('memory_review.j2', {})).not.toContain('Nothing to save.');
  });
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
