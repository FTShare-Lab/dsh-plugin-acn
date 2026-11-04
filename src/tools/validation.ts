// 参数失败只返回字段位置和规则，不回显输入内容。
import type { z } from 'zod';
export function validationMessage(error: z.ZodError): string {
  return error.issues.slice(0, 8).map((issue) => {
    const field = issue.path.map(String).filter((part) => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$|^[0-9]+$/.test(part)).join('.') || '$';
    const rule = issue.code === 'invalid_type' ? `expected ${issue.expected}`
      : issue.code === 'too_small' ? `minimum ${String(issue.minimum)}` : issue.code === 'too_big' ? `maximum ${String(issue.maximum)}`
      : issue.code === 'invalid_value' ? `expected ${issue.values.map(String).join(' | ')}`
      : issue.code === 'unrecognized_keys' ? 'unexpected fields; use only fields for the selected action'
      : issue.code === 'invalid_format' ? `invalid ${issue.format} format` : 'does not match the required action or field rule';
    return `${field}: ${rule}`;
  }).join('; ');
}
