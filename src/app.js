/* app.js — Dual-Pane Mapping with robust Drag&Drop (Drop Zones + Row-Half + Animated Gaps)
   - Left: source channels (Xtream/M3U), Right: enabled channels
   - Drag from left→right inserts at a drop zone or via row-half (before/after)
   - Drag within right reorders locally; numbers auto-update (#1, #2, ...)
   - Debounced auto-persist of order; Startnummer steuerbar
   - Search + pagination on both panes (server-side)
   - EPG assignment (dropdown + suggest) on right rows
   - Single debounce; fetch() with {cache:'no-cache'}
*/

// -------------------- Utils & Globals --------------------
async function fetchJSON(url, opts){
  const r = await fetch(url, Object.assign({ cache: 'no-cache' }, opts||{}));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function showLoading(show){
  const ov = document.getElementById('loadingOverlay');
  const main = document.querySelector('main');
  if (!ov || !main) return;
  ov.classList.toggle('hidden', !show);
  main.classList.toggle('pointer-events-none', show);
  main.classList.toggle('opacity-50', show);
}

function showToast(msg, type){
  let host = document.getElementById('toastHost');
  if (!host){
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'fixed top-4 right-4 z-[9999] space-y-2';
    document.body.appendChild(host);
  }
  const note = document.createElement('div');
  const color = type==='error' ? 'bg-red-600' : (type==='warn' ? 'bg-amber-600' : 'bg-emerald-600');
  note.className = color + ' text-white px-4 py-3 rounded-xl shadow-lg transition opacity-0';
  note.textContent = msg;
  host.appendChild(note);
  requestAnimationFrame(()=>note.classList.remove('opacity-0'));
  setTimeout(()=>{ note.classList.add('opacity-0'); setTimeout(()=>note.remove(), 300); }, 2200);
}

// single debounce (define once)
function debounce(fn, wait = 250){
  let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); };
}

// Inject DnD gap CSS once
(function(){
  if (document.getElementById('dndGapCSS')) return;
  const s = document.createElement('style');
  s.id = 'dndGapCSS';
  s.textContent = `
    .dropZone{height:8px; transition: height .12s ease, background-color .12s ease;}
    .dropZone.activeGap{height:28px;}
  `;
  document.head.appendChild(s);
})();

// Global state
let EPG_IDX = {};
let ID_NAMES = [];
let GLOBAL_EPG_SOURCES = null;

window.DND = window.DND || { draggingId: null, source: null, item: null };
window.DRAG_LOCK = window.DRAG_LOCK || false;

let LEFT_STATE  = { page: 1, limit: 100, q: '', group: '', total: 0 };
let RIGHT_STATE = { page: 1, limit: 100, q: '', total: 0 };
let LEFT_ROWS = [];
let RIGHT_ROWS = [];

// -------------------- EPG helpers --------------------
async function getEpgSourcesCached(){
  if (GLOBAL_EPG_SOURCES) return GLOBAL_EPG_SOURCES;
  try { GLOBAL_EPG_SOURCES = await fetchJSON('/api/epg/sources'); }
  catch { GLOBAL_EPG_SOURCES = []; }
  return GLOBAL_EPG_SOURCES;
}

async function loadEPGIndex(){
  try { 
    const arr = await fetchJSON('/api/epg/channels');
    ID_NAMES = arr;
    EPG_IDX = {};
    for (const it of arr){
      for (const n of (it.names||[])){ EPG_IDX[n.toLowerCase()] = it.id; }
    }
  } catch { EPG_IDX = {}; ID_NAMES = []; }
}

function epgSuggest(term){
  const t = (term||'').toLowerCase().trim();
  if (!t) return [];
  const hits = [];
  const seen = new Set();
  for (const [name,id] of Object.entries(EPG_IDX)){
    if (name.includes(t) && !seen.has(id)) { hits.push({ id, name }); seen.add(id); }
    if (hits.length >= 8) break;
  }
  if (hits.length < 8){
    for (const it of (ID_NAMES||[])){
      const idStr = String(it.id||'').toLowerCase();
      if (idStr.includes(t) && !seen.has(it.id)){
        hits.push({ id: it.id, name: (it.names && it.names[0]) || it.id });
        seen.add(it.id);
      }
      if (hits.length >= 8) break;
    }
  }
  return hits;
}

