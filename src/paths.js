import { fileURLToPath } from 'url';
import { join } from 'path';

const sourceDataDir = fileURLToPath(new URL('../data/', import.meta.url));

export function resolveDataPaths({
  dataDir = process.env.CO_READING_DATA_DIR,
  dbPath = process.env.CO_READING_DB_PATH,
  pdfDir = process.env.CO_READING_PDF_DIR,
} = {}) {
  const root = dataDir || sourceDataDir;
  return {
    dataDir: root,
    dbPath: dbPath || join(root, 'co-reading.db'),
    pdfDir: pdfDir || join(root, 'pdfs'),
    logPath: join(root, 'app.log'),
  };
}

export const dataPaths = resolveDataPaths();
