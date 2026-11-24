import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

export class SearchIndex {
  constructor(file) { this.file = file; this.db = null; }
  async open() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try { this.db = new DatabaseSync(this.file); this.db.exec('PRAGMA quick_check;'); }
    catch { this.db?.close(); await fs.rename(this.file, `${this.file}.damaged-${Date.now()}`).catch(() => {}); this.db = new DatabaseSync(this.file); }
    this.db.exec('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, title TEXT, kind TEXT, path TEXT, hash TEXT, content TEXT); CREATE INDEX IF NOT EXISTS doc_work ON documents(work_id);');
  }
  rebuild(workId, documents) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM documents WHERE work_id = ?').run(workId);
      const insert = this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)');
      for (const d of documents) insert.run(d.id, workId, d.title, d.kind, d.path, d.hash, d.text);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  search(workId, query, kind) {
    const q = query.trim(); if (!q) return [];
    const rows = this.db.prepare('SELECT id,title,kind,path,content,instr(content, ?) AS pos FROM documents WHERE work_id=? AND (? IS NULL OR kind=?) AND (instr(content,?)>0 OR instr(title,?)>0) ORDER BY instr(title,?) DESC LIMIT 80').all(q, workId, kind || null, kind || null, q, q, q);
    return rows.map(r => ({ id: r.id, title: r.title, kind: r.kind, path: r.path, excerpt: r.content.slice(Math.max(0, r.pos - 65), Math.max(0, r.pos - 65) + 200), query: q }));
  }
  close() { this.db?.close(); this.db = null; }
}