// -------------------- Wizard & Sources --------------------
async function checkWizard(){
  try {
    const s = await fetchJSON('/api/status');
    const hasAnySource = (s.m3u + s.xtream) > 0;
    const w = document.getElementById('setupWizard');
    if (w) w.classList.toggle('hidden', hasAnySource);
  } catch {}
}

async function loadSources(){
  const wrapM = document.getElementById('m3uList'); if (!wrapM) return;
  const data = await fetchJSON('/api/sources');
  const m = data.m3u || []; const x = data.xtream || [];
  const parts = [];
  if (m.length){
    parts.push('<div class="mb-2 font-semibold text-slate-300">M3U Sources</div>');
    for (const s of m){
      parts.push(`<div class="flex items-center justify-between text-xs bg-slate-800/60 rounded p-2 mb-1"><div class="truncate"><b>${s.name}</b> — ${s.url}</div><button data-type="m3u" data-id="${s.id}" class="delSource px-2 py-1 rounded bg-red-600 hover:bg-red-500">Delete</button></div>`);
    }
  }
  if (x.length){
    parts.push('<div class="mt-3 mb-2 font-semibold text-slate-300">Xtream Sources</div>');
    for (const s of x){
      parts.push(`<div class="flex items-center justify-between text-xs bg-slate-800/60 rounded p-2 mb-1"><div class="truncate"><b>${s.name}</b> — ${s.base_url}</div><button data-type="xtream" data-id="${s.id}" class="delSource px-2 py-1 rounded bg-red-600 hover:bg-red-500">Delete</button></div>`);
    }
  }
  wrapM.innerHTML = parts.join('') || 'No sources yet.';
  document.querySelectorAll('.delSource').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const t = btn.getAttribute('data-type'); const id = btn.getAttribute('data-id');
      if (!confirm('Delete this source?')) return;
      await fetchJSON(`/api/sources/${t}/${id}`, { method:'DELETE' });
      await loadSources(); await loadEPGSources(); await checkWizard();
    });
  });
}

async function loadEPGSources(){
  const host = document.getElementById('epgList'); if (!host) return;
  try{
    const list = await fetchJSON('/api/epg/sources');
    host.innerHTML = list.map(x => {
      const badge = x.status === 'active' ? '<span class="ml-2 text-xs px-2 py-1 rounded bg-emerald-700">active</span>' : '<span class="ml-2 text-xs px-2 py-1 rounded bg-red-700">pending</span>';
      return `<div class="flex items-center justify-between bg-slate-800/60 rounded p-2"><div class="truncate"><b>${x.name}</b> — ${x.url}</div><div>${badge}</div></div>`;
    }).join('') || '<div class="text-slate-400">Keine EPG Quellen.</div>';
  }catch(e){ host.innerHTML = '<div class="text-red-400">Fehler beim Laden der EPG-Liste</div>'; }
}

// -------------------- Channels API wrapper --------------------
async function fetchChannelsRobust(params = {}){
  const u = new URL('/api/channels', location.origin);
  for (const [k,v] of Object.entries(params)) if (v!=='' && v!=null) u.searchParams.set(k, String(v));
  const r = await fetch(u, { cache: 'no-cache' });
  const ct = (r.headers.get('content-type')||'').toLowerCase();
  let payload = ct.includes('application/json') ? await r.json()
              : { page: Number(params.page||1), limit: Number(params.limit||100), total: 0, rows: [] };
  const rows = Array.isArray(payload) ? payload : (payload.rows||[]);
  const page  = Number((Array.isArray(payload) ? params.page : payload.page) || 1);
  const limit = Number((Array.isArray(payload) ? params.limit : payload.limit) || rows.length || 100);
  const total = Number((Array.isArray(payload) ? rows.length : payload.total) || rows.length);
  const norm = rows.filter(Boolean).map(ch => ({
    id: ch.id ?? ch.channel_id ?? ch.stream_id ?? null,
    name: ch.name ?? ch.channelName ?? 'Channel',
    group_name: ch.group_name ?? ch.group ?? ch.category_name ?? '',
    tvg_id: ch.tvg_id ?? ch.epg_channel_id ?? '',
    logo: ch.logo ?? ch.tvg_logo ?? '',
    number: (ch.number != null) ? Number(ch.number) : null,
    url: ch.url ?? ch.stream_url ?? '',
    enabled: ch.enabled ?? ch.enable ?? false,
    epg_source: ch.epg_source ?? null,
  })).filter(c => c.url);
  return { page, limit, total, rows: norm };
}

