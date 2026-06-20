import { EventEmitter } from "node:events";

const makeAsyncNoop = () => async () => undefined;
const makeSyncNoop = () => undefined;

class MockBrowserWindow extends EventEmitter {
  static allWindows: MockBrowserWindow[] = [];

  static getAllWindows() {
    return [...MockBrowserWindow.allWindows];
  }

  static getFocusedWindow() {
    return MockBrowserWindow.allWindows[0] ?? null;
  }

  readonly webContents = {
    copyImageAt: makeSyncNoop(),
    getUserAgent: () => "Mozilla/5.0 Electron/41.5.0 pulse/1.2.3",
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    isLoadingMainFrame: () => false,
    on: makeSyncNoop(),
    once: makeSyncNoop(),
    openDevTools: makeSyncNoop(),
    reload: makeSyncNoop(),
    reloadIgnoringCache: makeSyncNoop(),
    replaceMisspelling: makeSyncNoop(),
    send: makeSyncNoop(),
    setAudioMuted: makeSyncNoop(),
    setWindowOpenHandler: makeSyncNoop(),
    stop: makeSyncNoop(),
  };

  readonly options: unknown;

  constructor(options: unknown = {}) {
    super();
    this.options = options;
    MockBrowserWindow.allWindows.push(this);
  }

  close() {}
  destroy() {}
  focus() {}
  hide() {}
  isDestroyed() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  isMinimized() {
    return false;
  }
  isVisible() {
    return true;
  }
  loadFile() {
    return Promise.resolve();
  }
  loadURL() {
    return Promise.resolve();
  }
  maximize() {}
  minimize() {}
  restore() {}
  setAlwaysOnTop() {}
  setAutoHideCursor() {}
  setBackgroundColor() {}
  setBrowserView() {}
  setFullScreen() {}
  setTitle() {}
  setTitleBarOverlay() {}
  show() {}
  showInactive() {}
  unmaximize() {}
}

class MockBrowserView {
  readonly webContents = new MockBrowserWindow().webContents;

  setAutoResize() {}
  setBounds() {}
}

const appEmitter = new EventEmitter();

export const app = Object.assign(appEmitter, {
  commandLine: {
    appendSwitch: makeSyncNoop(),
  },
  dock: {
    setIcon: makeSyncNoop(),
  },
  exit: makeSyncNoop(),
  focus: makeSyncNoop(),
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
  getVersion: () => "0.0.0-test",
  isPackaged: false,
  name: "Pulse",
  quit: makeSyncNoop(),
  relaunch: makeSyncNoop(),
  removeListener: appEmitter.removeListener.bind(appEmitter),
  requestSingleInstanceLock: () => true,
  runningUnderARM64Translation: false,
  setAboutPanelOptions: makeSyncNoop(),
  setAppUserModelId: makeSyncNoop(),
  setAsDefaultProtocolClient: () => true,
  setName: makeSyncNoop(),
  setPath: makeSyncNoop(),
  whenReady: () => Promise.resolve(),
});

export const BrowserWindow = MockBrowserWindow;
export const BrowserView = MockBrowserView;

export const clipboard = {
  writeText: makeSyncNoop(),
};

export const contextBridge = {
  exposeInMainWorld: makeSyncNoop(),
};

export const dialog = {
  showErrorBox: makeSyncNoop(),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const ipcMain = {
  handle: makeSyncNoop(),
  on: makeSyncNoop(),
  removeHandler: makeSyncNoop(),
  removeListener: makeSyncNoop(),
};

export const ipcRenderer = {
  invoke: makeAsyncNoop(),
  on: makeSyncNoop(),
  removeListener: makeSyncNoop(),
  send: makeSyncNoop(),
  sendSync: () => null,
};

export const Menu = {
  buildFromTemplate: (template: unknown) => ({
    popup: makeSyncNoop(),
    template,
  }),
  setApplicationMenu: makeSyncNoop(),
};

export const nativeImage = {
  createFromNamedImage: () => ({
    isEmpty: () => false,
    resize: () => ({}),
  }),
  createFromPath: () => ({
    isEmpty: () => false,
    resize: () => ({}),
  }),
};

const nativeThemeEmitter = new EventEmitter();
export const nativeTheme = Object.assign(nativeThemeEmitter, {
  removeListener: nativeThemeEmitter.removeListener.bind(nativeThemeEmitter),
  shouldUseDarkColors: false,
  themeSource: "system",
});

export const protocol = {
  handle: makeSyncNoop(),
  isProtocolHandled: async () => false,
  registerFileProtocol: () => true,
  registerSchemesAsPrivileged: makeSyncNoop(),
  unregisterProtocol: makeSyncNoop(),
};

export const safeStorage = {
  decryptString: () => "",
  encryptString: (value: string) => Buffer.from(value),
  isEncryptionAvailable: () => false,
};

export const session = {
  defaultSession: {},
  fromPartition: () => ({
    clearCache: makeAsyncNoop(),
    clearStorageData: makeAsyncNoop(),
    cookies: {
      flushStore: makeAsyncNoop(),
      get: async () => [],
      remove: makeAsyncNoop(),
    },
    getUserAgent: () => "Mozilla/5.0 Electron/41.5.0 pulse/1.2.3",
    setPermissionRequestHandler: makeSyncNoop(),
    setUserAgent: makeSyncNoop(),
  }),
};

export const shell = {
  openExternal: async () => undefined,
};

export const webContents = {
  fromId: () => null,
  getAllWebContents: () => [],
};

export default {
  app,
  BrowserView,
  BrowserWindow,
  clipboard,
  contextBridge,
  dialog,
  ipcMain,
  ipcRenderer,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  webContents,
};
