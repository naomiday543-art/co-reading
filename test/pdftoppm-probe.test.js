import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasPdftoppm, resetPdftoppmProbe, renderVisualPages } from '../src/pdf.js';

// 2026-09-09：opencode_go preset 的 vision_mode 預設是 'on'，但這台機器沒裝 poppler。
// 舊行為＝每上傳一篇論文都先把整份 PDF 用 pdf-parse 重新解析一次（實測 371ms）
// 再 spawn pdftoppm 吃 ENOENT（1ms），約 400ms 純白跑，而且每篇重來。
// 現在探測一次就記住，連那次重新解析都省掉。
describe('pdftoppm 探測', () => {
  const original = process.env.PDFTOPPM_PATH;
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'co-reading-probe-'));
    resetPdftoppmProbe();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PDFTOPPM_PATH;
    else process.env.PDFTOPPM_PATH = original;
    resetPdftoppmProbe();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('找不到執行檔時回 false', async () => {
    process.env.PDFTOPPM_PATH = join(workDir, 'definitely-not-here');
    assert.equal(await hasPdftoppm(), false);
  });

  it('執行檔用非零退出碼印版本也算「有裝」（部分 poppler 版本就這樣）', async () => {
    const fake = join(workDir, 'pdftoppm-noisy');
    writeFileSync(fake, '#!/bin/sh\necho "pdftoppm version 25.0" 1>&2\nexit 99\n');
    chmodSync(fake, 0o755);
    process.env.PDFTOPPM_PATH = fake;
    assert.equal(await hasPdftoppm(), true);
  });

  it('探測結果在進程內記住，不會每篇論文重跑', async () => {
    const fake = join(workDir, 'pdftoppm-once');
    const marker = join(workDir, 'calls');
    writeFileSync(fake, `#!/bin/sh\necho x >> ${marker}\nexit 0\n`);
    chmodSync(fake, 0o755);
    process.env.PDFTOPPM_PATH = fake;

    assert.equal(await hasPdftoppm(), true);
    assert.equal(await hasPdftoppm(), true);
    assert.equal(await hasPdftoppm(), true);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, '探測應該只跑過一次');
  });

  it('缺 pdftoppm 時 renderVisualPages 立刻丟 PDFTOPPM_MISSING，不去解析 PDF', async () => {
    process.env.PDFTOPPM_PATH = join(workDir, 'nope');
    const t0 = Date.now();
    // 刻意給一個不存在的 PDF 路徑：如果它還是先去讀檔解析，丟的會是 ENOENT 讀檔錯誤，
    // 而不是 PDFTOPPM_MISSING——這個斷言就是在釘「先探測、後解析」的順序。
    await assert.rejects(
      () => renderVisualPages(join(workDir, 'no-such-paper.pdf')),
      (err) => {
        assert.equal(err.code, 'PDFTOPPM_MISSING');
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 5000, '應該是立刻回，不是先付一次全文解析');
  });
});
