import Database from 'better-sqlite3';
import cfg from './config.js';

const db = new Database(cfg.DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sources_m3u (id INTEGER PRIMARY KEY, name TEXT, url TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS sources_xtream (id INTEGER PRIMARY KEY, name TEXT, base_url TEXT, username TEXT, password TEXT);
CREATE TABLE IF NOT EXISTS epg_sources (id INTEGER PRIMARY KEY, name TEXT, url TEXT);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  source_type TEXT,
  source_id INTEGER,
  name TEXT,
  url TEXT,
  number INTEGER,
  group_name TEXT,
  logo TEXT,
  tvg_id TEXT,
  epg_source TEXT,
  enabled INTEGER NOT NULL DEFAULT 0
);
`);
// Migrations
try { db.exec("ALTER TABLE channels ADD COLUMN epg_source TEXT"); } catch {}
try { db.exec("UPDATE channels SET enabled=0 WHERE enabled IS NULL"); } catch {}

export default db;
