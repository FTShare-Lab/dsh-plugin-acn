// 为只转发根字段的模型适配器展开动作参数，同时保留完整联合约束。
import { z } from 'zod';

const JsonObject = z.record(z.string(), z.json());

export function toolParameters(schema: z.ZodType): z.infer<typeof JsonObject> {
  // 生成器附带非枚举校验元数据；跨宿主边界只传 JSON。
  const root = JsonObject.parse(JSON.parse(JSON.stringify(z.toJSONSchema(schema))));
  if (!Array.isArray(root.oneOf)) return root;
  const variants = root.oneOf.map((value) => JsonObject.parse(value));
  const fields = variants.map((variant) => JsonObject.parse(variant.properties));
  const keys = [...new Set(fields.flatMap((field) => Object.keys(field)))];
  const properties = Object.fromEntries(keys.map((key) => {
    const distinct = [...new Map(fields.filter((field) => field[key] !== undefined)
      .map((field) => [JSON.stringify(field[key]), JsonObject.parse(field[key])])).values()];
    const values = distinct.map((field) => field.const);
    const combined = distinct.length === 1 ? distinct[0]
      : values.every((value) => typeof value === 'string') ? { type: 'string', enum: values }
        : { anyOf: distinct };
    return [key, combined];
  }));
  const requiredSets = variants.map((variant) => z.array(z.string()).parse(variant.required ?? []));
  const required = (requiredSets[0] ?? []).filter((key) => requiredSets.every((set) => set.includes(key)));
  return JsonObject.parse({ ...root, type: 'object', properties, required });
}
