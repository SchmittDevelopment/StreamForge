#!/usr/bin/env node

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import compression from 'compression';

import cfg from './config.js';
import db from './db.js';
import { parseM3U, buildM3U } from './m3u.js';
import { fetchXtreamChannels } from './xtream.js';
import { refreshEPG, readCombinedIndex, readCombinedIdNames, getMergedFilePath } from './epg.js';
import { getDiscover, getLineupStatus, getLineup } from './hdhr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Farben + Version
function supportsColor(){ return process.stdout && process.stdout.isTTY; }
function color(code){ return supportsColor() ? `\x1b[${code}m` : ''; }
const RESET = color(0), CYAN = color(36), DIM = color(2), GRAY = color(90);

function readPkgVersion(){
  try{
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  }catch{ return 'dev'; }
}

// ASCII aus Datei lesen (ascii.txt neben server.js oder im Projekt-Root ablegen)
function loadAsciiArt(){
  const candidates = [
    path.resolve(process.cwd(), 'public', 'assets', 'logo.txt'),
    path.resolve(process.cwd(), 'public', 'assets', 'logo.txt'),
  ];
  for (const p of candidates){
    try{
      const raw = fs.readFileSync(p, 'utf8');
      // richtige Zeilenumbrüche; letzte Leerzeile entfernen
      const lines = raw.replace(/\r\n/g, '\n').replace(/\s+$/,'').split('\n');
      return lines.map(line => CYAN + line + RESET).join('\n');
    }catch{}
  }
  // Fallback: kurze Schrift „StreamForge“, falls Datei fehlt
  return [
    `${CYAN}  _____ _                                 _____                        ${RESET}`,
    `${CYAN} / ____| |                               |  __ \\                       ${RESET}`,
    `${CYAN}| (___ | |_ _ __ ___  _ __ ___   ___     | |__) |___  _ __ __ _  ___   ${RESET}`,
    `${CYAN} \\___ \\| __| '__/ _ \\| '_ \` _ \\ / _ \\    |  _  // _ \\| '__/ _\` |/ _ \\  ${RESET}`,
    `${CYAN} ____) | |_| | | (_) | | | | | |  __/    | | \\ \\ (_) | | | (_| |  __/  ${RESET}`,
    `${CYAN}|_____/ \\__|_|  \\___/|_| |_| |_|\\___|    |_|  \\_\\___/|_|  \\__, |\\___|  ${RESET}`,
    `${CYAN}                                                         __/ |         ${RESET}`,
    `${CYAN}                                                        |___/          ${RESET}`,
  ].join('\n');
}

// IPs für URLs anzeigen
import os from 'node:os';
function getLocalIPs(){
  const nets = os.networkInterfaces();
  const out = [];
  for (const ifname of Object.keys(nets)){
    for (const n of nets[ifname] || []){
      if (n.family === 'IPv4' && !n.internal) out.push({ ifname, ip: n.address });
    }
  }
  return out.sort((a,b)=> a.ifname.localeCompare(b.ifname) || a.ip.localeCompare(b.ip));
}

function printBanner({ name='StreamForge', version='dev', host='0.0.0.0', port=8000 }){
  const art = loadAsciiArt(); // <-- benutzt deine ascii.txt  :contentReference[oaicite:0]{index=0}
  const line = `${GRAY}${'─'.repeat(70)}${RESET}`;
  const urls = (host === '0.0.0.0')
    ? [`http://localhost:${port}`, ...getLocalIPs().map(({ip}) => `http://${ip}:${port}`)]
    : [`http://${host}:${port}`];

  console.log('\n' + art);
  console.log(line);
  console.log(`${DIM}${name}${RESET}  ${DIM}v${version}${RESET}`);
  console.log(`${DIM}Listening on:${RESET}`);
  for (const u of urls) console.log(`  • ${CYAN}${u}${RESET}  ${DIM}— Web UI:${RESET} ${CYAN}/web${RESET}`);
  console.log('');
}


