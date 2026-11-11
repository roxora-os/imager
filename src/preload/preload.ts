// The page's only way to the main process: window.imager (see shared/ipc.ts).
import { contextBridge, ipcRenderer } from 'electron';
import type { ImagerApi, JobProgress } from '../shared/ipc';

const info = ipcRenderer.sendSync('app:info') as { platform: string; version: string; devSample: boolean };

const api: ImagerApi = {
  ...info,
  loadCatalog: (opts) => ipcRenderer.invoke('catalog:load', opts),
  listDrives: (minSize) => ipcRenderer.invoke('drives:list', minSize),
  writeSd: (imageId, device) => ipcRenderer.invoke('sd:write', imageId, device),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  onProgress: (cb) => {
    const h = (_e: unknown, p: JobProgress) => cb(p);
    ipcRenderer.on('job:progress', h);
    return () => { ipcRenderer.off('job:progress', h); };
  },
  prepareMaskrom: (imageId) => ipcRenderer.invoke('maskrom:prepare', imageId),
  pickMaskromFile: () => ipcRenderer.invoke('maskrom:pick'),
  releaseMaskrom: (token) => ipcRenderer.invoke('maskrom:release', token),
  onUsbChoice: (cb) => {
    const h = (_e: unknown, c: Parameters<typeof cb>[0]) => cb(c);
    ipcRenderer.on('usb:choose', h);
    return () => { ipcRenderer.off('usb:choose', h); };
  },
  answerUsbChoice: (id) => ipcRenderer.send('usb:answer', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  checkUpdate: (force) => ipcRenderer.invoke('update:check', force),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (t) => ipcRenderer.send('theme', t),
};

contextBridge.exposeInMainWorld('imager', api);
