#!/usr/bin/env node
import fs from 'node:fs';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';

function arg(name, def=null){
  const i = process.argv.indexOf('--'+name);
  if (i>=0 && process.argv[i+1]) return process.argv[i+1];
  return def;
}

const DB_FILE = arg('db','./data/streamforge.sqlite');
const M3U_URL = arg('m3u', null);
const XT_BASE = arg('xtream-base', null);
const XT_USER = arg('user', null);
const XT_PASS = arg('pass', null);

if (!DB_FILE) { console.error('Missing --db'); process.exit(1); }
if (!M3U_URL && !(XT_BASE && XT_USER && XT_PASS)) {
  console.error('Provide either --m3u URL or --xtream-base/--user/--pass'); process.exit(1);
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS channels (
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
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_name     ON channels(name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_group    ON channels(group_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_enabled  ON channels(enabled)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_tvg_id   ON channels(tvg_id)`);

const ins = db.prepare(`INSERT INTO channels(name,url,number,group_name,logo,tvg_id,enabled,source_type,source_id)
                        VALUES(@name,@url,@number,@group_name,@logo,@tvg_id,@enabled,@source_type,@source_id)`);

async function importM3U(url){
  console.log('Fetching M3U:', url);
  const res = await fetch(url, {headers:{'user-agent':'StreamForge/Indexer'}});
  if (!res.ok) throw new Error('HTTP '+res.status);
  const rl = readline.createInterface({ input: Readable.from(res.body), crlfDelay: Infinity });
  let cur = null, n=0;
  for await (const raw of rl){
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')){
      const name = line.split(',').slice(-1)[0]?.trim();
      const tvgId = /tvg-id="([^"]*)"/i.exec(line)?.[1] || null;
      const tvgName = /tvg-name="([^"]*)"/i.exec(line)?.[1] || null;
      const group = /group-title="([^"]*)"/i.exec(line)?.[1] || null;
      const logo  = /tvg-logo="([^"]*)"/i.exec(line)?.[1] || /logo="([^"]*)"/i.exec(line)?.[1] || null;
      const chno  = /tvg-chno="([^"]*)"/i.exec(line)?.[1] || null;
      cur = { name: tvgName || name || 'Channel', tvg_id: tvgId, group_name: group, logo, number: chno ? Number(chno) : null };
    } else if (!line.startsWith('#') && cur){
      const row = { ...cur, url: line, enabled: 1, source_type:'m3u', source_id:null };
      ins.run(row); n++;
      cur = null;
      if (n % 1000 === 0) console.log('Imported', n);
    }
  }
  console.log('Done. Imported', n);
}

async function importXtream(base, user, pass){
  function normBase(u){ if(!/^https?:\/\//i.test(u)) u='http://'+u; return u.replace(/\/+$/, ''); }
  const b = normBase(base);
  const listUrl = `${b}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
  console.log('Fetching Xtream list:', listUrl);
  const res = await fetch(listUrl, {headers:{'user-agent':'StreamForge/Indexer'}});
  if (!res.ok) throw new Error('HTTP '+res.status);
  const arr = await res.json();
  let n=0;
  for (const i of arr){
    const row = {
      name: i.name || `Channel ${i.stream_id}`,
      url: `${b}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${i.stream_id}.ts`,
      number: null,
      group_name: i.category_name || null,
      logo: i.stream_icon || null,
      tvg_id: i.epg_channel_id || null,
      enabled: 1,
      source_type: 'xtream',
      source_id: null,
    };
    ins.run(row); n++;
    if (n % 1000 === 0) console.log('Imported', n);
  }
  console.log('Done. Imported', n);
}

(async () => {
  if (M3U_URL)       await importM3U(M3U_URL);
  if (XT_BASE)       await importXtream(XT_BASE, XT_USER, XT_PASS);
})();