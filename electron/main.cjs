const { app, BrowserWindow, ipcMain, dialog, safeStorage, protocol, net, shell, nativeImage } = require('electron');
const { Worker } = require('node:worker_threads');
const { localModels, localStatus, localStart, localStop } = require('./local-models.cjs');
const { resolveSpeechRuntime, findSpeechRuntime, transcribeSpeech } = require('./local-speech.cjs');
const { ensureMemlayer, closeMemlayer, bundledRuntime } = require('./memlayer-runtime.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('node:net');
const { pathToFileURL } = require('node:url');
const windowAppearance = require('../core/window-appearance.json');
const nativeCaption = process.platform === 'win32';
const captionHeight = 32;
const captionOptions = palette => ({ color: palette.caption, symbolColor: palette.ink, height: captionHeight });

const root = path.resolve(__dirname, '..');
const resources = app.isPackaged ? process.resourcesPath : null;
let bundled = bundledRuntime(resources, root);
process.env.STORYDESK_BUNDLED_PYTHON = bundled.python;
if (process.env.NOVEL_TEST_MODE) app.disableHardwareAcceleration();
if (process.env.NOVEL_USER_DATA) app.setPath('userData', process.env.NOVEL_USER_DATA);
else if (!app.isPackaged) app.setPath('userData', path.join(root, '.runtime'));
else app.setPath('userData', path.join(app.getPath('appData'), '创作协作台开源版'));
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  return;
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'storydesk', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'storydesk-map', privileges: { standard: true, secure: true } },
]);
const {publishRenderer}=require('./renderer-events.cjs');
let window, worker, nextId = 0, activeWork = null, quitting = false;
let focusRequested = false;
function focusMainWindow() {
  if (!window || window.isDestroyed()) { focusRequested = true; return; }
  focusRequested = false;
  if (window.isMinimized()) window.restore();
  if (!process.env.NOVEL_TEST_MODE) window.show();
  window.focus();
}
app.on('second-instance', focusMainWindow);
const pending = new Map(); let registry = { works: [], lastRoot: null }; let notifyTimer;
const networkControllers = new Map();
let localModelChanging = false;
const blockedDuringModelChange = new Set(['chooseWork', 'openWork', 'newWork', 'sendCowriting', 'testModel', 'checkManuscript',
  'suggestManuscriptEdit', 'startBookReview', 'startBookSemanticReview', 'checkObligations', 'reviewObligation', 'restartJob', 'generateRevision', 'confirmRevision']);
