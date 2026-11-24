
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';

const sourceFolders = ['.github', 'src', 'core', 'electron', 'test', 'scripts', 'vendor', 'examples', 'assets'];
const sourceFiles = ['.gitattributes', '.gitignore', 'README.md', 'GETTING_STARTED.md', 'RELEASE-CHECKLIST.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'index.html', 'LICENSE', 'NOTICE'];
const marker = /[IE]:[\\/]+(?:豆包创作文档|Projects[\\/]+开源项目|tools[\\/]+(?:DSH|LocalModelLauncher)|AI频道)|C:[\\/]+Users[\\/]+Administrator|\u4ee4\u72d0\u5a49|[.]credentials[.]yaml|(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
const secretFile = /(?:^|[\\/])(?:_创作管理|test-output|\.runtime[^\\/]*|\.local-backups|\.env(?:\.[^\\/]*)?|credentials(?:\.[^\\/]*)?|secrets(?:\.[^\\/]*)?)(?:[\\/]|$)|\.(?:db|sqlite|encrypted|pfx|p12|bak-[0-9]+)(?:[\\/]|$)/iu;
function inspect(name, bytes) {
  assert.ok(!secretFile.test(name), '私有文件名出现在发布范围：' + name);
  if (!/\.(?:ico|png)$/iu.test(name)) assert.ok(!marker.test(bytes.toString('utf8')), '需人工检查发布文件：' + name);
}
async function walk(directory) {
  const files = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(name));
    else {
      assert.ok(item.isFile(), '发布文件应为普通文件：' + name);
      files.push(name);
    }
  }
  return files;
}
const files = [...sourceFiles, ...(await Promise.all(sourceFolders.map(walk))).flat()];
for (const name of files) inspect(name, await fs.readFile(name));
const out = process.argv[2] || 'release-public';
const resources = path.join(out, 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
const entries = listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
  .filter(file => !file.startsWith('node_modules'));
for (const name of entries) {
  assert.ok(!secretFile.test(name));
  if (/\.(?:js|mjs|cjs|py|html|css|json|txt)$/iu.test(name)) inspect(name, extractFile(archive, path.normalize(name)));
}
for (const file of await walk(path.join(resources, 'memlayer'))) inspect(file, await fs.readFile(file));
for (const file of await walk(path.join(resources, 'examples'))) inspect(file, await fs.readFile(file));
await fs.access(path.join(resources, 'python', 'LICENSE.txt'));
const packageInfo = JSON.parse(extractFile(archive, 'package.json'));
const sourceInfo = JSON.parse(await fs.readFile('package.json','utf8'));
assert.equal(packageInfo.version, sourceInfo.version, 'The installer must match the source version.');
assert.equal(packageInfo.license, 'Apache-2.0');
for (const file of ['LICENSE', 'NOTICE']) {
  assert.deepEqual(extractFile(archive, file), await fs.readFile(file));
}
const installer = 'StoryDesk-' + sourceInfo.version + '-win-x64.exe';
const signature = createHash('sha256').update(await fs.readFile(path.join(out, installer))).digest('hex');
await fs.writeFile(path.join(out, 'SHA256SUMS.txt'), signature + '  ' + installer + '\n');
console.log(JSON.stringify({ version: packageInfo.version, sourceFilesScanned: files.length,
  packageEntriesChecked: entries.length, installer, sha256: signature }, null, 2));
