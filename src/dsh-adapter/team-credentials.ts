// 每次请求经宿主解析凭据引用；没有凭据服务的精简宿主保留环境变量兼容。
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types';
import type { CredentialResolver } from '../team/http.js';
import { ConfigError } from '../config.js';

export function credentialReference(reference: string): CredentialRef {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new ConfigError(['team.keyEnv']);
  // 宿主引用使用同一 POSIX 语法；只导入类型，使未挂载凭据服务的精简宿主仍可启动。
  return reference as CredentialRef;
}

export function teamCredentials(ctx: Context): CredentialResolver {
  return async (reference) => {
    const provider = ctx.get('credentials');
    return provider === undefined ? process.env[reference] : (await provider.resolve(credentialReference(reference)))?.value;
  };
}
