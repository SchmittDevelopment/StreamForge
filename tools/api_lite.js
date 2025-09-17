#!/usr/bin/env node
import express from 'express';
import compression from 'compression';
import Database from 'better-sqlite3';

function arg(name, def=null){
  const i = process.argv.indexOf('--'+name);
  if (i>=0 && process.argv[i+1]) return process.argv[i+1];
  return def;
}

const DB_FILE = arg('db','./data/streamforge.sqlite');
const PORT = Number(arg('port','8081'));

const app = express();
app.use(compression());

const db = new Database(DB_FILE, { readonly: true });

app.get('/channels', (req,res)=>{
  const q = String(req.query.q || '').trim();
  const group = String(req.query.group || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
  const offset = Math.max(0, Number(req.query.offset || 0));

  let sql = `SELECT name, group_name, tvg_id, logo, number, url, enabled FROM channels WHERE 1=1`;
  const params = [];
  if (q){ sql += ` AND name LIKE ?`; params.push(`%${q}%`); }
  if (group){ sql += ` AND group_name = ?`; params.push(group); }
  sql += ` ORDER BY name ASC LIMIT ? OFFSET ?`; params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.get('/m3u', (req,res)=>{
  const q = String(req.query.q || '').trim();
  const group = String(req.query.group || '').trim();
  const includeChno = String(req.query.includeChno || 'true') === 'true';
  const limit = Math.max(1, Math.min(20000, Number(req.query.limit || 500)));

  let sql = `SELECT name, group_name, tvg_id, logo, number, url, enabled FROM channels WHERE enabled=1`;
  const params = [];
  if (q){ sql += ` AND name LIKE ?`; params.push(`%${q}%`); }
  if (group){ sql += ` AND group_name = ?`; params.push(group); }
  sql += ` ORDER BY name ASC LIMIT ?`; params.push(limit);

  const rows = db.prepare(sql).all(...params);

  res.type('text/plain; charset=utf-8');
  res.write('#EXTM3U\n');
  for (const ch of rows){
    const attrs = [];
    if (ch.tvg_id) attrs.push(`tvg-id="${ch.tvg_id}"`);
    if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
    if (ch.group_name) attrs.push(`group-title="${ch.group_name}"`);
    if (includeChno && ch.number!=null) attrs.push(`tvg-chno="${ch.number}"`);
    res.write(`#EXTINF:-1 ${attrs.join(' ')} ,${ch.name}\n`);
    res.write(`${ch.url}\n`);
  }
  res.end();
});

app.listen(PORT, ()=>{
  console.log(`API lite listening on :${PORT}`);
});
