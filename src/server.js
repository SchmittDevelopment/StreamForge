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
const __dirname = path.dirname(__filename);

const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const app = express();

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

app.get('/api/status', (req,res)=>{
  const m3u = db.prepare('SELECT COUNT(*) c FROM sources_m3u').get().c;
  const xt = db.prepare('SELECT COUNT(*) c FROM sources_xtream').get().c;
  const epg = db.prepare('SELECT COUNT(*) c FROM epg_sources').get().c;
  const ch = db.prepare('SELECT COUNT(*) c FROM channels').get().c;
  res.json({ m3u, xtream: xt, epg, channels: ch });
});

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

app.post('/api/refresh', async (req,res)=>{
  try { await doRefresh(); res.json({ ok: true }); }
  catch(e){ res.status(500).json({ error: String(e) }); }
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
app.get('/api/channels', (req, res) => {
  const page  = Math.max(1, Number(req.query.page||1));
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit||100)));
  const q     = (req.query.q||'').trim();
  const group = (req.query.group||'').trim();

  let where = 'WHERE 1=1';
  const params = [];
  if (q){
    where += ' AND (name LIKE ? OR tvg_id LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (group){
    where += ' AND group_name = ?';
    params.push(group);
  }

  const off = (page-1)*limit;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM channels ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT id, name, url, number, group_name, logo, tvg_id, epg_source, enabled
     FROM channels ${where}
     ORDER BY name ASC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, off);

  res.json({ page, limit, total, rows });
});


app.patch('/api/channels/:id', (req,res)=>{
  const { id } = req.params;
  const { enabled, name, number, group_name, logo, tvg_id } = req.body || {};
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const en = enabled===true ? 1 : (enabled===false ? 0 : null);
  db.prepare('UPDATE channels SET enabled=COALESCE(?,enabled), name=COALESCE(?,name), number=COALESCE(?,number), group_name=COALESCE(?,group_name), logo=COALESCE(?,logo), tvg_id=COALESCE(?,tvg_id) WHERE id=?')
    .run(en, name, number, group_name, logo, tvg_id, id);
  res.json({ ok: true });
});

app.post('/api/channels/:id/assign-epg', (req,res)=>{
  const { id } = req.params;
  const { tvg_id, epg_source } = req.body || {};
  if (!tvg_id) return res.status(400).json({ error: 'tvg_id required' });
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE channels SET tvg_id=?, epg_source=? WHERE id=?').run(tvg_id, epg_source||null, id);
  res.json({ ok: true });
});

app.post('/api/channels/bulk', (req,res)=>{
  const { ids, action, startNumber } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (action === 'enable' || action === 'disable'){
    const en = action === 'enable' ? 1 : 0;
    const stmt = db.prepare('UPDATE channels SET enabled=? WHERE id=?');
    const tx = db.transaction(arr => { for (const id of arr) stmt.run(en, id); });
    tx(ids);
    return res.json({ ok: true, updated: ids.length });
  }
  if (action === 'renumber'){
    let n = Number(startNumber ?? 0);
    const stmt = db.prepare('UPDATE channels SET number=? WHERE id=?');
    const tx = db.transaction(arr => { for (const id of arr) stmt.run(n++, id); });
    tx(ids);
    return res.json({ ok: true, updated: ids.length });
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


app.listen(cfg.PORT, cfg.HOST, ()=>{
  console.log(`Listening on http://${cfg.HOST}:${cfg.PORT} — Web UI at /web`);
});

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