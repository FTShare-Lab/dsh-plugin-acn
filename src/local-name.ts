// 本地目录标识在两个桌面平台都须可用，不改变远端协议中的 Agent ID。
export function portableLocalName(value: string): boolean { return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value); }
