// The page's only way to the main process: window.imager (see shared/ipc.ts).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ImagerApi, JobProgress } from '../shared/ipc';

const info = ipcRenderer.sendSync('app:info') as { platform: string; version: string; devSample: boolean };

const api: ImagerApi = {
  ...info,
  loadCatalog: (opts) => ipcRenderer.invoke('catalog:load', opts),
  listDrives: (minSize, internal) => ipcRenderer.invoke('drives:list', minSize, internal === true),
  writeSd: (imageId, device, internal) => ipcRenderer.invoke('sd:write', imageId, device, internal === true),
  pickLocalImage: () => ipcRenderer.invoke('sd:pick'),
  // Only the preload script can tell where a dropped file is.
  dropLocalImage: (file) => ipcRenderer.invoke('sd:drop', webUtils.getPathForFile(file)),
  writeLocalImage: (token, device, internal) => ipcRenderer.invoke('sd:write-file', token, device, internal === true),
  pickSaveFile: (name) => ipcRenderer.invoke('save:pick', name),
  saveImage: (what, saveToken) => ipcRenderer.invoke('save:run', what, saveToken),
  showSavedFile: (saveToken) => ipcRenderer.invoke('save:show', saveToken),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  onProgress: (cb) => {
    const h = (_e: unknown, p: JobProgress) => cb(p);
    ipcRenderer.on('job:progress', h);
    return () => { ipcRenderer.off('job:progress', h); };
  },
  prepareMaskrom: (imageId, what) => ipcRenderer.invoke('maskrom:prepare', imageId, what ?? 'image'),
  pickMaskromFile: () => ipcRenderer.invoke('maskrom:pick'),
  getLoader: (name) => ipcRenderer.invoke('maskrom:loader', name),
  releaseMaskrom: (token) => ipcRenderer.invoke('maskrom:release', token),
  onUsbChoice: (cb) => {
    const h = (_e: unknown, c: Parameters<typeof cb>[0]) => cb(c);
    ipcRenderer.on('usb:choose', h);
    return () => { ipcRenderer.off('usb:choose', h); };
  },
  answerUsbChoice: (id) => ipcRenderer.send('usb:answer', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  checkUpdate: (force) => ipcRenderer.invoke('update:check', force),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  restartApp: () => ipcRenderer.invoke('update:restart'),
  onUpdateStage: (cb) => {
    const h = (_e: unknown, st: string) => cb(st);
    ipcRenderer.on('update:stage', h);
    return () => { ipcRenderer.off('update:stage', h); };
  },
  onUpdateLog: (cb) => {
    const h = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on('update:log', h);
    return () => { ipcRenderer.off('update:log', h); };
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onUpdateProgress: (cb) => {
    const h = (_e: unknown, p: { bytes: number; total: number }) => cb(p);
    ipcRenderer.on('update:progress', h);
    return () => { ipcRenderer.off('update:progress', h); };
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setTheme: (t) => ipcRenderer.send('theme', t),
};

contextBridge.exposeInMainWorld('imager', api);