function makeDb(dbNative){
  const isBetter = typeof dbNative.prepare === 'function' && typeof dbNative.exec === 'function';
  if (isBetter){
    return {
      exec(sql){ dbNative.exec(sql); return Promise.resolve(); },
      run(sql, params = []){ dbNative.prepare(sql).run(...params); return Promise.resolve(); },
      all(sql, params = []){ const rows = dbNative.prepare(sql).all(...params); return Promise.resolve(rows); },
      get(sql, params = []){ const row  = dbNative.prepare(sql).get(...params); return Promise.resolve(row); },
    };
  }
  const exec = (sql)            => new Promise((res,rej)=> dbNative.exec(sql, e => e ? rej(e) : res()));
  const run  = (sql, params=[]) => new Promise((res,rej)=> dbNative.run(sql, params, function(e){ e ? rej(e) : res(this); }));
  const all  = (sql, params=[]) => new Promise((res,rej)=> dbNative.all(sql, params, (e,rows)=> e ? rej(e) : res(rows)));
  const get  = (sql, params=[]) => new Promise((res,rej)=> dbNative.get(sql, params, (e,row)=> e ? rej(e) : res(row)));
  return { exec, run, all, get };
}

const DB = makeDb(db); // <-- dein importiertes ./db.js-Objekt

async function migrateSeenColumn(){
  const cols = await DB.all(`PRAGMA table_info(channels)`);
  const hasSeen  = cols.some(c => c.name === 'seen');
  const hasStale = cols.some(c => c.name === 'stale');

  if (!hasSeen){
    await DB.run(`ALTER TABLE channels ADD COLUMN seen INTEGER DEFAULT 1`);
    // Beim ersten Mal alles als "gesehen" markieren
    await DB.run(`UPDATE channels SET seen = 1`);
  }
  if (!hasStale){
    await DB.run(`ALTER TABLE channels ADD COLUMN stale INTEGER DEFAULT 0`);
  }
}

