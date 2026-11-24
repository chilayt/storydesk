const { contextBridge, ipcRenderer } = require('electron');
const flushers = new Set();
ipcRenderer.on('storydesk:flush', async (_event, id) => {
  try { for (const callback of flushers) await callback(); ipcRenderer.send('storydesk:flush-result', { id, ok: true }); }
  catch (e) { ipcRenderer.send('storydesk:flush-result', { id, ok: false, error: e.message }); }
});
contextBridge.exposeInMainWorld('storyDesk', {
  call: async (method, args = {}, workId = null) => {
    const response = await ipcRenderer.invoke('storydesk:call', { method, args, workId });
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  },
  subscribe: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('storydesk:event', listener); return () => ipcRenderer.removeListener('storydesk:event', listener); }
  ,onFlush: callback => { flushers.add(callback); return () => flushers.delete(callback); }
  ,flushNow: async () => { for (const callback of flushers) await callback(); }
});
