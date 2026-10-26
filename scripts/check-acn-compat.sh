#!/usr/bin/env bash
# 先验证提交的基准报文，再由参考实现读回本次生成的 YAML。
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ACN_REPO:?Set ACN_REPO to the reference repository}"
cd "$task_root"
pnpm exec vitest run tests/compat/protocol.test.ts
bash scripts/export-acn-fixtures.sh --verify "$task_root/.artifacts/acn-roundtrip"