// ==== einmalige Migration: external_id + uniq index + De-Dupe ====
async function migrateChannelsKey(){
  const cols = await DB.all(`PRAGMA table_info(channels)`);
  const hasExternal = cols.some(c => c.name === 'external_id');
  if (!hasExternal){
    await DB.run(`ALTER TABLE channels ADD COLUMN external_id TEXT`);
  }
  await DB.run(`
    UPDATE channels
    SET external_id = COALESCE(NULLIF(tvg_id, ''), external_id)
    WHERE external_id IS NULL OR external_id = ''
  `);

  const dups = await DB.all(`
    WITH k AS (
      SELECT id, enabled, number, tvg_id, epg_source,
             source_type, source_id, COALESCE(external_id, url) AS keyval
      FROM channels
    )
    SELECT source_type, source_id, keyval, COUNT(*) AS c
    FROM k
    GROUP BY source_type, source_id, keyval
    HAVING c > 1
  `);

  if (dups.length){
    console.warn('De-dupe needed for', dups.length, 'key groups');
    for (const g of dups){
      const rows = await DB.all(`
        SELECT id, enabled, number, tvg_id, epg_source
        FROM channels
        WHERE source_type=? AND source_id=? AND COALESCE(external_id, url)=?
        ORDER BY enabled DESC, (number IS NOT NULL) DESC, number DESC, id ASC
      `, [g.source_type, g.source_id, g.keyval]);

      const keep = rows[0];
      const losers = rows.slice(1);

      for (const r of losers){
        if (!keep.tvg_id && r.tvg_id){
          await DB.run(`UPDATE channels SET tvg_id=? WHERE id=?`, [r.tvg_id, keep.id]);
          keep.tvg_id = r.tvg_id;
        }
        if (!keep.epg_source && r.epg_source){
          await DB.run(`UPDATE channels SET epg_source=? WHERE id=?`, [r.epg_source, keep.id]);
          keep.epg_source = r.epg_source;
        }
      }
      for (const r of losers){
        await DB.run(`DELETE FROM channels WHERE id=?`, [r.id]);
      }
    }
  }

  await DB.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_key
    ON channels(source_type, source_id, COALESCE(external_id, url))
  `);

  // Sicher aufrufen, nur wenn vorhanden/definiert
  if (typeof compactNumbers === 'function'){
    await compactNumbers();
  }
}

// Beim Start ausführen, erst danach Server-Routen verwenden/starten:
migrateChannelsKey()
  .then(()=> {
    console.log('Migration OK');
    // -> hier erst Express initialisieren / listen()
    // const app = express(); app.use(...); app.listen(...);
  })
  .catch(e=>{
    console.error('Migration failed:', e);
    process.exit(1);
  });

await migrateSeenColumn();


const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');


const app = express();

const DEFAULT_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

let serverRef = null;
function startServer(port = DEFAULT_PORT){
  if (serverRef){ try { serverRef.close(); } catch {} serverRef = null; }

  serverRef = app.listen(port, HOST, () => {
    printBanner({ name: 'StreamForge', version: readPkgVersion(), host: HOST, port });
  });

  serverRef.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE'){
      console.warn(`Port ${port} belegt – versuche ${port+1} ...`);
      setTimeout(() => startServer(port + 1), 250);
    } else {
      console.error('Listen-Fehler:', err);
      process.exit(1);
    }
  });
}

function shutdown(sig){
  console.log(`\n${sig} empfangen, fahre runter...`);
  if (!serverRef) process.exit(0);
  serverRef.close(() => process.exit(0));
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// nach Setup/Migration genau EINMAL aufrufen:
startServer();


app.set('etag', false);
app.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });

app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(compression());

app.use('/web', express.static(PUBLIC_DIR));

app.get('/favicon.ico', (req, res) =>
  res.sendFile(path.resolve('public/favicon.ico'))
);

app.get('/api/status', async (req,res)=>{
  const m3u = (await DB.get('SELECT COUNT(*) c FROM sources_m3u')).c;
  const xt  = (await DB.get('SELECT COUNT(*) c FROM sources_xtream')).c;
  const epg = (await DB.get('SELECT COUNT(*) c FROM epg_sources')).c;
  const ch  = (await DB.get('SELECT COUNT(*) c FROM channels')).c;
  res.json({ m3u, xtream: xt, epg, channels: ch });
});

app.use(morgan('dev', {
  skip: (req) => req.path === '/api/epg/status' || req.path === '/api/channels' && req.query?.q
}));

app.get('/api/settings', (req,res)=>{
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = Object.fromEntries(rows.map(r => [r.key, (()=>{ try{return JSON.parse(r.value)}catch{return r.value} })()]));
  res.json(out);
});
app.put('/api/settings', (req,res)=>{
  const data = req.body || {};
  const up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(obj => { for (const [k,v] of Object.entries(obj)) up.run(k, JSON.stringify(v)); });
  tx(data);
  res.json({ ok: true });
});

function upsertChannelsFromList(list, sourceType, sourceId){
  const del = db.prepare('DELETE FROM channels WHERE source_type=? AND source_id=?');
  const ins = db.prepare('INSERT INTO channels (source_type, source_id, name, url, number, group_name, logo, tvg_id, epg_source, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const maxRow = db.prepare('SELECT MAX(COALESCE(number,-1)) AS m FROM channels').get();
  let nextNo = ((maxRow?.m ?? -1) + 1);
  const tx = db.transaction(chs => {
    del.run(sourceType, sourceId);
    for (const c of chs){
      const num = (c.number!=null && c.number!=='') ? Number(c.number) : nextNo++;
      ins.run(sourceType, sourceId, c.name, c.url, num, c.group_name||null, c.logo||null, c.tvg_id||null, null, 0);
    }
  });
  tx(list);
}

app.get('/api/sources', (req,res)=>{
  const m3u = db.prepare('SELECT * FROM sources_m3u').all().map(x=>({type:'m3u',...x}));
  const xtream = db.prepare('SELECT * FROM sources_xtream').all().map(x=>({type:'xtream',...x,password:undefined}));
  res.json({ m3u, xtream });
});
app.delete('/api/sources/:type/:id', (req,res)=>{
  const { type, id } = req.params;
  if (type==='m3u') db.prepare('DELETE FROM sources_m3u WHERE id=?').run(id);
  else if (type==='xtream') db.prepare('DELETE FROM sources_xtream WHERE id=?').run(id);
  db.prepare('DELETE FROM channels WHERE source_type=? AND source_id=?').run(type, id);
  res.json({ ok: true });
});

app.post('/api/sources/m3u', async (req,res)=>{
  const { name, url, userAgent } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const info = db.prepare('INSERT INTO sources_m3u (name,url,user_agent) VALUES (?,?,?)').run(name, url, userAgent||null);
  res.json({ id: info.lastInsertRowid, name, url, refreshing: true });
  triggerRefresh();
});
app.post('/api/sources/xtream', async (req,res)=>{
  const { name, baseUrl, username, password } = req.body || {};
  if (!name || !baseUrl || !username || !password) return res.status(400).json({ error: 'name, baseUrl, username, password required' });
  const info = db.prepare('INSERT INTO sources_xtream (name,base_url,username,password) VALUES (?,?,?,?)').run(name, baseUrl, username, password);
  res.json({ id: info.lastInsertRowid, name, refreshing: true });
  triggerRefresh();
});

// ---- EPG background status
const epgStatus = { running: false, phase: null, current: 0, total: 0, lastRun: null, lastError: null };

function startBackgroundEPG(){
  if (epgStatus.running) return;
  const srcs = db.prepare('SELECT * FROM epg_sources').all();
  if (!srcs.length) return;
  epgStatus.running = true; epgStatus.phase = 'start'; epgStatus.current = 0; epgStatus.total = srcs.length; epgStatus.lastError = null;
  refreshEPG(srcs, (p)=>{
    if (p.phase === 'download'){ epgStatus.phase = 'download'; epgStatus.current = p.index; epgStatus.total = p.total; }
    else { epgStatus.phase = p.phase; }
  }).then(()=>{
    epgStatus.running = false; epgStatus.lastRun = Date.now();
  }).catch(e=>{
    epgStatus.running = false; epgStatus.lastRun = Date.now(); epgStatus.lastError = String(e);
  });
}

app.get('/api/epg/status', (req,res)=>res.json(epgStatus));
app.get('/api/epg/sources', (req,res)=>{
  const rows = db.prepare('SELECT * FROM epg_sources').all();
  const metaPath = path.join(cfg.EPG_DIR, 'meta.json');
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaPath,'utf-8')); } catch {}
  const list = rows.map(r=>{
    const key = r.name.replace(/[^a-z0-9_-]/ig,'_');
    const file = path.join(cfg.EPG_DIR, key + '.xml');
    const m = meta[key] || {};
    const active = fs.existsSync(file);
    return { id: r.id, name: r.name, url: r.url, status: active ? 'active' : 'pending', updatedAt: m.updatedAt || null };
  });
  res.json(list);
});

async function doRefresh(){
  const gst = db.prepare('SELECT value FROM settings WHERE key=?').get('globalUserAgent');
  const globalUA = gst ? JSON.parse(gst.value) : null;

  const mRows = db.prepare('SELECT * FROM sources_m3u').all();
  for (const row of mRows){
    try {
      const headers = {}; if (globalUA) headers['user-agent']=globalUA; if (row.user_agent) headers['user-agent']=row.user_agent;
      const r = await fetch(row.url, { headers, timeout: 30000 });
      if (!r.ok) throw new Error(`Fetch M3U failed: ${r.status}`);
      const text = await r.text();
      const parsed = parseM3U(text);
      if (!parsed.length) throw new Error('M3U empty');
      upsertChannelsFromList(parsed, 'm3u', row.id);
    } catch (e) {
      console.warn('M3U source failed, deleting:', row.name, String(e));
      db.prepare('DELETE FROM channels WHERE source_type=? AND source_id=?').run('m3u', row.id);
      db.prepare('DELETE FROM sources_m3u WHERE id=?').run(row.id);
    }
  }

  const xRows = db.prepare('SELECT * FROM sources_xtream').all();
  for (const row of xRows){
    try {
      const list = await fetchXtreamChannels({ baseUrl: row.base_url, username: row.username, password: row.password, userAgent: globalUA||null });
      if (!list.length) throw new Error('Xtream empty');
      upsertChannelsFromList(list, 'xtream', row.id);
    } catch (e){
      console.warn('Xtream source failed, deleting:', row.name, String(e));
      db.prepare('DELETE FROM channels WHERE source_type=? AND source_id=?').run('xtream', row.id);
      db.prepare('DELETE FROM sources_xtream WHERE id=?').run(row.id);
    }
  }

  // EPG refresh in background
  startBackgroundEPG();
}

let refreshing = false;
async function triggerRefresh(){ if (refreshing) return; refreshing=true; try { await doRefresh(); } finally { refreshing=false; } }

// ---- Helpers zum Normalisieren der eingelesenen Kanäle ----
function normXtreamChannel(row, sourceId){
  // row: Ergebnis von fetchXtreamChannels(...) – bitte anpassen falls deine Felder anders heißen
  return {
    source_type: 'xtream',
    source_id:   sourceId,
    external_id: row.stream_id != null ? String(row.stream_id) : null,
    name:        row.name || row.stream_display_name || 'Unnamed',
    group_name:  row.category_name || row.category || null,
    logo:        row.stream_icon || row.logo || null,
    url:         row.url, // du erzeugst die Live-URL vermutlich in fetchXtreamChannels
    tvg_id:      row.tvg_id || null,
  };
}

function normM3uEntry(e, sourceId){
  // e: Eintrag von parseM3U(...)
  return {
    source_type: 'm3u',
    source_id:   sourceId,
    external_id: e.tvg_id && String(e.tvg_id).trim() ? String(e.tvg_id).trim() : null,
    name:        e.name || e.title || 'Unnamed',
    group_name:  e.group_title || e.group || null,
    logo:        e.logo || e.tvg_logo || null,
    url:         e.url,
    tvg_id:      e.tvg_id || null,
  };
}

// liest alle Quellen aus der DB und liefert ein Array normalisierter Kanäle zurück
async function fetchAllSources(){
  const out = [];

  // M3U-Quellen einlesen
  const m3uSources = await DB.all('SELECT id, name, url FROM sources_m3u');
  for (const s of m3uSources){
    try{
      const raw = await (await fetch(s.url)).text();
      const entries = parseM3U(raw) || [];
      for (const e of entries){
        out.push(normM3uEntry(e, s.id));
      }
    }catch(e){
      console.warn('[refresh] M3U fetch failed', s.url, e?.message || e);
    }
  }

  // Xtream-Quellen einlesen
  const xtSources = await DB.all('SELECT id, name, base_url, username, password FROM sources_xtream');
  for (const s of xtSources){
    try{
      const rows = await fetchXtreamChannels({
        base_url: s.base_url,
        username: s.username,
        password: s.password
      });
      for (const r of rows){
        out.push(normXtreamChannel(r, s.id));
      }
    }catch(e){
      console.warn('[refresh] Xtream fetch failed', s.base_url, e?.message || e);
    }
  }

  return out;
}

// ---- /api/refresh: Upsert OHNE enabled/number/tvg_id/epg_source zu überschreiben ----
app.post('/api/refresh', async (req, res) => {
  try {
    // optional: Status auf „running“ setzen, falls du /api/epg/status dafür verwendest
    // (kannst du weglassen, wenn du diese Route anders nutzt)
    await DB.exec('BEGIN');

    // Falls du die "seen"-Spalte hast (Migration A): alles erstmal auf 0
    try { await DB.run('UPDATE channels SET seen = 0'); } catch {}

    const importedChannels = await fetchAllSources(); // <<<<< hier wird sie gefüllt

    for (const ch of importedChannels){
      const external_id = ch.external_id && String(ch.external_id).trim() ? String(ch.external_id).trim() : null;

      // gibt es den Kanal bereits? Natürlicher Schlüssel: (type, source_id, coalesce(external_id, url))
      const existing = await DB.get(
        `SELECT id, external_id FROM channels
         WHERE source_type=? AND source_id=? AND COALESCE(external_id, url)=COALESCE(?, ?)`,
        [ch.source_type, ch.source_id, external_id, ch.url]
      );

      if (existing){
        // Metadaten aktualisieren – KEIN enabled/number/tvg_id/epg_source überschreiben
        await DB.run(
          `UPDATE channels SET name=?, group_name=?, logo=?, url=?, seen=1 WHERE id=?`,
          [ch.name, ch.group_name || null, ch.logo || null, ch.url, existing.id]
        );

        // external_id einmalig nachziehen, falls bisher leer
        if (!existing.external_id && external_id){
          await DB.run('UPDATE channels SET external_id=? WHERE id=?', [external_id, existing.id]);
        }
      } else {
        // neu einfügen (enabled=0, number=NULL)
        await DB.run(
          `INSERT INTO channels (source_type, source_id, external_id, name, group_name, logo, url, tvg_id, enabled, number, seen)
           VALUES (?,?,?,?,?,?,?,?,0,NULL,1)`,
          [ch.source_type, ch.source_id, external_id, ch.name, ch.group_name || null, ch.logo || null, ch.url, ch.tvg_id || null]
        );
      }
    }

    await DB.exec('COMMIT');
    return res.json({ ok:true, addedOrUpdated: importedChannels.length });
  } catch (e) {
    try { await DB.exec('ROLLBACK'); } catch {}
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});


app.post('/api/epg', (req,res)=>{
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const info = db.prepare('INSERT INTO epg_sources (name,url) VALUES (?,?)').run(name, url);
  res.json({ id: info.lastInsertRowid, name });
  // Autostart im Hintergrund:
  setTimeout(() => startBackgroundEPG(), 10);
});

app.get('/api/epg/channels', (req,res)=>{
  const idNames = readCombinedIdNames();
  const out = Object.entries(idNames).map(([id,names])=>({ id, names }));
  res.json(out);
});

// GET /api/channels?page=1&limit=100&search=sky&group=Movies&enabled=1&fields=id,name,number,group_name,tvg_id
// Express-Route: /api/channels

// ---- numbering helpers ----
async function compactNumbers(){
  const rows = await DB.all(`
    SELECT id FROM channels
    WHERE enabled = 1
    ORDER BY CASE WHEN number IS NULL THEN 1 ELSE 0 END, number, id
  `);
  let n = 1;
  for (const r of rows){
    await DB.run(`UPDATE channels SET number = ? WHERE id = ?`, [n, r.id]);
    n++;
  }
}
async function insertAtPosition(id, index){
  await DB.run(`
    UPDATE channels
    SET number = number + 1
    WHERE enabled = 1 AND number IS NOT NULL AND number >= ?
  `, [index]);
  await DB.run(`UPDATE channels SET enabled = 1, number = ? WHERE id = ?`, [index, id]);
  await compactNumbers();
}
async function appendToEnd(id){
  const row = await DB.get(`SELECT COALESCE(MAX(number),0) AS mx FROM channels WHERE enabled = 1`);
  const next = (row?.mx || 0) + 1;
  await DB.run(`UPDATE channels SET enabled = 1, number = ? WHERE id = ?`, [next, id]);
}

app.get('/api/channels', (req, res) => {
  try {
    const page    = Math.max(1, Number(req.query.page || 1));
    const limit   = Math.min(1000, Math.max(1, Number(req.query.limit || 100)));
    const q       = (req.query.q || '').trim();
    const group   = (req.query.group || '').trim();
    const enabled = String(req.query.enabled || '').trim().toLowerCase(); // "1" | "true" → enabled only

    // optionales Sorting
    const sortAllowed = new Set(['name', 'number', 'group_name', 'id']);
    const sort = sortAllowed.has(String(req.query.sort || '').trim()) ? String(req.query.sort).trim() : 'name';
    const dir  = String(req.query.dir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE 1=1';
    const params = [];

    if (q) {
      where += ' AND (name LIKE ? OR tvg_id LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (group) {
      where += ' AND (group_name = ?)';
      params.push(group);
    }
    if (enabled === '1' || enabled === 'true') {
      where += ' AND (enabled = 1)';
    }

    const offset = (page - 1) * limit;

    // total ermitteln
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM channels ${where}`).get(...params);
    const total = Number(totalRow?.n || 0);

    // page rows
    const stmt = db.prepare(`
      SELECT id, name, url, number, group_name, logo, tvg_id, epg_source, enabled
      FROM channels
      ${where}
      ORDER BY ${sort} ${dir}
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(...params, limit, offset);

    // Kein Cache → vermeidet 304-Spam bei UI-Reloads
    res.set('Cache-Control', 'no-store');
    res.json({ page, limit, total, rows });
  } catch (err) {
    console.error('[GET /api/channels] error:', err);
    res.status(500).json({ error: 'db_error', message: 'Failed to query channels' });
  }
});



app.patch('/api/channels/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { enabled, tvg_id, epg_source, insertAt } = req.body || {};
  try{
    await DB.exec('BEGIN');
    if (tvg_id !== undefined || epg_source !== undefined){
      await DB.run(
        `UPDATE channels SET
           tvg_id = COALESCE(?, tvg_id),
           epg_source = COALESCE(?, epg_source)
         WHERE id = ?`,
        [tvg_id ?? null, epg_source ?? null, id]
      );
    }
    if (enabled === true || enabled === 1){
      if (Number.isInteger(insertAt) && insertAt >= 1){
        await insertAtPosition(id, insertAt);
      } else {
        await appendToEnd(id);
        await compactNumbers();
      }
    } else if (enabled === false || enabled === 0){
      await DB.run(`UPDATE channels SET enabled = 0, number = NULL WHERE id = ?`, [id]);
      await compactNumbers();
    }
    await DB.exec('COMMIT');
    res.json({ ok:true });
  } catch(e){
    await DB.exec('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.post('/api/channels/:id/assign-epg', async (req,res)=>{
  const { id } = req.params;
  const { tvg_id, epg_source } = req.body || {};
  if (!tvg_id) return res.status(400).json({ error: 'tvg_id required' });
  const ch = await DB.get('SELECT * FROM channels WHERE id=?', [id]);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  await DB.run('UPDATE channels SET tvg_id=?, epg_source=? WHERE id=?', [tvg_id, epg_source||null, id]);
  res.json({ ok: true });
});

// Bulk-Aktionen (enable / disable / renumber)
app.post('/api/channels/bulk', async (req,res)=>{
  const { ids, action, startNumber } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids required' });
  }

  if (action === 'enable' || action === 'disable'){
    const en = action === 'enable' ? 1 : 0;
    try{
      await DB.exec('BEGIN');
      for (const id of ids){
        await DB.run('UPDATE channels SET enabled=? WHERE id=?', [en, id]);
      }
      await DB.exec('COMMIT');
      return res.json({ ok: true, updated: ids.length });
    }catch(e){
      await DB.exec('ROLLBACK');
      console.error(e);
      return res.status(500).json({ error: String(e.message||e) });
    }
  }

  if (action === 'renumber'){
    const start = Number(startNumber || 1);
    try{
      await DB.exec('BEGIN');
      let n = start;
      for (const id of ids){
        await DB.run('UPDATE channels SET number=? WHERE id=?', [n++, id]);
      }
      await DB.exec('COMMIT');
      return res.json({ ok:true, updated: ids.length });
    }catch(e){
      await DB.exec('ROLLBACK');
      console.error(e);
      return res.status(500).json({ error: String(e.message||e) });
    }
  }

  return res.status(400).json({ error: 'unknown action' });
});


app.get('/m3u', (req,res)=>{
  const rows = db.prepare('SELECT * FROM channels WHERE enabled=1 ORDER BY COALESCE(number, 9999), name').all();
  const withProxy = rows.map(r => ({ ...r, url: `${req.protocol}://${req.get('host')}/stream/${r.id}` }));
  const st = db.prepare('SELECT value FROM settings WHERE key=?').get('m3uIncludeChannelNumber');
  const includeChno = st ? JSON.parse(st.value) : true;
  res.type('application/x-mpegURL').send(buildM3U(withProxy, { includeChno }));
});

