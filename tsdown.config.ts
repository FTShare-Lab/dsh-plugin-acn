// 只构建已经实现的公开入口，宿主运行时由 peer 依赖提供。
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { dream: 'src/dream/index.ts', 'plugins/dream': 'src/plugins/dream.ts', upload: 'src/upload/index.ts', inbox: 'src/inbox/index.ts', team: 'src/team/index.ts', 'plugins/inbox': 'src/plugins/inbox.ts', formation: 'src/formation/index.ts', 'plugins/formation': 'src/plugins/formation.ts', index: 'src/index.ts', 'plugins/knowledge': 'src/plugins/knowledge.ts', 'plugins/tools': 'src/plugins/tools.ts', 'plugins/prompt': 'src/plugins/prompt.ts', 'plugins/commands': 'src/plugins/commands.ts', protocol: 'src/protocol/index.ts', store: 'src/store/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  clean: true,
  dts: false,
});
