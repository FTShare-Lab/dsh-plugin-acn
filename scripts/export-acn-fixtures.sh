#!/usr/bin/env bash
# 在临时 crate 中调用目标版本的公开类型，不修改被对照仓库。
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ACN_REPO:?Set ACN_REPO to the reference repository}"
ACN_REPO="$(cd "$ACN_REPO" && pwd)"
export ACN_FIXTURE_SOURCE_COMMIT="$(git -C "$ACN_REPO" rev-parse HEAD)"
export ACN_PLUGIN_FIXTURE_ROOT="$task_root"
task_temp="$(mktemp -d /tmp/acn-fixtures.XXXXXX)"
trap 'rm -rf "$task_temp"' EXIT
task_mode=export
task_output="$task_root/tests/fixtures/protocol"
if [[ "${1:-}" == --verify ]]; then
  task_mode=verify
  task_output="${2:?Expected the directory containing generated YAML}"
fi
mkdir -p "$task_temp/src"
cp "$task_root/scripts/fixtures/export.rs" "$task_temp/src/main.rs"
cp "$ACN_REPO/Cargo.lock" "$task_temp/Cargo.lock"
python3 - "$task_temp/Cargo.toml" "$ACN_REPO" <<'PY'
# 路径仅写入临时 manifest，不写入仓库或基准数据。
import json
import pathlib
import re
import sys
reference = pathlib.Path(sys.argv[2]).resolve()
version = re.search(r'^version\s*=\s*"([^"]+)"', (reference / 'Cargo.toml').read_text(), re.M)
if version is None or version.group(1) != '0.3.3':
    raise SystemExit('Expected reference version 0.3.3; review protocol compatibility before exporting.')
pathlib.Path(sys.argv[1]).write_text('''[package]
name = "acn-protocol-fixtures"
version = "0.1.0"
edition = "2021"
[dependencies]
agent-claim-network = { path = ''' + json.dumps(str(pathlib.Path(sys.argv[2]).resolve())) + ''' }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml_ng = "0.10"
chrono = "0.4"
''')
PY
task_output="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$task_output")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ACN_REPO/target}"
if [[ -f "$ACN_REPO/export_env.sh" ]]; then
  source "$ACN_REPO/export_env.sh"
fi
cd "$ACN_REPO"
cargo run --manifest-path "$task_temp/Cargo.toml" -- "$task_mode" "$task_output"