async function loadLeft(){
  if (window.DRAG_LOCK) return;
  const { page, limit, q, group } = LEFT_STATE;
  const res = await fetchChannelsRobust({ page, limit, q, group });
  LEFT_STATE.page = res.page; LEFT_STATE.limit = res.limit; LEFT_STATE.total = res.total;
  LEFT_ROWS = res.rows;
  renderDualPane();
}

async function loadRight(){
  if (window.DRAG_LOCK) return;
  const { page, limit, q } = RIGHT_STATE;
  const res = await fetchChannelsRobust({ page, limit, q, enabled: 1 });
  RIGHT_STATE.page = res.page; RIGHT_STATE.limit = res.limit; RIGHT_STATE.total = res.total || res.rows.length;
  RIGHT_ROWS = res.rows.filter(c => c.enabled === true || c.enabled === 1);
  // sort by channel number if present, then by name
  RIGHT_ROWS.sort((a,b)=>{
    const na = (a.number==null? Number.POSITIVE_INFINITY : a.number);
    const nb = (b.number==null? Number.POSITIVE_INFINITY : b.number);
    if (na!==nb) return na-nb;
    return String(a.name).localeCompare(String(b.name));
  });
  renderDualPane();
}

async function initDualPaneMapping(){
  await Promise.all([loadLeft(), loadRight()]);
}

// -------------------- Enable/Disable/Reorder + numbering --------------------
function renumberRightLocal(start=1){
  for (let i=0;i<RIGHT_ROWS.length;i++){ RIGHT_ROWS[i].number = start + i; }
}
async function persistRightOrder(){
  const start = Number(document.getElementById('startNumberDual')?.value || 1);
  const ids = RIGHT_ROWS.map(x => x.id);
  if (!ids.length) return;
  try{
    await fetchJSON('/api/channels/bulk', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, action:'renumber', startNumber: start })
    });
  }catch(e){ console.warn('persistRightOrder failed', e); }
}
const persistRightOrderDebounced = debounce(persistRightOrder, 700);

async function enableChannel(id, dropIndex){
  try {
    const body = (typeof dropIndex === 'number')
      ? { enabled: true, insertAt: Number(dropIndex) + 1 } // server expects 1-based
      : { enabled: true };
    await fetchJSON('/api/channels/'+id, {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    showToast('Hinzugefügt');
    await loadRight();
  } catch(e){
    console.error(e);
    showToast('Konnte nicht hinzufügen','error');
  }
}

async function disableChannel(id){
  try {
    await fetchJSON('/api/channels/'+id, {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ enabled: false })
    });
    showToast('Entfernt');
    await Promise.all([loadLeft(), loadRight()]);
  } catch(e){
    console.error(e);
    showToast('Konnte nicht entfernen','error');
  }
}

async function reorderRight(id, dropIndex){
  const i = RIGHT_ROWS.findIndex(x => x.id === id);
  if (i < 0) return;
  const target = Math.min(Math.max(dropIndex, 0), RIGHT_ROWS.length);
  const [item] = RIGHT_ROWS.splice(i, 1);
  const adjusted = (i < target) ? target - 1 : target;
  RIGHT_ROWS.splice(adjusted, 0, item);
  // persist new order server-side: 1..N
  try{
    const ids = RIGHT_ROWS.map(x => x.id);
    await fetchJSON('/api/channels/order', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids })
    });
  }catch(e){ console.warn('order persist failed', e); }
  await loadRight(); // reload to get canonical numbers
}

async function saveRightOrder(){
  const start = Number(document.getElementById('startNumberDual')?.value || 1);
  const ids = RIGHT_ROWS.map(x => x.id);
  if (!ids.length) return showToast('Keine Einträge rechts','warn');
  try{
    await fetchJSON('/api/channels/bulk', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, action:'renumber', startNumber: start })
    });
    showToast('Reihenfolge gespeichert');
    await Promise.all([loadLeft(), loadRight()]);
  }catch(e){
    console.error(e);
    showToast('Renumber fehlgeschlagen','error');
  }
}

// -------------------- Drop Zones (Right Pane) --------------------
let ACTIVE_GAP_IDX = null;
function setActiveGap(container, idx){
  if (!container) return;
  container.querySelectorAll('.dropZone.activeGap').forEach(z => z.classList.remove('activeGap'));
  if (idx == null || isNaN(idx)) { ACTIVE_GAP_IDX = null; return; }
  const z = container.querySelector(`.dropZone[data-index="${idx}"]`);
  if (z){ z.classList.add('activeGap'); ACTIVE_GAP_IDX = idx; }
}
function clearActiveGap(container){
  setActiveGap(container, null);
}

