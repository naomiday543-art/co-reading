// 研究方向的唯讀端點（工單 21 §三 B1）。
//
// 只有一條路由：`GET /api/directions/:nodeId/progress`——研究進度圖的資料來源。
// 紅線 1：圖是唯讀的，這個檔案永遠不會有 POST／PATCH／DELETE。
//
// router 做成工廠是為了測試：`createDirectionsRouter({ database, fetchImpl, config })`
// 讓路由層可以整條走假 gateway ＋ 記憶體 DB（照 carryover.js 的依賴注入風格）。

import { Router } from 'express';
import { buildDirectionProgress } from '../progress.js';

export function createDirectionsRouter(deps = {}) {
  const router = Router();

  router.get('/directions/:nodeId/progress', async (req, res) => {
    const result = await buildDirectionProgress(req.params.nodeId, deps);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.reason, reason: result.reason });
    }
    res.json(result.body);
  });

  return router;
}

export default createDirectionsRouter();
