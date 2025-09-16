import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import zlib from 'node:zlib';
import { SaxesParser } from 'saxes';
import cfg from './config.js';

const META_FILE   = path.join(cfg.EPG_DIR, 'meta.json');
const MERGED_FILE = path.join(cfg.EPG_DIR, 'merged.xml');
const NAME_IDX    = path.join(cfg.EPG_DIR, 'name_index.json');   // name -> id
const ID_NAMES    = path.join(cfg.EPG_DIR, 'id_names.json');     // id -> [names]

function readMeta(){ try { return JSON.parse(fs.readFileSync(META_FILE,'utf-8')); } catch { return {}; } }
function writeMeta(m){ fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2)); }
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function fetchWithCache(url,{etag,lastModified,timeout=30000,tries=3,backoff=800}={}){
  const headers={'accept':'*/*','accept-encoding':'gzip, deflate, br','user-agent':'StreamForge/EPG'};
  if(etag) headers['if-none-match']=etag;
  if(lastModified) headers['if-modified-since']=lastModified;
  let lastErr;
  for(let i=0;i<tries;i++){
    try{
      const res=await fetch(url,{headers,timeout});
      if(res.status===304) return {status:304};
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const enc=res.headers.get('content-encoding')||'';
      const lm=res.headers.get('last-modified')||null;
      const et=res.headers.get('etag')||null;
      let stream=res.body;
      if(enc.includes('gzip')) stream=stream.pipe(zlib.createGunzip());
      else if(enc.includes('br')) stream=stream.pipe(zlib.createBrotliDecompress());
      else if(enc.includes('deflate')) stream=stream.pipe(zlib.createInflate());
      return {status:200,stream,etag:et,lastModified:lm};
    }catch(e){ lastErr=e; if(i<tries-1) await sleep(backoff*Math.pow(2,i)); }
  }
  throw lastErr;
}

async function buildIndexesFromStream(readable){
  return await new Promise((resolve,reject)=>{
    const p = new SaxesParser({ xmlns:false });

    // id -> Set(namen)   (namen in lowercase)
    const namesById = new Map();

    // State für <channel> Bereich
    let inChannel = false, currentChannelId = null, buf = '';

    // State für <programme> Bereich (für Fallback-Namen)
    let inProgramme = false, currentProgId = null, inTitle = false, titleBuf = '';

    p.on('opentag', node => {
      const name = node.name;
      if (name === 'channel') {
        inChannel = true;
        currentChannelId = node.attributes?.id || null;
        buf = '';
      } else if (name === 'programme') {
        inProgramme = true;
        currentProgId = node.attributes?.channel || null;
        // ID registrieren, auch wenn (noch) kein Name vorhanden
        if (currentProgId && !namesById.has(currentProgId)) namesById.set(currentProgId, new Set());
      } else if (name === 'display-name' && inChannel) {
        buf = '';
      } else if (name === 'title' && inProgramme) {
        inTitle = true;
        titleBuf = '';
      }
    });

    p.on('text', t => {
      if (inChannel) buf += t;
      if (inProgramme && inTitle) titleBuf += t;
    });

    p.on('closetag', name => {
      if (name === 'display-name' && inChannel && currentChannelId) {
        const n = buf.trim();
        if (n) {
          const set = namesById.get(currentChannelId) ?? new Set();
          set.add(n.toLowerCase());
          namesById.set(currentChannelId, set);
        }
        buf = '';
      } else if (name === 'channel') {
        inChannel = false; currentChannelId = null; buf = '';
      } else if (name === 'title' && inProgramme && currentProgId && inTitle) {
        // Ersten gefundenen Titel als Fallback-Namen verwenden, falls noch kein Name existiert
        const t = titleBuf.trim();
        if (t) {
          const set = namesById.get(currentProgId) ?? new Set();
          if (set.size === 0) set.add(t.toLowerCase());
          namesById.set(currentProgId, set);
        }
        inTitle = false; titleBuf = '';
      } else if (name === 'programme' && inProgramme) {
        inProgramme = false; currentProgId = null; inTitle = false; titleBuf = '';
      }
    });

    p.on('error', reject);
    p.on('end', ()=>{
      const nameToId = {};
      const idToNames = {};
      for (const [id,set] of namesById){
        idToNames[id] = Array.from(set);
        for (const n of set){ if (!nameToId[n]) nameToId[n] = id; }
      }
      resolve({ nameToId, idToNames });
    });

    readable.on('data', chunk => p.write(chunk.toString()));
    readable.on('end', () => p.close());
    readable.on('error', reject);
  });
}


