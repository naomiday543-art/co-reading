import db from './db.js';

/**
 * Search insights using FTS5 trigram (≥3 chars) with LIKE fallback (2 chars).
 * Returns scored insights, excluding a given paper_id when specified.
 */
export function searchInsights(query, { excludePaperId = null, limit = 10 } = {}) {
  if (!query || typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  if (trimmed.length >= 3) {
    // FTS5 trigram: requires ≥3 characters. Escape double quotes for FTS5.
    const escaped = trimmed.replace(/"/g, '""');
    const sql = `
      SELECT i.*, insights_fts.rank AS score
      FROM insights_fts
      JOIN insights i ON insights_fts.rowid = i.rowid
      WHERE insights_fts MATCH ?
      ${excludePaperId ? 'AND i.source_paper_id != ?' : ''}
      ORDER BY rank
      LIMIT ?
    `;
    const params = [`"${escaped}"`, ...(excludePaperId ? [excludePaperId] : []), limit];
    return db.prepare(sql).all(...params);
  }

  // LIKE fallback for 2-char queries (trigram tokenizer requires ≥3)
  const like = `%${trimmed}%`;
  const sql = `
    SELECT i.*, 0 AS score
    FROM insights i
    WHERE (i.title LIKE ? OR i.content LIKE ?)
    ${excludePaperId ? 'AND i.source_paper_id != ?' : ''}
    ORDER BY i.updated_at DESC
    LIMIT ?
  `;
  const params = [like, like, ...(excludePaperId ? [excludePaperId] : []), limit];
  return db.prepare(sql).all(...params);
}

/**
 * Find insights related to a paper by searching with the paper's title + tags.
 * Falls back to keyword-based scoring if FTS5 returns no results.
 */
export function findRelatedInsights(paperId, maxResults = 10) {
  const paper = db.prepare('SELECT title FROM papers WHERE id = ?').get(paperId);
  if (!paper?.title) return [];

  const tags = db.prepare(`
    SELECT t.name FROM tags t
    JOIN paper_tags pt ON t.id = pt.tag_id
    WHERE pt.paper_id = ?
  `).all(paperId).map(t => t.name);

  // Search with paper title first (high signal)
  const byTitle = searchInsights(paper.title, { excludePaperId: paperId, limit: maxResults });
  if (byTitle.length >= 5) return byTitle;

  // Supplement with tag-based search
  const seen = new Set(byTitle.map(r => r.id));
  for (const tag of tags) {
    if (byTitle.length + seen.size >= maxResults) break;
    const byTag = searchInsights(tag, { excludePaperId: paperId, limit: 3 });
    for (const r of byTag) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        byTitle.push(r);
      }
    }
  }

  return byTitle.slice(0, maxResults);
}