app.get('/xmltv', (req,res)=>{
  const file = getMergedFilePath();
  if (fs.existsSync(file)) return res.type('application/xml').send(fs.readFileSync(file));
  res.type('application/xml').send('<tv/>');
});

// HDHR
app.get('/', (req,res)=>res.json(getDiscover()));
app.get('/discover.json', (req,res)=>res.json(getDiscover()));
app.get('/lineup_status.json', (req,res)=>res.json(getLineupStatus()));
app.get('/lineup.json', (req,res)=>res.json(getLineup(req)));
app.get('/lineup', (req,res)=>res.json(getLineup(req)));

// Streaming
app.get('/stream/:id', async (req,res)=>{
  const { id } = req.params;
  const row = db.prepare('SELECT url FROM channels WHERE id=?').get(id);
  if (!row) return res.status(404).send('Channel not found');
  const st = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, (()=>{ try{return JSON.parse(r.value)}catch{return r.value} })()]));
  const transcoding = st.transcoding || {};
  const defFF = process.platform==='linux' ? '/usr/bin/ffmpeg' : (process.platform==='darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

  if (transcoding.enabled){
    const ff = transcoding.ffmpegPath || defFF;
    const v = transcoding.videoCodec || 'libx264';
    const a = transcoding.audioCodec || 'aac';
    const p = transcoding.preset || 'veryfast';
    const vb = transcoding.videoBitrate || '2500k';
    const ab = transcoding.audioBitrate || '128k';
    const ua = transcoding.userAgent || st.globalUserAgent || null;
    const args = ['-hide_banner','-loglevel','error']; if (ua) { args.push('-user_agent', ua); }
    args.push('-i', row.url, '-c:v', v, '-preset', p, '-b:v', vb, '-c:a', a, '-b:a', ab, '-f', 'mpegts', '-');
    res.setHeader('Content-Type', 'video/MP2T');
    const proc = spawn(ff, args);
    req.on('close', ()=>{ try{proc.kill('SIGTERM');}catch{} });
    proc.stdout.pipe(res);
    proc.on('close', ()=>{ try{res.end();}catch{} });
  } else {
    const ua = st.globalUserAgent;
    if (ua){
      try {
        const r = await fetch(row.url, { headers: {'user-agent': ua} });
        if (!r.ok || !r.body) return res.status(r.status||502).end();
        res.setHeader('Content-Type', r.headers.get('content-type') || 'video/MP2T');
        r.body.pipe(res);
      } catch(e){ res.status(502).end(String(e)); }
    } else {
      res.redirect(row.url);
    }
  }
});

