
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('这个安装包使用 Windows x64 的嵌入运行时。');
const run = promisify(execFile);
const root = fileURLToPath(new URL('../.build-runtime/', import.meta.url));
const output = path.join(root, 'python');
const filename = 'python-3.13.17-embed-amd64.zip';
const archive = path.join(root, filename);
const expected = '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(output, { recursive: true });
let bytes;
try { bytes = await fs.readFile(archive); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch('https://www.python.org/ftp/python/3.13.17/' + filename, {
    signal: AbortSignal.timeout(60000), redirect: 'error',
  });
  if (!response.ok) throw new Error('无法下载 Python 嵌入包，状态 ' + response.status);
  bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error('下载的 Python 嵌入包与官方 SHA-256 不符。');
  await fs.writeFile(archive, bytes, { flag: 'wx' });
}
if (digest(bytes) !== expected) throw new Error('缓存的 Python 嵌入包与官方 SHA-256 不符。');
await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
  ['-xf', archive, '-C', output], { windowsHide: true });
const { stdout } = await run(path.join(output, 'python.exe'), ['--version'], { windowsHide: true });
console.log(stdout.trim());
