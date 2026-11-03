// 真实宿主验证知识刷新暂缓不结束编码，游标在后续通知准入后才推进。
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeBusy } from '../../src/knowledge/alignment.js';
import { LockTimeoutError } from '../../src/store/errors.js';
import { ClaimStore } from '../../src/store/claims.js';
import { acquireFileLease } from '../../src/store/lock.js';
import { SessionStateStore, VersionedDocumentSchema } from '../../src/store/session-state.js';
import { KnowledgeSessions } from '../../src/knowledge/sessions.js';
import { ScriptAdapter, textResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';

describe('foreground knowledge refresh conflicts', () => {
  it('cancels a restored upstream baseline blocked on knowledge without making a model request', async () => {
    const adapter = new ScriptAdapter([]); const f = await flowHarness(adapter, { config: { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } }, dream: { enabled: false } } });
    let release = async () => {}; let restore = () => {};
    try {
      const agent = await f.create(); const runtime = await f.ctx.acnRuntime.service(agent.session.header);
      await new SessionStateStore(runtime.knowledge.context()).update(agent.session.id, (current) => { const next = VersionedDocumentSchema.parse({ ...current, schemaVersion: 1 }); delete next['catalog']; return next; });
      const catalog = vi.spyOn(KnowledgeSessions.prototype, 'catalog').mockReturnValue('');
      let entered = () => {}; const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const nativeSnapshot = runtime.knowledge.snapshot.bind(runtime.knowledge);
      const snapshot = vi.spyOn(runtime.knowledge, 'snapshot').mockImplementation((...args) => { entered(); return nativeSnapshot(...args); });
      restore = () => { snapshot.mockRestore(); catalog.mockRestore(); };
      const lease = await acquireFileLease(runtime.knowledge.context().paths.knowledgeLock); release = () => lease.release();
      const endings: string[] = []; f.ctx.on('session/event', (session, event) => { if (session.id === agent.session.id && event.type === 'turn/end') endings.push(event.data.reason.kind); });
      const running = turn(agent); await waiting; agent.cancel({ kind: 'user' }); await running;
      expect(endings).toEqual(['aborted']); expect(adapter.requests).toHaveLength(0);
    } finally { restore(); await release(); await f.close(); }
  });
  it.each([false, true])('keeps a real contended knowledge lock outside the foreground request path (upstreams=%s)', async (upstreams) => {
    const adapter = new ScriptAdapter([textResponse('The local coding turn can continue.')]);
    const f = await flowHarness(adapter, { config: { ...(upstreams ? { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } } : {}), dream: { enabled: false } } });
    let release = async () => {};
    try {
      const agent = await f.create(); const knowledge = (await f.ctx.acnRuntime.service(agent.session.header)).knowledge;
      const lease = await acquireFileLease(knowledge.context().paths.knowledgeLock); release = () => lease.release();
      const endings: string[] = []; f.ctx.on('session/event', (session, event) => { if (session.id === agent.session.id && event.type === 'turn/end') endings.push(event.data.reason.kind); });
      await turn(agent); expect(endings).toEqual(['completed']); expect(adapter.requests).toHaveLength(1);
    } finally { await release(); await f.close(); }
  });
  it.each([false, true].flatMap((upstreams) => ['temporary', 'persistent', 'lock-timeout'].map((mode) => ({ upstreams, mode }))))('continues coding and later admits the deferred notice once ($upstreams, $mode)', async ({ upstreams, mode }) => {
    const adapter = new ScriptAdapter([textResponse('Continued with the frozen knowledge context.'), textResponse('Received the completed knowledge update.'), textResponse('No duplicate notice is needed.')]);
    const f = await flowHarness(adapter, { config: { ...(upstreams ? { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } } : {}), dream: { enabled: false } } });
    let restore = () => {};
    try {
      const agent = await f.create(); const knowledge = (await f.ctx.acnRuntime.service(agent.session.header)).knowledge;
      await new ClaimStore(knowledge.context()).write({ ...f.claim, name: 'newly-committed-rule' });
      const notices: string[] = []; const endings: string[] = [];
      f.ctx.on('session/event', (session, event) => {
        if (session.id !== agent.session.id) return;
        if (event.type === 'user/message' && event.data.source.kind === 'acn-claim-changes') notices.push(JSON.stringify(event.data));
        if (event.type === 'turn/end') endings.push(event.data.reason.kind);
      });
      const nativeSnapshot = knowledge.snapshot.bind(knowledge); let failures = mode === 'temporary' ? 1 : 10;
      const spy = vi.spyOn(knowledge, 'snapshot').mockImplementation((...args) => {
        if (failures > 0) { failures -= 1; return Promise.reject(mode === 'lock-timeout' ? new LockTimeoutError('neutral-lock') : new KnowledgeBusy()); }
        return nativeSnapshot(...args);
      });
      restore = () => { spy.mockRestore(); };
      await turn(agent); expect(endings).toEqual(['completed']); expect(adapter.requests).toHaveLength(1);
      if (mode !== 'temporary') expect(notices).toHaveLength(0);
      failures = 0; await turn(agent); await turn(agent);
      expect(endings).toEqual(['completed', 'completed', 'completed']); expect(notices).toHaveLength(1); expect(notices[0]).toContain('newly-committed-rule');
    } finally { restore(); await f.close(); }
  });
  it('preserves a real storage error instead of treating every refresh failure as temporary', async () => {
    const adapter = new ScriptAdapter([]); const f = await flowHarness(adapter);
    try {
      const agent = await f.create(); const spy = vi.spyOn(f.knowledge, 'snapshot').mockRejectedValueOnce(new Error('Storage unavailable.'));
      const endings: string[] = []; f.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') endings.push(event.data.reason.kind); });
      await turn(agent); spy.mockRestore(); expect(endings).toEqual(['error']); expect(adapter.requests).toHaveLength(0);
    } finally { await f.close(); }
  });
});
