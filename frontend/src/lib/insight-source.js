// 工單 18：洞察來源（§2 A1／A2）的前端純函式層。

/**
 * 「存為洞察」按下去的那一則 assistant，它是在回答哪一則 user（工單 18 §2 A1）。
 *
 * 往前找最近的一則 user——不是 `idx-1`：中間可能夾著別的角色，而且編輯／重生
 * 之後陣列裡的順序是 seq 排的、不保證一問一答貼在一起。找不到回 null。
 */
export function previousUserMessage(messages, idx) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = Math.min(idx, list.length) - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return list[i];
  }
  return null;
}
