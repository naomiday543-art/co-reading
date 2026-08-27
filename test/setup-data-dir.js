import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test files import production modules that open SQLite during module loading.
// Give every Node test worker a disposable data root before those imports run.
const testDataDir = mkdtempSync(join(tmpdir(), 'co-reading-test-data-'));
process.env.CO_READING_DATA_DIR = testDataDir;
delete process.env.CO_READING_DB_PATH;
delete process.env.CO_READING_PDF_DIR;

process.on('exit', () => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // Windows may briefly retain a native SQLite handle while the process exits.
  }
});
