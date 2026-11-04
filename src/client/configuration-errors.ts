// 配置错误展示字段和填写规则，避免回显可能包含凭据的输入值。
import type { Copy } from './interaction-ui.js';
export function configurationFieldError(path: string, c: Copy): string {
  const field = path.split('.').at(-1) ?? path;
  const messages: Record<string, string> = {
    agentId: c('Agent ID：只能使用小写字母、数字、下划线或连字符。', 'Agent ID: use lowercase letters, numbers, underscores or hyphens.'),
    key: c('配置标识：使用小写字母、数字、下划线或连字符，避开 data、skills、logs、tmp 等保留名称。', 'Configuration key: use lowercase letters, numbers, underscores or hyphens; avoid reserved names such as data, skills, logs and tmp.'),
    name: c('显示名称：不能超过 80 个字符。', 'Display name: must not exceed 80 characters.'),
    timeoutMs: c('团队请求超时：必须为正整数，单位为毫秒。', 'Team request timeout: use a positive integer in milliseconds.'),
    keyEnv: c('密钥环境变量名：使用字母、数字和下划线，不能以数字开头；不要填写密钥正文。', 'Key environment variable: use letters, numbers and underscores, without a leading digit; enter the variable name, not the key value.'),
    routerEndpoint: c('Router 地址：以 http:// 或 https:// 开头，不含用户名、密码、查询参数或片段；两项团队地址需同时填写或留空。', 'Router URL: use http:// or https:// without username, password, query or fragment; set both team URLs or leave both empty.'),
    maintainerEndpoint: c('Maintainer 地址：以 http:// 或 https:// 开头，不含用户名、密码、查询参数或片段；两项团队地址需同时填写或留空。', 'Maintainer URL: use http:// or https:// without username, password, query or fragment; set both team URLs or leave both empty.'),
    home: c('知识目录：请填写非空的本机目录路径。', 'Knowledge directory: enter a nonempty host directory path.'),
    upstream: c('默认工作配置：请选择已启用的配置。', 'Default work configuration: choose an enabled configuration.'),
  };
  return messages[field] ?? `${c('请检查配置字段', 'Check configuration field')}: ${path || c('工作配置', 'Work configuration')}`;
}