function buildRightDropZones(container){
  container.querySelectorAll('.dropZone').forEach(z => z.remove());

  const rows = Array.from(container.querySelectorAll('.rightRow'));

  const makeZone = (idx)=>{
    const z = document.createElement('div');
    z.className = 'dropZone h-3 md:h-4 my-1 mx-2 rounded bg-transparent transition-colors';
    z.dataset.index = String(idx);

    z.addEventListener('dragover', (e)=>{
      e.preventDefault();
      setActiveGap(container, idx);
      z.classList.add('bg-indigo-500/60');
      e.dataTransfer.dropEffect = (DND.source === 'right') ? 'move' : 'copy';
    });
    z.addEventListener('dragleave', ()=>{
      clearActiveGap(container);
      z.classList.remove('bg-indigo-500/60');
    });
    z.addEventListener('drop', async (e)=>{
      e.preventDefault();
      clearActiveGap(container);
      z.classList.remove('bg-indigo-500/60');
      const idxNum = Number(z.dataset.index);
      const draggedId = Number(DND.draggingId);
      if (!draggedId && !DND.item) return;

      if (DND.source === 'left'){
        await enableChannel(draggedId, idxNum);
      } else if (DND.source === 'right'){
        reorderRight(draggedId, idxNum);
      }

      window.DRAG_LOCK = false;
      document.body.classList.remove('select-none');
      DND.draggingId = null; DND.source = null; DND.item = null;
    });

    return z;
  };

  container.insertBefore(makeZone(0), rows[0] || null);
  rows.forEach((row, i)=>{
    const after = makeZone(i+1);
    container.insertBefore(after, row.nextSibling);
  });
}

