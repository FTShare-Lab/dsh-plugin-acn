// 每个场景都通过公开测试包启动独立进程，消费实际构建产物。
import { fileURLToPath } from 'node:url';
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke';
import { describe, expect, it } from 'vitest';

const host = fileURLToPath(new URL('./fixtures/host.ts', import.meta.url));
const patch = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url));
const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

describe('bundle composition', () => {
  it.each(['active', 'disabled', 'dispose', 'configured', 'calibrated', 'disabled_tools', 'disabled_prompt', 'disabled_commands', 'disabled_formation', 'disabled_inbox', 'disabled_dream'])('%s: real loader preserves the knowledge realm', async (scenario) => {
    const result = await runLoaderSmoke({
      label: `acn-${scenario}`,
      tempDirPrefix: 'acn-loader-',
      binScript: host,
      libBinScript: host,
      configPath: patch,
      binArgs: [patch, scenario],
      tsconfigPath: tsconfig,
      mode: 'lib',
      env: { DSH_TELEMETRY_DISABLED: 'true' },
    });
    expect(result.stdout).toContain(`ACN_SMOKE_OK:${scenario}`);
    if (scenario !== 'disabled') expect(result.stdout).toContain('ACN knowledge plugin activated.');
  });
});
