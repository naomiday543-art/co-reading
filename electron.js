import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;

let mainWindow;
let backendServer;

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
  // Packaged apps run from read-only app.asar. Keep mutable user data in the
  // OS-provided per-user application directory before importing the server.
  process.env.CO_READING_DATA_DIR ||= join(app.getPath('userData'), 'data');

  // Import Express server directly — runs inside Electron's Node, so
  // better-sqlite3 (rebuilt by electron-rebuild) matches the ABI.
  const { startServer } = await import('./src/server.js');
  backendServer = startServer(PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (backendServer.listening) return resolve();
    backendServer.once('listening', resolve);
    backendServer.once('error', reject);
  });
  await createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  backendServer?.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
