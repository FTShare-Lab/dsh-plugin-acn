// 开发脚本统一启动原生可执行文件与 Windows 命令 shim，避免自行拼接 Shell 参数。
import spawn from 'cross-spawn';

export function commandFor(command, args = []) { return /\.(?:mjs|cjs|js)$/i.test(command) ? [process.execPath, [command, ...args]] : [command, args]; }

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(...commandFor(command, args), { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); }); child.stderr.on('data', (data) => { stderr += String(data); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else { const error = new Error(`Command failed: ${command} (${code})\n${stderr}`); error.code = code; error.stdout = stdout; error.stderr = stderr; reject(error); }
    });
  });
}
