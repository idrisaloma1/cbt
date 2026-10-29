// RECONSTRUCTED after disk loss (original file was never recovered).
// Starts the Express server inside Electron and opens the Admin panel.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Keep the database in the user's profile so it survives reinstalls/updates.
process.env.CBT_DATA_DIR = path.join(app.getPath('userData'), 'data');

let win;
function createWindow() {
  require('./server/index.js'); // starts listening on 0.0.0.0:4000
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'Infolab Offline CBT',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  Menu.setApplicationMenu(null);
  setTimeout(() => win.loadURL('http://localhost:' + (process.env.PORT || 4000) + '/'), 600);
  win.on('closed', () => { win = null; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
