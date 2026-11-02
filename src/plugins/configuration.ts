// 配置入口独立于知识服务，保存导致领域插件重载时网页连接仍然有效。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { configurationRemote } from '../dsh-adapter/configuration-remote.js';
import { ConfigurationService } from '../dsh-adapter/configuration-service.js';

export const name = 'acn-configuration';
export function apply(ctx: Context): void {
  // 终端和最小测试宿主可以没有网页配置服务。
  void ctx.inject(['configEditor', 'typert', 'llm', 'agents', 'sessions', 'tools'], (child) => {
    child.effect(() => child.typert.register({ package: 'dsh-plugin-acn', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: configurationRemote.descriptors }));
    child.plugin(ConfigurationService);
  });
}
export default { name, apply };
