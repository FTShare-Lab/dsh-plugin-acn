// 宿主没有普通归档的完成事件；围绕公开归档方法记录边界，保留原准入及取消行为。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type { AcnFormation } from '../formation/service.js';

export async function connectArchives(ctx: Context, formation: Pick<AcnFormation, 'beginArchive' | 'cancelArchive' | 'archived' | 'reconcileArchives'>, owns?: (id: string) => Promise<boolean>): Promise<void> {
  const registry = ctx.workspaceRegistry;
  const original = registry.archiveSession.bind(registry);
  const own = Object.getOwnPropertyDescriptor(registry, 'archiveSession');
  const wrapped: typeof original = async (id, options) => {
    if (registry.archivedSessionIds.includes(id)) return original.call(registry, id, options);
    // 草稿可首发前改选；旧目录的空投影不能代表当前会话仍属于该配置。
    if (owns !== undefined && !await owns(id)) return original.call(registry, id, options);
    const session = ctx.sessions.get(id);
    const upper = session === undefined ? undefined : session.seq - 1;
    const frozen = await formation.beginArchive(id, upper);
    try { await original.call(registry, id, options); }
    catch (error) { if (frozen !== null) await formation.cancelArchive(id); throw error; }
    if (frozen !== null) await formation.archived(id, frozen);
  };
  Object.defineProperty(registry, 'archiveSession', { configurable: true, writable: true, value: wrapped });
  ctx.effect(() => () => {
    if (Object.getOwnPropertyDescriptor(registry, 'archiveSession')?.value !== wrapped) return;
    if (own === undefined) Reflect.deleteProperty(registry, 'archiveSession');
    else Object.defineProperty(registry, 'archiveSession', own);
  });
  await formation.reconcileArchives(new Set(registry.archivedSessionIds));
}
