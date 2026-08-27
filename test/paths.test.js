import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDataPaths } from '../src/paths.js';

describe('mutable data paths', () => {
  it('keeps database, PDFs, and logs under the configured data directory', () => {
    const root = join('/tmp', 'co-reading-user-data');
    const paths = resolveDataPaths({ dataDir: root, dbPath: '', pdfDir: '' });

    assert.equal(paths.dataDir, root);
    assert.equal(paths.dbPath, join(root, 'co-reading.db'));
    assert.equal(paths.pdfDir, join(root, 'pdfs'));
    assert.equal(paths.logPath, join(root, 'app.log'));
  });

  it('allows test and deployment overrides for database and PDF paths', () => {
    const paths = resolveDataPaths({
      dataDir: '/data/root',
      dbPath: '/test/db.sqlite',
      pdfDir: '/papers',
    });

    assert.equal(paths.dbPath, '/test/db.sqlite');
    assert.equal(paths.pdfDir, '/papers');
    assert.equal(paths.logPath, join('/data/root', 'app.log'));
  });
});
