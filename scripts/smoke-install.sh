#!/usr/bin/env bash
# 保留原有入口；平台无关的安装检查由 Node 执行。
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/smoke-install.mjs" "$@"
