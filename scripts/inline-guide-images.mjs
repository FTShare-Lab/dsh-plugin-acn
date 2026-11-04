// 从已有截图刷新说明书的内嵌图片，保持单文件离线阅读与仓库图片一致。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'docs/user-guide.html');
let text = await fs.readFile(file, 'utf8');
const replacements = [...text.matchAll(/(<img\b[^>]*\bdata-asset="([a-z0-9-]+\.jpg)"[^>]*\bsrc=")([^"]*)(")/g)];
for (const match of replacements) {
  const bytes = await fs.readFile(join(root, 'docs/assets', match[2]));
  text = text.replace(match[0], match[1] + 'data:image/jpeg;base64,' + bytes.toString('base64') + match[4]);
}
await fs.writeFile(file, text);
process.stdout.write(`User guide images embedded: ${replacements.length}.\n`);
