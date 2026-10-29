const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    title: 'Infolab CBT — Student',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    backgroundColor: '#0f1623',
  });

  mainWindow.loadFile(path.join(__dirname, 'client', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', function() { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function() {
  if (mainWindow === null) createWindow();
});