// -------------------- Renderer --------------------
function renderDualPane(){
  const host = document.getElementById('groupedChannels');
  if (!host) return;

  host.innerHTML = `
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <!-- LEFT: Quelle -->
    <div class="rounded-2xl border border-slate-800 overflow-hidden">
      <div class="bg-slate-900 px-3 py-2 flex items-center gap-2">
        <div class="font-semibold">Quelle (Xtream / M3U)</div>
        <div class="ml-auto flex items-center gap-2">
          <input id="leftSearch" class="px-3 py-2 rounded bg-slate-800 text-sm w-40" placeholder="Suche Quelle…" value="${LEFT_STATE.q.replace(/"/g,'&quot;')}" />
          <select id="leftPageSize" class="px-2 py-1 rounded bg-slate-800 text-sm">
            <option ${LEFT_STATE.limit==50?'selected':''} value="50">50</option>
            <option ${LEFT_STATE.limit==100?'selected':''} value="100">100</option>
            <option ${LEFT_STATE.limit==200?'selected':''} value="200">200</option>
          </select>
          <button id="leftPrev" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">◀</button>
          <span class="text-slate-300 text-sm" id="leftInfo"></span>
          <button id="leftNext" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">▶</button>
        </div>
      </div>
      <div id="leftList" class="bg-slate-900/50 divide-y divide-slate-800 min-h-[320px]"></div>
    </div>

    <!-- RIGHT: Ausgewählt/Enabled -->
    <div class="rounded-2xl border border-slate-800 overflow-hidden">
      <div class="bg-slate-900 px-3 py-2 flex items-center gap-2">
        <div class="font-semibold">Ausgewählt (Enabled)</div>
        <div class="ml-auto flex items-center gap-2">
          <input id="rightSearch" class="px-3 py-2 rounded bg-slate-800 text-sm w-40" placeholder="Suche Enabled…" value="${RIGHT_STATE.q.replace(/"/g,'&quot;')}" />
          <select id="rightPageSize" class="px-2 py-1 rounded bg-slate-800 text-sm">
            <option ${RIGHT_STATE.limit==50?'selected':''} value="50">50</option>
            <option ${RIGHT_STATE.limit==100?'selected':''} value="100">100</option>
            <option ${RIGHT_STATE.limit==200?'selected':''} value="200">200</option>
          </select>
          <button id="rightPrev" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">◀</button>
          <span class="text-slate-300 text-sm" id="rightInfo"></span>
          <button id="rightNext" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">▶</button>
        </div>
      </div>
      <div id="rightList" class="bg-slate-900/50 min-h-[320px]"></div>

      <div class="bg-slate-900/70 px-3 py-2 flex items-center gap-2">
        <label class="text-xs text-slate-300">Startnummer:</label>
        <input id="startNumberDual" class="px-2 py-1 rounded bg-slate-800 text-sm w-24" placeholder="z.B. 1" value="1" />
        <button id="saveOrder" class="px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-sm">Reihenfolge speichern</button>
      </div>
    </div>
  </div>
  `;

  const leftInfo  = document.getElementById('leftInfo');
  const rightInfo = document.getElementById('rightInfo');
  if (leftInfo)  leftInfo.textContent  = `Seite ${LEFT_STATE.page} / ${Math.max(1, Math.ceil((LEFT_STATE.total||0)/LEFT_STATE.limit))} • ${LEFT_STATE.total||0} Einträge`;
  if (rightInfo) rightInfo.textContent = `Seite ${RIGHT_STATE.page} / ${Math.max(1, Math.ceil((RIGHT_STATE.total||0)/RIGHT_STATE.limit))} • ${RIGHT_STATE.total||0} Einträge`;

  // LEFT list
  const leftHost = document.getElementById('leftList');
  LEFT_ROWS.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'leftRow p-2 flex items-start justify-between gap-2';
    row.draggable = true;
    row.dataset.id = ch.id;
    row.addEventListener('dragstart', (e)=>{
      window.DRAG_LOCK = true;
      document.body.classList.add('select-none');
      DND.draggingId = ch.id; DND.source = 'left'; DND.item = ch;
      try { e.dataTransfer.setData('text/plain', String(ch.id)); } catch {}
      e.dataTransfer.effectAllowed = 'copy';
    });
    row.addEventListener('dragend', ()=>{
      window.DRAG_LOCK = false;
      document.body.classList.remove('select-none');
    });

    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <img src="${ch.logo||''}" onerror="this.style.display='none'" class="w-6 h-6 rounded shrink-0" />
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">${ch.name}</div>
          <div class="text-xs text-slate-400 truncate">${ch.group_name||''}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button class="enableBtn px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs">Hinzufügen</button>
      </div>
    `;
    row.querySelector('.enableBtn').addEventListener('click', ()=> enableChannel(ch.id));
    leftHost.appendChild(row);
  });

  // RIGHT list
  const rightHost = document.getElementById('rightList');

  RIGHT_ROWS.forEach((ch) => {
    const row = document.createElement('div');
    row.className = 'rightRow p-2 flex items-start justify-between gap-2';
    row.draggable = true;
    row.dataset.id = ch.id;

    row.addEventListener('dragstart', (e)=>{
      window.DRAG_LOCK = true;
      document.body.classList.add('select-none');
      DND.draggingId = ch.id; DND.source = 'right'; DND.item = ch;
      try { e.dataTransfer.setData('text/plain', String(ch.id)); } catch {}
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', ()=>{
      window.DRAG_LOCK = false;
      document.body.classList.remove('select-none');
    });

    // Drop auf Zeile: obere Hälfte = davor, untere Hälfte = danach
    row.addEventListener('dragover', (e)=>{
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > (r.top + r.height/2);
      const baseIdx = RIGHT_ROWS.findIndex(x => x.id === ch.id);
      const idx = baseIdx + (after ? 1 : 0);
      row.classList.add('ring-1','ring-indigo-500');
      row.dataset.dropIndex = String(idx);
      const rightHost = document.getElementById('rightList');
      setActiveGap(rightHost, idx);
      e.dataTransfer.dropEffect = (DND.source === 'right') ? 'move' : 'copy';
    });
    row.addEventListener('dragleave', ()=>{
      row.classList.remove('ring-1','ring-indigo-500');
      delete row.dataset.dropIndex;
      const rightHost = document.getElementById('rightList');
      clearActiveGap(rightHost);
    });
    row.addEventListener('drop', (e)=>{
      e.preventDefault();
      row.classList.remove('ring-1','ring-indigo-500');
      const rightHost = document.getElementById('rightList');
      clearActiveGap(rightHost);
      const draggedId = Number(DND.draggingId);
      const idx = Number(row.dataset.dropIndex ?? RIGHT_ROWS.findIndex(x => x.id === ch.id));
      if (DND.source === 'left') {
        enableChannel(draggedId, idx);
      } else if (DND.source === 'right') {
        reorderRight(draggedId, idx);
      }
    });

    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="cursor-move select-none text-slate-400">☰</div>
        <span class="inline-flex items-center justify-center px-2 py-0.5 text-xs font-semibold rounded bg-slate-800 text-slate-200 shrink-0">#${ch.number ?? ''}</span>
        <img src="${ch.logo||''}" onerror="this.style.display='none'" class="w-6 h-6 rounded shrink-0" />
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">${ch.name}</div>
          <div class="text-xs text-slate-400 truncate">${ch.group_name||''}</div>
        </div>
      </div>
      <div class="flex flex-col items-end gap-2">
        <div class="flex items-center gap-2">
          <button class="disableBtn px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs">Entfernen</button>
        </div>
        <div class="flex items-center gap-2">
          <select class="epgSourceSel px-2 py-1 rounded bg-slate-800 text-xs">
            <option value="">Auto/Global</option>
          </select>
          <input type="text" placeholder="EPG-ID suchen…" class="epgSearch px-2 py-1 rounded bg-slate-800 text-xs w-40" />
          <button class="assignBtn px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs">Zuweisen</button>
        </div>
        <div class="epgSugg grid grid-cols-2 gap-2 w-full hidden"></div>
        <div class="text-[11px] ${ch.tvg_id ? 'text-emerald-400' : 'text-amber-400'}">
          EPG: <span class="epgCurrent">${ch.tvg_id || '— nicht zugeordnet —'}</span>
        </div>
      </div>
    `;

    const disableBtn = row.querySelector('.disableBtn');
    const epgSel     = row.querySelector('.epgSourceSel');
    const epgInput   = row.querySelector('.epgSearch');
    const epgSugg    = row.querySelector('.epgSugg');
    const assignBtn  = row.querySelector('.assignBtn');
    const epgCurrent = row.querySelector('.epgCurrent');

    (async ()=>{
      try {
        const list = await getEpgSourcesCached();
        for (const it of list){
          const opt = document.createElement('option');
          opt.value = it.name; opt.textContent = it.name;
          epgSel.appendChild(opt);
        }
        if (ch.epg_source){ epgSel.value = ch.epg_source; }
      } catch {}
    })();

    disableBtn.addEventListener('click', ()=> disableChannel(ch.id));
    const debLoc = (fn, ms=250)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
    epgInput.addEventListener('input', debLoc((e)=>{
      const hits = epgSuggest(e.target.value);
      if (!hits.length){ epgSugg.classList.add('hidden'); epgSugg.innerHTML=''; return; }
      epgSugg.classList.remove('hidden');
      epgSugg.innerHTML = hits.map(h =>
        `<button class="suggest px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-left text-xs" data-id="${h.id}" title="${h.name}">${h.id}</button>`
      ).join('');
      epgSugg.querySelectorAll('.suggest').forEach(b => b.addEventListener('click', ()=>{
        epgInput.value = b.getAttribute('data-id'); epgSugg.classList.add('hidden');
      }));
    }, 250));

    const doAssign = async ()=>{
      const tvg = (epgInput.value||'').trim();
      const src = (epgSel.value||'') || null;
      if (!tvg){ showToast('Bitte EPG-ID wählen/ eintippen', 'warn'); return; }
      try{
        await fetchJSON('/api/channels/'+ch.id, {
          method:'PATCH',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tvg_id: tvg, epg_source: src })
        });
        epgCurrent.textContent = tvg;
        showToast('EPG zugewiesen');
        await loadRight();
      }catch(e){ showToast('EPG-Zuweisung fehlgeschlagen', 'error'); }
    };
    assignBtn.addEventListener('click', doAssign);
    epgInput.addEventListener('keydown', (e)=>{ if (e.key==='Enter') doAssign(); });

    rightHost.appendChild(row);
  });

  // Nach dem Rendern: Drop-Zonen anlegen
  buildRightDropZones(rightHost);

  // Pager & Suche
  document.getElementById('leftPrev').onclick  = ()=> { if (LEFT_STATE.page>1){ LEFT_STATE.page--; loadLeft(); } };
  document.getElementById('leftNext').onclick  = ()=> { const max = Math.max(1, Math.ceil((LEFT_STATE.total||0)/LEFT_STATE.limit)); if (LEFT_STATE.page<max){ LEFT_STATE.page++; loadLeft(); } };
  document.getElementById('rightPrev').onclick = ()=> { if (RIGHT_STATE.page>1){ RIGHT_STATE.page--; loadRight(); } };
  document.getElementById('rightNext').onclick = ()=> { const max = Math.max(1, Math.ceil((RIGHT_STATE.total||0)/RIGHT_STATE.limit)); if (RIGHT_STATE.page<max){ RIGHT_STATE.page++; loadRight(); } };

  document.getElementById('leftPageSize').onchange  = (e)=>{ LEFT_STATE.limit = Number(e.target.value)||100; LEFT_STATE.page = 1; loadLeft(); };
  document.getElementById('rightPageSize').onchange = (e)=>{ RIGHT_STATE.limit = Number(e.target.value)||100; RIGHT_STATE.page = 1; loadRight(); };

  const deb2 = (fn, ms=250)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  document.getElementById('leftSearch').oninput  = deb2((e)=>{ LEFT_STATE.q = e.target.value.trim(); LEFT_STATE.page=1; loadLeft(); });
  document.getElementById('rightSearch').oninput = deb2((e)=>{ RIGHT_STATE.q = e.target.value.trim(); RIGHT_STATE.page=1; loadRight(); });

  document.getElementById('saveOrder').onclick = saveRightOrder;
}

