import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SaxesParser } from 'saxes';

const EPG_DIR = path.resolve('data/epg');
const NAME_IDX = path.join(EPG_DIR, 'name_index.json');
const ID_NAMES = path.join(EPG_DIR, 'id_names.json');

function streamFrom(file){
  const rs = fs.createReadStream(file);
  return file.endsWith('.gz') ? rs.pipe(zlib.createGunzip()) : rs;
}

async function indexOne(file){
  return await new Promise((resolve,reject)=>{
    const p = new SaxesParser({ xmlns:false });
    const namesById = new Map();

    let inChannel=false, currentChannelId=null, buf='';
    let inProgramme=false, currentProgId=null, inTitle=false, titleBuf='';

    p.on('opentag', n => {
      if (n.name==='channel'){ inChannel=true; currentChannelId=n.attributes?.id||null; buf=''; }
      else if (n.name==='programme'){ inProgramme=true; currentProgId=n.attributes?.channel||null; if (currentProgId && !namesById.has(currentProgId)) namesById.set(currentProgId,new Set()); }
      else if (n.name==='display-name' && inChannel){ buf=''; }
      else if (n.name==='title' && inProgramme){ inTitle=true; titleBuf=''; }
    });
    p.on('text', t => { if (inChannel) buf+=t; if (inProgramme && inTitle) titleBuf+=t; });
    p.on('closetag', name => {
      if (name==='display-name' && inChannel && currentChannelId){
        const v=buf.trim().toLowerCase(); if(v){ (namesById.get(currentChannelId)??new Set()).add(v); namesById.set(currentChannelId, namesById.get(currentChannelId)); }
        buf='';
      } else if (name==='channel'){ inChannel=false; currentChannelId=null; buf=''; }
      else if (name==='title' && inProgramme && currentProgId && inTitle){
        const t=titleBuf.trim().toLowerCase(); if(t){ const s=namesById.get(currentProgId)||new Set(); if(s.size===0) s.add(t); namesById.set(currentProgId,s); }
        inTitle=false; titleBuf='';
      } else if (name==='programme'){ inProgramme=false; currentProgId=null; inTitle=false; titleBuf=''; }
    });
    p.on('error', reject);
    p.on('end', ()=>{
      const nameToId={}, idToNames={};
      for (const [id,set] of namesById){
        idToNames[id]=Array.from(set);
        for (const n of set){ if(!nameToId[n]) nameToId[n]=id; }
      }
      resolve({ nameToId, idToNames });
    });

    const rs = streamFrom(file);
    rs.on('data', ch => p.write(ch.toString()));
    rs.on('end', () => p.close());
    rs.on('error', reject);
  });
}

(async ()=>{
  const files = fs.readdirSync(EPG_DIR)
    .filter(f => f.endsWith('.xml') || f.endsWith('.xml.gz'))
    .map(f => path.join(EPG_DIR, f));
  if (!files.length){ console.error('Keine EPG-Dateien gefunden'); process.exit(2); }

  const combinedNameToId = {};
  const combinedIdToNames = {};
  for (const f of files){
    console.log('Indexiere', path.basename(f));
    const { nameToId, idToNames } = await indexOne(f);
    Object.assign(combinedNameToId, nameToId);
    for (const [id, arr] of Object.entries(idToNames)){
      if (!combinedIdToNames[id]) combinedIdToNames[id] = [];
      for (const n of arr){ if (!combinedIdToNames[id].includes(n)) combinedIdToNames[id].push(n); }
    }
  }

  fs.writeFileSync(NAME_IDX, JSON.stringify(combinedNameToId));
  fs.writeFileSync(ID_NAMES, JSON.stringify(combinedIdToNames));
  console.log('OK:', Object.keys(combinedIdToNames).length, 'IDs');
})();
