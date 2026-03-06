const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        backgroundColor: '#F2F2F7',
        icon: path.join(__dirname, 'src/assets/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'src/preload.js'),
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

    // Open external links in browser, not Electron
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Let renderer store/load config via IPC (uses Electron's userData)
const Store = (() => {
    const fs = require('fs');
    const configPath = path.join(app.getPath('userData'), 'config.json');
    return {
        get: () => {
            try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
            catch { return {}; }
        },
        set: (data) => fs.writeFileSync(configPath, JSON.stringify(data, null, 2)),
    };
})();

ipcMain.handle('config:get', () => Store.get());
ipcMain.handle('config:set', (_, data) => Store.set(data));
