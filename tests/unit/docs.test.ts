// 完整模板覆盖真实配置；双语入口指向维护中的指南，出现的 YAML 示例仍须合法。
import fs from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
function yamlBlocks(text: string): unknown[] { return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => parse(match[1] ?? '') as unknown); }
function knowledgeRows(value: unknown): { config: unknown }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row: unknown): row is { id: string; config: unknown } => typeof row === 'object' && row !== null && 'id' in row && row.id === 'acn-knowledge' && 'config' in row);
}
describe('current configuration documentation', () => {
  it('contains every default field in the complete template', async () => {
    const text = await fs.readFile(new URL('../../docs/config.md', import.meta.url), 'utf8');
    const complete = text.split('<!-- config:complete -->')[1]; if (complete === undefined) throw new Error('Missing complete configuration marker.');
    const row = knowledgeRows(yamlBlocks(complete)[0])[0]; if (row === undefined) throw new Error('Missing complete knowledge entry.');
    expect(row.config).toEqual({ ...resolveConfig({}), agentId: 'agent-a' }); expect(resolveConfig(row.config)).toEqual(row.config);
  });
  it.each(['README.md', 'README_EN.md', 'docs/config.md'])('validates every knowledge example in %s', async (file) => {
    const text = await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'); const rows = yamlBlocks(text).flatMap(knowledgeRows);
    if (file === 'docs/config.md') expect(rows.length).toBeGreaterThan(0);
    else {
      // README 采用网页安装流程，完整 YAML 只在配置参考中维护。
      expect(text).toContain('](docs/config.md)');
      expect(text).toContain('](docs/user-guide.md)');
      expect(text).toContain('](docs/user-guide.html)');
    }
    for (const row of rows) {
      const config = resolveConfig(row.config);
      if (config.upstreams === undefined) expect(config.agentId).toBe('agent-a');
      else expect(config.upstreams[config.upstream]?.agentId).toBeTruthy();
    }
  });
});
