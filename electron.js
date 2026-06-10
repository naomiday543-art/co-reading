import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;

let mainWindow;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Co-Reading',
  });

  await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // Import Express server directly — runs inside Electron's Node, so
  // better-sqlite3 (rebuilt by electron-rebuild) matches the ABI.
  await import('./src/server.js');
  await createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
