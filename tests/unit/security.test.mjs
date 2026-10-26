// 用运行时构造的数据验证扫描规则，测试文件本身不保存敏感样例。
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findViolations } from '../../scripts/check-security.mjs';

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
});
