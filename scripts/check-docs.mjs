// 检查仓库内文档链接和锚点，防止整理目录后留下失效入口。
import fs from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function markdown(directory) { const files = []; for (const item of await fs.readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) files.push(...await markdown(path)); else if (item.name.endsWith('.md')) files.push(path); } return files; }
const files = [...await markdown(join(root, 'docs')), ...['README.md', 'README_EN.md', 'AGENTS.md', 'CHANGELOG.md'].map((name) => join(root, name))];
const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
const errors = [];
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1]; if (/^(?:https?:|mailto:|data:)/.test(target)) continue;
    const [path, anchor] = target.split('#'); const destination = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    try {
      await fs.access(destination);
      if (anchor && extname(destination) === '.md') {
        const content = (await fs.readFile(destination, 'utf8')).replace(/```[\s\S]*?```/g, '');
        const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((item) => slug(item[1]));
        if (!headings.includes(decodeURIComponent(anchor))) errors.push(`${relative(root, file)}: missing anchor ${target}`);
      }
    } catch { errors.push(`${relative(root, file)}: missing target ${target}`); }
  }
}
if (errors.length > 0) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(`Documentation links verified: ${files.length} Markdown files.\n`);
