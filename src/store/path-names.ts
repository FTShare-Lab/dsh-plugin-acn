// Windows 设备名不能作为本地目录；协议 ID 和其他平台的既有名称保持不变。
import { StoreError } from './errors.js';
import { portableLocalName } from '../local-name.js';

export function invalidStorageName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && !portableLocalName(name);
}
export function assertStorageName(name: string): void {
  if (invalidStorageName(name)) throw new StoreError('io', 'Windows reserved names cannot be used for an Agent ID or upstream directory.');
}