function mergeEPGStrings(files){
  const chanSet=new Set(); const progSet=new Set();
  for(const file of files){
    if(!fs.existsSync(file)) continue;
    const xml=fs.readFileSync(file,'utf-8');
    const chans = xml.match(/<channel\b[\s\S]*?<\/channel>/g)   || [];
    const progs = xml.match(/<programme\b[\s\S]*?<\/programme>/g) || [];
    for(const c of chans){ chanSet.add(c); }
    for(const p of progs){ progSet.add(p); }
  }
  return `<tv>${Array.from(chanSet).join('')}${Array.from(progSet).join('')}</tv>`;
}

export async function refreshEPG(sources,onProgress=()=>{}){
  if(!sources?.length) return {changed:false,files:[]};
  const meta=readMeta(); const results=[]; let changedAny=false;

  const limit=4; let i=0;
  async function worker(){
    while(i<sources.length){
      const idx=++i; const s=sources[idx-1];
      onProgress({phase:'download',index:idx,total:sources.length,name:s.name});
      const key=s.name.replace(/[^a-z0-9_-]/ig,'_');
      const file=path.join(cfg.EPG_DIR,`${key}.xml`);
      const m=meta[key]||{};
      try{
        const res=await fetchWithCache(s.url,{etag:m.etag,lastModified:m.lastModified});
        if(res.status===304){
          results.push({name:s.name,file,changed:false});
        }else{
          await new Promise((resolve,reject)=>{ const ws=fs.createWriteStream(file); res.stream.pipe(ws); ws.on('finish',resolve); ws.on('error',reject); });
          meta[key]={etag:res.etag||null,lastModified:res.lastModified||null,updatedAt:Date.now()}; changedAny=true;
          onProgress({phase:'index',name:s.name});
          const rs=fs.createReadStream(file);
          const { nameToId, idToNames } = await buildIndexesFromStream(rs);
          fs.writeFileSync(path.join(cfg.EPG_DIR,`${key}.index.json`),   JSON.stringify(nameToId));
          fs.writeFileSync(path.join(cfg.EPG_DIR,`${key}.idnames.json`), JSON.stringify(idToNames));
          results.push({name:s.name,file,changed:true});
        }
      }catch(e){ results.push({name:s.name,file,error:String(e)}); }
    }
  }
  await Promise.all(new Array(Math.min(limit,sources.length)).fill(0).map(()=>worker()));
  writeMeta(meta);

  const combinedNameToId={};
  const combinedIdToNames={};
  for(const s of sources){
    const key=s.name.replace(/[^a-z0-9_-]/ig,'_');
    const ni=path.join(cfg.EPG_DIR,`${key}.index.json`);
    const inames=path.join(cfg.EPG_DIR,`${key}.idnames.json`);
    if(fs.existsSync(ni)){ try{ Object.assign(combinedNameToId, JSON.parse(fs.readFileSync(ni,'utf-8'))); }catch{} }
    if(fs.existsSync(inames)){
      try{
        const obj = JSON.parse(fs.readFileSync(inames,'utf-8'));
        for(const [id,arr] of Object.entries(obj)){
          if(!combinedIdToNames[id]) combinedIdToNames[id]=[];
          for(const n of arr){ if(!combinedIdToNames[id].includes(n)) combinedIdToNames[id].push(n); }
        }
      }catch{}
    }
  }

  // Inject SF Dummy index (not shown in source list)
  combinedNameToId['sf dummy channel'] = 'SF_DUMMY_CH';
  if(!combinedIdToNames['SF_DUMMY_CH']) combinedIdToNames['SF_DUMMY_CH'] = ['sf dummy channel'];

  fs.writeFileSync(NAME_IDX, JSON.stringify(combinedNameToId));
  fs.writeFileSync(ID_NAMES, JSON.stringify(combinedIdToNames));

  const files = sources.map(s => path.join(cfg.EPG_DIR, `${s.name.replace(/[^a-z0-9_-]/ig,'_')}.xml`));
  if(changedAny || !fs.existsSync(MERGED_FILE)){
    onProgress({phase:'merge'});
    const merged = mergeEPGStrings(files);
    fs.writeFileSync(MERGED_FILE, merged);
  }
  return {changed:changedAny,files:results};
}

export function readCombinedIndex(){ try{ return JSON.parse(fs.readFileSync(NAME_IDX,'utf-8')); }catch{ return {}; } }
export function readCombinedIdNames(){ try{ return JSON.parse(fs.readFileSync(ID_NAMES,'utf-8')); }catch{ return {}; } }
export function getMergedFilePath(){ return MERGED_FILE; }