// -------------------- Page init --------------------
document.addEventListener('DOMContentLoaded', async ()=>{
  try {
    const newBtn = document.getElementById('newM3uBtn');
    const m3uForm = document.getElementById('m3uForm');
    newBtn?.addEventListener('click', (e)=>{ e.preventDefault(); m3uForm?.classList.toggle('hidden'); });

    document.getElementById('refreshBtn')?.addEventListener('click', async ()=>{
      try { 
        showLoading(true); 
        const p = fetchJSON('/api/refresh', { method:'POST' });
        const timer = setInterval(async ()=>{ 
          try{ 
            const s = await fetchJSON('/api/epg/status'); 
            if (s.running){ 
              const txt = s.phase==='download' ? `EPG: ${s.current}/${s.total}` : (`EPG: ${s.phase||''}`); 
              showToast(txt); 
            } 
          } catch(_){} 
        }, 1500);
        await p; clearInterval(timer); await loadEPGSources(); showToast('Refresh abgeschlossen'); 
      }
      catch(e){ showToast(e.message || 'Refresh fehlgeschlagen', 'error'); }
      finally { showLoading(false); }
    });

    m3uForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try { showLoading(true); const fd = new FormData(m3uForm);
        await fetchJSON('/api/sources/m3u', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(Object.fromEntries(fd.entries())) });
        m3uForm.reset(); await loadSources(); await checkWizard(); showToast('M3U hinzugefügt');
      } catch (err){ showToast(err.message || 'Fehler beim Hinzufügen', 'error'); } finally { showLoading(false); }
    });

    const xtForm = document.getElementById('xtreamForm');
    xtForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try { showLoading(true); const fd = new FormData(xtForm);
        await fetchJSON('/api/sources/xtream', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(Object.fromEntries(fd.entries())) });
        xtForm.reset(); await loadSources(); await checkWizard(); showToast('Xtream hinzugefügt');
      } catch (err){ showToast(err.message || 'Fehler beim Hinzufügen', 'error'); } finally { showLoading(false); }
    });

    const epgForm = document.getElementById('epgForm');
    epgForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try { showLoading(true); const fd = new FormData(epgForm);
        await fetchJSON('/api/epg', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(Object.fromEntries(fd.entries())) });
        epgForm.reset(); await loadEPGSources(); await checkWizard(); showToast('EPG hinzugefügt');
      } catch (err){ showToast(err.message || 'Fehler beim Hinzufügen', 'error'); } finally { showLoading(false); }
    });

    document.getElementById('wizardClose')?.addEventListener('click', ()=> document.getElementById('setupWizard')?.classList.add('hidden'));

    // Routing
    window.addEventListener('hashchange', async ()=>{
      const page = (location.hash.replace('#/','')||'playlist');
      if (page === 'mapping'){ await loadEPGIndex(); await initDualPaneMapping(); }
      if (page === 'xmltv'){ await loadEPGSources(); }
      if (page === 'playlist'){ /* noop */ }
    });

    await loadSources();
    await loadEPGIndex();
    await loadEPGSources();
    await initDualPaneMapping(); // default view
    await checkWizard();
  } catch (e){
    console.error(e);
    showToast('Init error: '+ (e.message||e), 'error');
  }
});
