#!/usr/bin/env bash
# 构建固定参考版本，在隔离临时目录启动两个真实服务并运行契约测试。
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ACN_REPO:?Set ACN_REPO to the reference repository}"
ACN_REPO="$(cd "$ACN_REPO" && pwd)"
export ACN_REPO
python3 - "$ACN_REPO/Cargo.toml" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
version = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
if version is None or version.group(1) != '0.3.3':
    raise SystemExit('Contract baseline requires ACN 0.3.3; review changes before updating it.')
PY
if [[ -f "$ACN_REPO/export_env.sh" ]]; then
  source "$ACN_REPO/export_env.sh"
fi
cd "$ACN_REPO"
cargo build --locked --bin acn-router --bin acn-maintainer
cd "$task_root"
pnpm run build
node scripts/contract-services.mjs
