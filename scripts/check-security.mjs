// 扫描版本控制范围内的文本，只报告位置，避免把可疑内容回显到日志。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const rules = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['literal-secret', /\b(?:api[_-]?key|acn_key|token|secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+/-]{20,}["']/i],
  ['private-domain', /\b(?:[a-z0-9-]+\.)+(?:internal|corp|lan|local)\b/i],
  ['personal-path', /\/(?:Users|home)\/(?!user(?:\/|\b)|example(?:\/|\b))[^/\s<>"']+/],
  ['email-address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['machine-temp-path', /\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+/],
];

export function findViolations(text) {
  return text.split('\n').flatMap((line, index) =>
    rules.filter(([, pattern]) => pattern.test(line)).map(([kind]) => ({ kind, line: index + 1 })),
  );
}

// 用户确认的邮箱可以出现在 Git 身份元数据中，文件正文仍执行完整隐私检查。
export function findIdentityViolations(text) {
  return findViolations(text).filter(({ kind }) => kind !== 'email-address');
}

async function main() {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  let count = 0;
  for (const path of stdout.split('\0').filter(Boolean)) {
    // 尚未暂存的文档删除仍在索引中；扫描工作区时跳过已不存在的文件。
    let content;
    try { content = await readFile(path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (content.includes(0)) continue;
    for (const violation of findViolations(content.toString('utf8'))) {
      process.stderr.write(`${path}:${violation.line}: ${violation.kind}\n`);
      count += 1;
    }
  }
  const { stdout: identities } = await promisify(execFile)('git', ['log', '--all', '--format=%H %ae %ce']);
  for (const violation of findIdentityViolations(identities)) {
    process.stderr.write(`git-identities:${violation.line}: ${violation.kind}\n`);
    count += 1;
  }
  if (count > 0) process.exitCode = 1;
  else process.stdout.write('Repository security scan passed.\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
