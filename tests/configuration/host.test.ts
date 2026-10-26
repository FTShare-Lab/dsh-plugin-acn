// 在独立宿主进程中验证真实 profile 编辑器、Loader 重载和磁盘竞争。
import { fileURLToPath } from 'node:url';
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke';
import { expect, it } from 'vitest';

it('persists and reloads configuration through the real profile editor', async () => {
  const host = fileURLToPath(new URL('./host.ts', import.meta.url));
  const result = await runLoaderSmoke({ label: 'acn-configuration', tempDirPrefix: 'acn-configuration-', binScript: host, libBinScript: host, configPath: fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)), tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), mode: 'lib', env: { DSH_TELEMETRY_DISABLED: 'true' } });
  expect(result.stdout).toContain('ACN_CONFIGURATION_OK');
});
