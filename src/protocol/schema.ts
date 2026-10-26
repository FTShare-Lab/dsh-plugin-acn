// 共用文本、可省略字段与旧字段别名的读取规则。
import { z } from 'zod';

export const TextSchema = z.string().refine((value) => !/[\uD800-\uDFFF]/u.test(value), 'Text must contain valid Unicode.');
export const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => value === null ? undefined : value, schema.optional());

export function withAliases<T extends z.ZodType>(schema: T, aliases: Readonly<Record<string, string>>) {
  return z.preprocess((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const record: Record<string, unknown> = { ...value };
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!Object.hasOwn(record, alias)) continue;
      if (Object.hasOwn(record, canonical)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate field: ${canonical}.` });
        return z.NEVER;
      }
      record[canonical] = record[alias];
      delete record[alias];
    }
    return record;
  }, schema);
}