async function changeLocalModel(workId, operation) {
  if (localModelChanging) throw new Error('正在处理本机模型，请稍候。');
  if (workId !== activeWork || !activeWork) throw new Error('请先选择当前作品。');
  localModelChanging = true;
  try { await rpc('checkModelIdle', {}, workId); return await operation(); }
  finally { localModelChanging = false; }
}
let recognizingSpeech = false;
let memorySettings, modelStateFile, approvedModelBase = '';
const startMemory = settings => ensureMemlayer(settings, app.getPath('userData'), bundled).catch(() => {});
async function flushRenderer() {
  if (!window || window.isDestroyed()) return { ok: true };
  return new Promise(resolve => {
    const id = `flush-${++nextId}`;
    const done = value => { clearTimeout(timer); ipcMain.removeListener('storydesk:flush-result', listener); resolve(value); };
    const listener = (event, result) => { if (event.sender === window.webContents && result.id === id) done(result); };
    const timer = setTimeout(() => done({ ok: false, error: '编辑器未能及时保存恢复草稿' }), 8000);
    ipcMain.on('storydesk:flush-result', listener); window.webContents.send('storydesk:flush', id);
  });
}
async function allowCloseAfterFlush() {
  const result = await flushRenderer(); if (result.ok) return true;
  const choice = await dialog.showMessageBox(window, { type: 'warning', title: '恢复草稿尚未保存', message: '当前恢复草稿无法保存', detail: result.error || '请保留程序并检查文件存储位置。', buttons: ['留在程序', '仍然退出'], defaultId: 0, cancelId: 0 });
  return choice.response === 1;
}
const statePath = name => path.join(app.getPath('userData'), name);
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; await fs.writeFile(tmp, JSON.stringify(data, null, 2)); await fs.rename(tmp, file); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function rpc(method, args = {}, expectedWorkId = null) {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args, expectedWorkId }); });
}
const digest = value => createHash('sha256').update(value).digest('hex');
function modelKeyPath(base) { return statePath('model-key-' + digest(modelStateFile + '\0' + base) + '.encrypted'); }
async function getKey(workId = activeWork, base = approvedModelBase) {
  if (!modelStateFile || workId !== activeWork || !base || base !== approvedModelBase) return '';
  let bytes;
  try { bytes = await fs.readFile(modelKeyPath(base)); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  return safeStorage.decryptString(bytes);
}
async function setKey(key) {
  if (!modelStateFile || !approvedModelBase) throw new Error('请先保存模型地址');
  const file = modelKeyPath(approvedModelBase);
  if (typeof key !== 'string' || key.length > 10000) throw new Error('密钥格式无效');
  if (!key) { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); return; }
  const available = safeStorage.isEncryptionAvailable();
  if (!available) throw new Error('系统加密服务不可用，密钥未保存');
  const bytes = safeStorage.encryptString(key);
  await fs.writeFile(file, bytes);
}
// ── 本地 llama.cpp 一键启停 ──────────────────────────────────────────
// 每个 start-*.bat 用的端口可能不同（实测 8090/8091/8092/8093），
// 所以端口一律从 bat 里的 --port 解析，找不到才用默认 8090。
async function openWork(workRoot) {
  const resolved = await fs.realpath(workRoot);
  if (activeWork) await rpc('checkModelIdle', {}, activeWork);
  const { models } = await localModels().catch(() => ({ models: [] }));
  let summary = await rpc('init', { root: resolved, localPresets: models });
  activeWork = summary.id;
  if (!summary.settings.memlayer && !process.env.NOVEL_TEST_MODE) {
    const memlayer = { enabled: true, baseUrl: 'http://127.0.0.1:' + bundled.port, sharedProject: '' };
    summary = await rpc('updateSettings', { memlayer }, activeWork);
  }
  modelStateFile = statePath('model-connection-' + digest(resolved.toLowerCase() + '\0' + summary.id) + '.json');
  approvedModelBase = (await readJson(modelStateFile, {})).base || '';
  memorySettings = summary.settings.memlayer;
  void startMemory(memorySettings);
  registry.works = [...registry.works.filter(w => w.root.toLowerCase() !== resolved.toLowerCase()), { id: summary.id, name: summary.name, root: resolved, opened_at: new Date().toISOString() }]; registry.lastRoot = resolved;
  await writeJson(statePath('works.json'), registry); return summary;
}
async function allocateLocalPort() {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}
app.whenReady().then(async () => {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const bindingPath = statePath('bundled-memory.json');
  const binding = await readJson(bindingPath, {});
  if (!Number.isInteger(binding.port) || binding.port < 1024 || binding.port > 65535) {
    binding.port = await allocateLocalPort();
    await writeJson(bindingPath, binding);
  }
  bundled = bundledRuntime(resources, root, binding.port);
  protocol.handle('storydesk', request => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = path.resolve(root, 'dist', `.${pathname === '/' ? '/index.html' : pathname}`);
    const relative = path.relative(path.join(root, 'dist'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const mapFormats = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  protocol.handle('storydesk-map', async request => {
    const url = new URL(request.url);
    const [, workId, documentId] = url.pathname.split('/');
    if (request.method !== 'GET' || url.host !== 'preview' || !activeWork || workId !== activeWork ||
        !/^doc_[\w-]+$/u.test(documentId || '') || url.pathname !== `/${workId}/${documentId}`) return new Response(null, { status: 403 });
    try {
      const file = await rpc('mapPreviewPath', { documentId }, workId);
      const type = mapFormats[path.extname(file).toLowerCase()];
      if (!type || workId !== activeWork) return new Response(null, { status: 404 });
      const stream = await net.fetch(pathToFileURL(file).toString());
      return new Response(stream.body, { status: stream.status, headers: {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'",
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  registry = await readJson(statePath('works.json'), registry);
  let { theme: currentTheme } = await readJson(statePath('appearance.json'), { theme: 'light' });
  if (!Object.hasOwn(windowAppearance, currentTheme)) currentTheme = 'light';
  let appearanceSave = Promise.resolve();
  const startupPalette = windowAppearance[currentTheme];
  const { MODEL_REQUEST_BODY_LIMIT, permitsModelRequest, isLocalModelUrl, connectionBase } = await import('../core/model-connections.mjs');
  const { RESEARCH_MCP_URL, publicSourceUrl } = await import('../core/research-search.mjs');
  worker = new Worker(path.join(__dirname, 'worker.mjs'));
  worker.on('message', async message => {
    if (message.type === 'networkCancel') { networkControllers.get(message.id)?.abort(); }
    else if (message.type === 'network') {
      const controller = new AbortController(); networkControllers.set(message.id, controller);
      let headersReceived = false;
      try {
        const url = new URL(message.url);
        const research = url.href === RESEARCH_MCP_URL;
        if (!research && (message.workId !== activeWork || !permitsModelRequest(url, message.method, approvedModelBase))) {
          throw Object.assign(new Error('请在作品设置中保存并授权当前模型连接。'), { code: 'NET_MODEL_CONNECTION' });
        }
        const isModelList = message.method === 'GET' && /\/models\/?$/.test(url.pathname);
        const writingStream = message.streamResponse === true && !research && !isModelList;
        if (!isModelList && (message.method !== 'POST' || typeof message.body !== 'string' ||
            (!writingStream && message.body.length > (research ? 1500 : MODEL_REQUEST_BODY_LIMIT)))) {
          throw new Error('请求格式无效');
        }
        const headers = research ? { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } : { ...message.headers };
        if (!research && isLocalModelUrl(url) && !url.href.startsWith(approvedModelBase + '/')) delete headers.Authorization;
        const response = await net.fetch(url.href, { method: message.method, headers, redirect: 'error',
          ...(isModelList ? {} : { body: message.body }), ...(research ? { credentials: 'omit' } : {}), signal: controller.signal });
        headersReceived = true;
        const responseHeaders = Object.fromEntries(['content-type','date','retry-after','x-request-id','x-ratelimit-remaining-requests','x-ratelimit-reset-requests']
          .map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null));
        const streamed = writingStream && response.ok && !!response.body;
        if (streamed) worker.postMessage({ type: 'networkHead', id: message.id, status: response.status, headers: responseHeaders });
        const reader = response.body?.getReader();
        const chunks = [];
        let length = 0;
        const limit = research ? 600000 : 2000000;
        if (reader) while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (!streamed && length > limit) {
            controller.abort();
            worker.postMessage({ type: 'networkResult', id: message.id, error: '模型响应超过本机接收上限', code: 'NET_RESPONSE_LIMIT' });
            return;
          }
          if (streamed) worker.postMessage({ type: 'networkChunk', id: message.id, bytes: value });
          else chunks.push(Buffer.from(value));
        }
        if (streamed) worker.postMessage({ type: 'networkEnd', id: message.id });
        else worker.postMessage({ type: 'networkResult', id: message.id, status: response.status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        const transport = String(error?.code || error?.message).match(/\b(?:ERR_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH))\b/u)?.[0];
        const restricted = error.code === 'NET_MODEL_CONNECTION';
        const reason = restricted ? error.message : headersReceived ? '接收模型响应时连接中断' : '未能连接模型服务';
        worker.postMessage({ type: 'networkResult', id: message.id,
          error: controller.signal.aborted ? '模型请求已取消' : reason + (transport ? `（${transport}）` : ''),
          code: controller.signal.aborted ? 'NET_CANCELLED' : restricted ? error.code : headersReceived ? 'NET_STREAM_INTERRUPTED' : 'NET_CONNECT' });
      }
      finally { networkControllers.delete(message.id); }
    } else if (message.type === 'key') {
      try { worker.postMessage({ type: 'keyResult', id: message.id, key: await getKey(message.workId, message.base) }); } catch (e) { worker.postMessage({ type: 'keyResult', id: message.id, error: e.message }); }
    } else if (message.type === 'event') {
      if (quitting) return;
      if (message.event?.type === 'cowriting-progress') {
        publishRenderer(window, message.event);
      } else {
        clearTimeout(notifyTimer); notifyTimer = setTimeout(() => publishRenderer(window,message.event), 180);
      }
    } else {
      const p = pending.get(message.id); if (!p) return; pending.delete(message.id);
      message.error ? p.reject(Object.assign(new Error(message.error.message), message.error)) : p.resolve(message.result);
    }
  });
  worker.on('error', e => { for (const p of pending.values()) p.reject(e); pending.clear(); publishRenderer(window, { type: 'fatal', message: '本地数据服务中断，请重启程序。' }); });
  window = new BrowserWindow({ width: 1480, height: 980, minWidth: 1080, minHeight: 720, backgroundColor: startupPalette.ground,
    ...(nativeCaption ? { titleBarStyle: 'hidden', titleBarOverlay: captionOptions(startupPalette) } : {}),
    title: '章间', show: !process.env.NOVEL_TEST_MODE, autoHideMenuBar: true, icon: path.join(root,'assets/workbench-mark.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, offscreen: !!process.env.NOVEL_TEST_MODE } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('storydesk://app/')) event.preventDefault(); });
  const trustedMediaFrame = (wc, details) => wc === window?.webContents && details.isMainFrame === true
    && (details.requestingUrl === 'storydesk://app/index.html' || details.securityOrigin === 'storydesk://app');
  window.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(
    permission === 'media' && trustedMediaFrame(wc, details) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));
  window.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permission === 'media' && trustedMediaFrame(wc, details) && details.mediaType === 'audio');
  let closeReady = false, closePending = false;
  window.on('close', event => {
    if (quitting || closeReady) return; event.preventDefault(); if (closePending) return; closePending = true;
    allowCloseAfterFlush().then(ok => { closePending = false; if (ok) { closeReady = true; window.close(); } });
  });
  window.on('closed',()=>{clearTimeout(notifyTimer);window=null;});
  const MAIN_METHODS = new Set(['appInfo', 'bootstrap', 'listWorks', 'chooseWork', 'openWork', 'newWork', 'newDemoWork', 'setKey', 'keyStatus', 'openSource', 'openWebSource', 'export', 'pickPython', 'localModels', 'localStart', 'localStop', 'localStatus', 'selectWritingModel', 'pickMaterial']);
  for (const name of ['setWindowTheme', 'speechStatus', 'pickSpeechRuntime', 'transcribeSpeech', 'pickManuscript', 'importTexts', 'pickConversationImages', 'revealSource']) MAIN_METHODS.add(name);
  ipcMain.handle('storydesk:call', async (event, request) => {
    try {
      if (event.sender !== window.webContents || !event.senderFrame.url.startsWith('storydesk://app/')) throw new Error('请求来源无效');
      const { method, args = {}, workId } = request || {};
      if (localModelChanging && blockedDuringModelChange.has(method)) throw new Error('正在切换本机模型，请稍候。');
      if (typeof method !== 'string') throw new Error('请求格式无效');
      if (MAIN_METHODS.has(method)) {
        let result;
        if (method === 'appInfo') result = { version: app.getVersion(), packaged: app.isPackaged, nativeCaption, captionHeight };
        else if (method === 'setWindowTheme') {
          const theme = args.theme;
          if (typeof theme !== 'string' || !Object.hasOwn(windowAppearance, theme)) throw new Error('工作台外观无效');
          const palette = windowAppearance[theme];
          window.setBackgroundColor(palette.ground);
          if (nativeCaption) window.setTitleBarOverlay(captionOptions(palette));
          if (theme !== currentTheme) {
            currentTheme = theme;
            appearanceSave = appearanceSave.catch(() => {}).then(() => writeJson(statePath('appearance.json'), { theme }));
            await appearanceSave;
          }
          result = { theme, nativeCaption };
        }
        else if (method === 'bootstrap') {
          const workRoot = registry.lastRoot || process.env.NOVEL_DEFAULT_WORK;
          try { result = workRoot ? await openWork(workRoot) : { needsWork: true, works: registry.works }; }
          catch (e) { result = { needsWork: true, error: e.message, works: registry.works }; }
        } else if (method === 'listWorks') result = registry.works;
        else if (method === 'openWork') {
          const registered = registry.works.find(w => w.id === args.id); if (!registered) throw new Error('作品未登记，请使用选择目录'); result = await openWork(registered.root);
        } else if (method === 'chooseWork') {
          const picked = await dialog.showOpenDialog(window, { title: '选择作品资料根目录', properties: ['openDirectory'] }); result = picked.canceled ? null : await openWork(picked.filePaths[0]);
        } else if (method === 'newWork') {
          if (typeof args.name !== 'string' || !args.name.trim() || /[<>:"/\\|?*\r\n]/.test(args.name) || args.name.length > 100) throw new Error('作品名称无效');
          const picked = await dialog.showOpenDialog(window, { title: '选择新作品的存放位置', properties: ['openDirectory'] });
          if (!picked.canceled) {
            const target = path.join(picked.filePaths[0], args.name.trim()); await fs.mkdir(target);
            for (const folder of ['正文', '草稿章节', '人物', '设定', '资料']) await fs.mkdir(path.join(target, folder)); result = await openWork(target);
          } else result = null;
        } else if (method === 'newDemoWork') {
          const picked = await dialog.showOpenDialog(window, { title: '选择示例作品的保存位置', properties: ['openDirectory'] });
          if (picked.canceled) result = null;
          else {
            const example = path.join(resources || root, 'examples', '北岸电台');
            const target = path.join(picked.filePaths[0], '北岸电台（示例）');
            await fs.mkdir(target);
            for (const name of await fs.readdir(example)) {
              await fs.cp(path.join(example, name), path.join(target, name),
                { recursive: true, force: false, errorOnExist: true });
            }
            result = await openWork(target);
          }
        } else if (method === 'setKey') {
          if (workId !== activeWork || connectionBase(args.baseUrl) !== approvedModelBase) throw new Error('请先保存当前模型连接');
          await setKey(args.key); result = { configured: !!args.key };
        }
        else if (method === 'speechStatus') {
          const config = await readJson(statePath('speech-runtime.json'), {});
          result = { available: !!await findSpeechRuntime(config.root), engine: 'SenseVoice' };
        } else if (method === 'pickSpeechRuntime') {
          const picked = await dialog.showOpenDialog(window, { title: '选择已安装 SenseVoice 的目录', properties: ['openDirectory'] });
          if (picked.canceled) result = null;
          else {
            const root = picked.filePaths[0];
            if (!await resolveSpeechRuntime(root)) throw new Error('该目录未发现 SenseVoice 运行组件和模型文件');
            await writeJson(statePath('speech-runtime.json'), { root });
            result = { available: true, engine: 'SenseVoice' };
          }
        } else if (method === 'transcribeSpeech') {
          if (!activeWork || workId !== activeWork) throw new Error('作品已切换，请在当前对话重新录音');
          if (recognizingSpeech) throw new Error('正在识别上一段语音');
          recognizingSpeech = true;
          try {
            const config = await readJson(statePath('speech-runtime.json'), {});
            result = await transcribeSpeech(args.audio, await findSpeechRuntime(config.root));
          } finally { recognizingSpeech = false; }
        }
        else if (method === 'keyStatus') {
          try {
            const base = connectionBase(args.baseUrl) || approvedModelBase;
            result = { configured: !!await getKey(workId, base), authorized: !!base && workId === activeWork && base === approvedModelBase };
          } catch { result = { configured: false, authorized: false, unavailable: true }; }
        }
        else if (method === 'openSource') {
          const p = await rpc('sourcePath', args, workId); const error = await shell.openPath(p); if (error) throw new Error(error); result = true;
        } else if (method === 'revealSource') {
          if (!activeWork || workId !== activeWork) throw new Error('作品已切换，请重新选择文件');
          const file = await rpc('sourcePath', { documentId: args.documentId }, workId);
          if (workId !== activeWork) throw new Error('作品已切换，请重新选择文件');
          shell.showItemInFolder(file);
          result = true;
        } else if (method === 'openWebSource') {
          const url = publicSourceUrl(args.url);
          if (!url || !activeWork || workId !== activeWork) throw new Error('无法打开该出处，请核对地址和当前作品。');
          await shell.openExternal(url);
          result = true;
        } else if (method === 'pickConversationImages') {
          if (workId !== activeWork) throw new Error('请先选择本作品');
          const selected = await dialog.showOpenDialog(window, { title: '添加对话图片', properties: ['openFile', 'multiSelections'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
          result = [];
          if (!selected.canceled) {
            const limit = Math.max(1, Math.min(4, Math.floor(Number(args.limit)) || 4));
            if (selected.filePaths.length > limit) throw new Error(`本轮最多再添加 ${limit} 张图片`);
            for (const file of selected.filePaths) {
              if ((await fs.stat(file)).size > 12_000_000) throw new Error('请选小于 12 MB 的图片');
              let image = nativeImage.createFromBuffer(await fs.readFile(file), { scaleFactor: 1 });
              if (image.isEmpty()) throw new Error('无法识别这张图片');
              const size = image.getSize();
              if (size.width > 1800 || size.height > 1800) image = image.resize(size.width >= size.height ? { width: 1800 } : { height: 1800 });
              result.push({ name: path.basename(file), mimeType: 'image/jpeg', data: image.toJPEG(84).toString('base64') });
            }
            if (workId !== activeWork) throw new Error('作品已切换，请重新选择图片');
          }
        } else if (method === 'pickManuscript' || method === 'importTexts') {
          const current = registry.works.find(work => work.id === activeWork && work.id === workId);
          if (!current) throw new Error('请先选择本作品');
          const importing = method === 'importTexts';
          const { textFileExtensions, readSelectedText } = await import('../core/text-import.mjs');
          const picked = await dialog.showOpenDialog(window, {
            title: importing ? '导入 Markdown 或 TXT 到作品资料库' : '选择要核对的 Markdown 或纯文本稿件',
            ...(importing ? { defaultPath: current.root } : {}),
            properties: importing ? ['openFile', 'multiSelections'] : ['openFile'],
            filters: [{ name: 'Markdown 和 TXT', extensions: textFileExtensions }],
          });
          result = null;
          if (!picked.canceled) {
            if (activeWork !== workId) throw new Error('作品已切换，请重新选择文件');
            const limit = importing ? Math.min(20, Number.isInteger(args.maxFiles) && args.maxFiles > 0 ? args.maxFiles : 20) : 1;
            if (picked.filePaths.length > limit) throw new Error(`本次可选 ${limit} 个文件，请减少选择`);
            if (picked.filePaths.length) {
              const files = [];
              for (const file of picked.filePaths) files.push(await readSelectedText(file, importing ? '文本文件' : '稿件'));
              if (activeWork !== workId) throw new Error('作品已切换，请重新选择文件');
              result = importing ? await rpc('importSelectedTexts', { files }, workId) : files[0];
            }
          }
        } else if (method === 'pickMaterial') {
          const current = registry.works.find(w => w.id === activeWork);
          if (!current || current.id !== workId) throw new Error('请先选择本作品');
          const map = args.map === true;
          const folder = !map && args.folder === true;
          const extensions = map ? (await import('../core/catalog.mjs')).MAP_EXTENSIONS : ['md','txt'];
          const picked = await dialog.showOpenDialog(window, { title: map ? '选择本作品内的地图' : folder ? '选择本作品内的资料目录' : '选择本作品内的资料文件',
            defaultPath: current.root, properties: [folder ? 'openDirectory' : 'openFile'],
            ...(folder ? {} : { filters: [{ name: map ? '地图图片、PDF 或 HTML' : 'Markdown 和 UTF-8 文本', extensions }] }) });
          if (picked.canceled) result = null;
          else {
            const selected = path.relative(current.root, await fs.realpath(picked.filePaths[0]));
            if (!selected || selected === '..' || selected.startsWith(`..${path.sep}`) || path.isAbsolute(selected)) {
              throw new Error('请选择本作品目录下的资料');
            }
            result = selected.split(path.sep).join('/');
          }
        } else if (method === 'pickPython') {
          const picked = await dialog.showOpenDialog(window, { title: '选择Python解释器', properties: ['openFile'], filters: [{ name: 'Python解释器', extensions: ['exe'] }] });
          result = picked.canceled ? null : picked.filePaths[0];
        } else if (method === 'localModels') result = await localModels();
        else if (method === 'localStart') result = await changeLocalModel(workId, () => localStart(args.key));
        else if (method === 'localStop') result = await changeLocalModel(workId, () => localStop(args.key));
        else if (method === 'localStatus') result = await localStatus();
        else if (method === 'selectWritingModel') {
          if (!activeWork || workId !== activeWork) throw new Error('作品已切换，请重新选择模型。');
          if (localModelChanging) throw new Error('正在切换本机模型，请稍候。');
          if (args.start && args.key !== 'analysis') result = await changeLocalModel(workId, async () => {
            await localStart(args.key);
            return rpc('selectWritingModel', args, workId);
          });
          else result = await rpc('selectWritingModel', args, workId);
        }
        else if (method === 'export') {
          const picked = await dialog.showSaveDialog(window, { title: '导出可迁移资料包', defaultPath: '小说资料导出.json', filters: [{ name: '本地资料包', extensions: ['json'] }] });
          if (picked.canceled) result = null;
          else { await writeJson(picked.filePath, await rpc('exportData', {}, workId)); result = picked.filePath; }
        }
        return { ok: true, result };
      }
      if (method === 'importSelectedTexts') throw new Error('请通过文件选择窗口导入文本');
      if (method === 'sendCowriting' && workId === activeWork && memorySettings?.enabled) await startMemory(memorySettings);
      if (['memlayerStatus', 'memlayerMemory', 'memlayerPropose', 'memlayerReview', 'memlayerRetract'].includes(method) && workId === activeWork) await startMemory(memorySettings);
      const result = await rpc(method, args, workId);
      if (method === 'updateSettings' && result?.id === activeWork) {
        if (args.ai) {
          const base = connectionBase(result.settings.ai.baseUrl);
          await writeJson(modelStateFile, { base });
          approvedModelBase = base;
        }
        memorySettings = result.settings.memlayer;
        void startMemory(memorySettings);
      }
      return { ok: true, result };
    } catch (e) { return { ok: false, error: { code: e.code || 'ERROR', message: e.message, details: e.details || {} } }; }
  });
  await window.loadURL('storydesk://app/index.html');
  window.on('focus', () => { if (activeWork) rpc('refresh', {}, activeWork).catch(() => {}); });
  if (focusRequested) focusMainWindow();
  if (process.env.NOVEL_SCREENSHOT_PATH) { setTimeout(async () => { await fs.writeFile(process.env.NOVEL_SCREENSHOT_PATH, (await window.webContents.capturePage()).toPNG()); }, 4000); }
}).catch(async e => { await fs.mkdir(app.getPath('userData'), { recursive: true }); await fs.writeFile(statePath('startup-error.txt'), e.stack || e.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !worker) return; event.preventDefault(); quitting = true;clearTimeout(notifyTimer);
  allowCloseAfterFlush().then(async ok => { if (!ok) { quitting = false; return; } await Promise.race([rpc('close'), new Promise(resolve => setTimeout(resolve, 10000))]); await worker.terminate(); closeMemlayer(); app.quit(); });
});