// --- Simple Scheduler: EPG alle N Stunden aktualisieren ---
function scheduleEPGAutoRefresh(hours){
  const ms = Math.max(1, Number(hours||6)) * 3600 * 1000;
  setInterval(() => {
    try { startBackgroundEPG(); } catch {}
  }, ms);
}
// Wert aus Settings lesen (fallback 6h)
try {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('epgAutoRefreshHours');
  const hrs = row ? JSON.parse(row.value) : 6;
  scheduleEPGAutoRefresh(hrs);
} catch { scheduleEPGAutoRefresh(6); }

// --- Auto-Mapping Helpers ---
function normalizeName(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFKD')              // Umlaute -> ascii
    .replace(/[^\w\s]/g, ' ')       // Sonderzeichen raus
    .replace(/\s+/g, ' ')           // Mehrfachspaces -> 1
    .trim();
}
// sehr einfache Ähnlichkeit (Jaccard der Wortmengen + Präfixbonus)
function similarity(a, b){
  const A = new Set(normalizeName(a).split(' ').filter(Boolean));
  const B = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const pref = normalizeName(b).startsWith(normalizeName(a)) || normalizeName(a).startsWith(normalizeName(b)) ? 0.1 : 0;
  return Math.min(1, jaccard + pref);
}

// --- Auto-Mapping Endpoint ---
// Body: { source?: 'm3u'|'xtream', minScore?: 0.6, dryRun?: false, epgSource?: 'Name der EPG-Quelle oder "SF Dummy"' }
app.post('/api/mapping/auto', (req,res)=>{
  const { source, minScore = 0.6, dryRun = false, epgSource = null } = req.body || {};
  const idNamesMap = readCombinedIdNames();              // { id: [names...] }
  const channels = source
    ? db.prepare('SELECT * FROM channels WHERE source_type=? ORDER BY name').all(source)
    : db.prepare('SELECT * FROM channels ORDER BY name').all();

  let updated = 0, skipped = 0;
  const samples = [];

  const upd = db.prepare('UPDATE channels SET tvg_id=?, epg_source=? WHERE id=?');
  for (const ch of channels){
    if (ch.tvg_id) { skipped++; continue; }

    let best = { id:null, score:0, name:null };
    for (const [id, names] of Object.entries(idNamesMap)){
      // Wenn die Quelle keine Namen hat, immer noch per ID-Suche möglich – hier aber suchen wir per Namen:
      for (const n of (names || [])){
        const sc = similarity(ch.name, n);
        if (sc > best.score){ best = { id, score: sc, name: n }; }
      }
    }

    if (best.id && best.score >= minScore){
      if (!dryRun) upd.run(best.id, epgSource || ch.epg_source || null, ch.id);
      updated++;
      if (samples.length < 10) samples.push({ channel: ch.name, match: best.name, tvg_id: best.id, score: +best.score.toFixed(3) });
    } else {
      skipped++;
    }
  }

  res.json({ ok:true, updated, skipped, minScore, sample:samples });
});

app.get('/api/channels/groups', (req,res)=>{
  const rows = db.prepare('SELECT group_name g, COUNT(*) c FROM channels WHERE group_name IS NOT NULL GROUP BY group_name ORDER BY g').all();
  res.json(rows);
});

app.post('/api/channels/order', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  try{
    await DB.run('BEGIN');
    // erstmal alles auf NULL (nur enabled)
    await DB.run(`UPDATE channels SET number = NULL WHERE enabled = 1`);
    // dann in der gegebenen Reihenfolge 1..N setzen
    let n = 1;
    for (const id of ids){
      await DB.run(`UPDATE channels SET number = ? WHERE id = ?`, [n++, id]);
    }
    await DB.run('COMMIT');
    res.json({ ok:true, count: ids.length });
  }catch(e){
    await DB.run('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});