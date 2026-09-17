/**
 * 前端用的 markdown 純文字投影（工單 19 §2.2）。
 *
 * **這裡沒有第二份實作**——直接 re-export 後端那一顆（`src/markdownPlain.js`）。
 * 工單 §2.2 給了三條路（共用同一份／symlink／複製＋測試釘逐字相同），選第一條：
 * 前後端算出來的偏移只要差一個字，後端 `slice(start,end) === text` 就 400，
 * 與其用測試去釘兩份複製品不會漂，不如根本只有一份。
 *
 * Vite 的 root 是 `frontend/`，但 import 一個 root 之外、還在專案裡的檔案沒問題
 * （打包時 rollup 照樣收進去）——`npm run build` 是這條線的驗收。
 */
export { plainText } from '../../../src/markdownPlain.js';
