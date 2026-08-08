const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('grimoire', {
  // Help
  openHelp: () => ipcRenderer.invoke('help:open'),

  // Card database
  loadDatabase: () => ipcRenderer.invoke('db:load'),
  updateDatabase: () => ipcRenderer.invoke('db:update'),
  importDatabase: () => ipcRenderer.invoke('db:import'),

  // Card images
  getImagesInfo: () => ipcRenderer.invoke('images:list'),

  // Deck persistence
  loadCurrentDeck: () => ipcRenderer.invoke('deck:loadCurrent'),
  saveCurrentDeck: (deckState) => ipcRenderer.invoke('deck:saveCurrent', deckState),
  saveDeckAs: (deckState, suggestedName) => ipcRenderer.invoke('deck:saveAs', deckState, suggestedName),
  openDeck: () => ipcRenderer.invoke('deck:open'),
  exportBulkTxt: (text, suggestedName) => ipcRenderer.invoke('deck:exportBulkTxt', text, suggestedName),

  // Native clipboard (more reliable in Electron than the web Clipboard API)
  copyText: (text) => { clipboard.writeText(text); return true; },
});
