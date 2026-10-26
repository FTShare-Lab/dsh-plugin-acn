// 主机与网页共用严格的 Remote 协议，通过宿主 Gateway 继承认证和访问边界。
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { ConfigurationResultSchema, ConfigurationSnapshotSchema, SaveConfigurationSchema } from '../configuration.js';

const request = { mode: 'strict' as const, typeSymbol: 'dsh-plugin-acn#SaveConfiguration', create: () => SaveConfigurationSchema };
export const configurationRemote = createTypertRemoteInfo({
  package: 'dsh-plugin-acn',
  methods: {
    'acnConfiguration/read': {
      service: 'acnConfiguration', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-plugin-acn#ConfigurationSnapshot', create: () => ConfigurationSnapshotSchema },
    },
    'acnConfiguration/save': {
      service: 'acnConfiguration', invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec: request, strictCodec: request }],
      result: { mode: 'strict', typeSymbol: 'dsh-plugin-acn#ConfigurationResult', create: () => ConfigurationResultSchema },
    },
  },
}, z);
