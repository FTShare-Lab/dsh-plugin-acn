// 检查文档链接与锚点，防止入口失效或截图不同步。
import fs from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function documents(directory) { const files = []; for (const item of await fs.readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) files.push(...await documents(path)); else if (['.md', '.html'].includes(extname(path))) files.push(path); } return files; }
const files = [...await documents(join(root, 'docs')), ...['README.md', 'README_EN.md', 'AGENTS.md', 'CHANGELOG.md'].map((name) => join(root, name))];
const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
const errors = [];
const anchors = new Map();
async function documentAnchors(file) {
  if (!anchors.has(file)) {
    const text = await fs.readFile(file, 'utf8');
    anchors.set(file, extname(file) === '.html' ? [...new JSDOM(text).window.document.querySelectorAll('[id]')].map((node) => node.id) : [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map((item) => slug(item[1])));
  }
  return anchors.get(file);
}
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  let targets;
  if (extname(file) === '.html') {
    const dom = new JSDOM(text); const document = dom.window.document;
    targets = [...document.querySelectorAll('[href], [src]')].flatMap((node) => ['href', 'src'].map((name) => node.getAttribute(name)).filter((value) => value !== null));
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    if (new Set(ids).size !== ids.length) errors.push(`${relative(root, file)}: duplicate HTML id`);
    dom.window.close();
  } else targets = [...text.matchAll(/\]\(([^\s)]+)\)/g)].map((match) => match[1]);
  for (const target of targets) {
    if (/^(?:https?:|mailto:|data:)/.test(target)) continue;
    const [path, anchor] = target.split('#'); const destination = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    try {
      await fs.access(destination);
      if (anchor && ['.md', '.html'].includes(extname(destination))) {
        if (!(await documentAnchors(destination)).includes(decodeURIComponent(anchor))) errors.push(`${relative(root, file)}: missing anchor ${target}`);
      }
    } catch { errors.push(`${relative(root, file)}: missing target ${target}`); }
  }
}
if (errors.length > 0) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(`Documentation links and anchors verified: ${files.length} documents.\n`);
