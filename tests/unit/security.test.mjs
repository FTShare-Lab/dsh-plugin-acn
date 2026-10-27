// 用运行时构造的数据验证扫描规则，测试文件本身不保存敏感样例。
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { findIdentityViolations, findViolations } from '../../scripts/check-security.mjs';

describe('repository security scan', () => {
  it('finds literal credentials without returning their contents', () => {
    const generated = randomBytes(24).toString('hex');
    const result = findViolations(`api_key = "${generated}"`);
    expect(result).toEqual([{ kind: 'literal-secret', line: 1 }]);
    expect(JSON.stringify(result)).not.toContain(generated);
  });

  it('finds private domains and personal home paths', () => {
    const domain = ['service', 'inter' + 'nal'].join('.');
    const path = ['Users', 'actual' + 'account', 'data'].join('/');
    expect(findViolations(`${domain}\n/${path}`).map((item) => item.kind))
      .toEqual(['private-domain', 'personal-path']);
  });

  it('allows environment references, neutral paths, and reserved domains', () => {
    expect(findViolations('keyEnv: ACN_TEAM_KEY\nhttp://127.0.0.1\nhttps://example.com\n/home/user/data'))
      .toEqual([]);
  });

  it('rejects email addresses and machine-specific temporary paths without echoing them', () => {
    const address = ['person', 'example.com'].join('@');
    const path = ['', 'var', 'folders', 'ab', randomBytes(16).toString('hex'), 'T'].join('/');
    const result = findViolations(`${address}\n${path}\n/private${path}`);
    expect(result).toEqual([
      { kind: 'email-address', line: 1 },
      { kind: 'machine-temp-path', line: 2 },
      { kind: 'machine-temp-path', line: 3 },
    ]);
    expect(JSON.stringify(result)).not.toContain(address);
    expect(JSON.stringify(result)).not.toContain(path);
  });

  it('keeps private domain and path checks for Git identity metadata', () => {
    const address = ['contributor', ['mail', 'inter' + 'nal'].join('.')].join('@');
    const path = ['Users', 'fixture-account', 'data'].join('/');
    expect(findIdentityViolations(`${address}\n/${path}`)).toEqual([
      { kind: 'private-domain', line: 1 },
      { kind: 'personal-path', line: 2 },
    ]);
  });

  it('allows Git email metadata while still rejecting emails in tracked file content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'identity-scan-'));
    const address = ['contributor', 'example.com'].join('@');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Example contributor', GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_NAME: 'Example contributor', GIT_COMMITTER_EMAIL: address };
    const execute = promisify(execFile);
    const options = { cwd: directory, env };
    const script = fileURLToPath(new URL('../../scripts/check-security.mjs', import.meta.url));
    try {
      await execute('git', ['init', '--quiet'], options);
      await writeFile(join(directory, 'README.md'), '# Example\n');
      await execute('git', ['add', 'README.md'], options);
      await execute('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '--quiet', '-m', 'initial fixture'], options);
      const result = await execute(process.execPath, [script], options);
      expect(result.stdout).toContain('Repository security scan passed.');
      await writeFile(join(directory, 'README.md'), `${address}\n`);
      await expect(execute(process.execPath, [script], options)).rejects.toMatchObject({ code: 1, stderr: 'README.md:1: email-address\n' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
