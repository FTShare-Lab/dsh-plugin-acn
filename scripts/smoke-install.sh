#!/usr/bin/env bash
# 保留旧脚本入口，安装验收主体使用跨平台 Node 实现。
set -euo pipefail
node "$(dirname "${BASH_SOURCE[0]}")/smoke-install.mjs" "$@"
