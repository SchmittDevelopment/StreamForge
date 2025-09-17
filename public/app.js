let GLOBAL_EPG_SOURCES = null;

async function getEpgSourcesCached() {
  if (GLOBAL_EPG_SOURCES) return GLOBAL_EPG_SOURCES;
  GLOBAL_EPG_SOURCES = await fetchJSON('/api/epg/sources');
  return GLOBAL_EPG_SOURCES;
}


async function fetchJSON(url, opts){
  const r = await fetch(url, opts);
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

let ALL_CH = [];
let EPG_IDX = [];
let ID_NAMES = [];

// === Robustheits-Helpers ===
function toArray(val){
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') return Object.values(val);
  return [];
}

function parseM3U(text){
  const lines = String(text || '').split(/\r?\n/);
  const arr = [];
  let cur = {};
  for (const lineRaw of lines){
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')){
      const nameMatch = line.split(',').slice(-1)[0];
      const name = nameMatch ? nameMatch.trim() : 'Channel';
      const groupMatch = /group-title="([^"]*)"/i.exec(line);
      const group = groupMatch ? groupMatch[1] : null;
      const tvgIdMatch = /tvg-id="([^"]*)"/i.exec(line);
      const tvg_id = tvgIdMatch ? tvgIdMatch[1] : null;
      const logoMatch = /tvg-logo="([^"]*)"/i.exec(line);
      const logo = logoMatch ? logoMatch[1] : null;
      const chnoMatch = /tvg-chno="([^"]*)"/i.exec(line);
      const chno = chnoMatch ? chnoMatch[1] : null;
      cur = { name, group_name: group, tvg_id, logo, number: chno ? Number(chno) : null };
    } else if (!line.startsWith('#')){
      arr.push({ ...cur, url: line });
      cur = {};
    }
  }
  return arr;
}

// ---- Paging-State + UI ----
let PAGING = { page: 1, limit: 100, total: 0, pages: 0 };

function ensurePagerBar(){
  const host = document.getElementById('groupedChannels');
  if (!host) return;
  // Falls schon vorhanden, nichts tun
  if (document.getElementById('pagerBar')) return;

  const bar = document.createElement('div');
  bar.id = 'pagerBar';
  bar.className = 'mb-3 flex items-center gap-3 text-sm';
  bar.innerHTML = `
    <button id="pagerPrev" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">◀</button>
    <span id="pagerInfo" class="text-slate-300">Seite 1 / 1 • 0 Einträge</span>
    <button id="pagerNext" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700">▶</button>
    <span class="ml-3 text-slate-400">Pro Seite:</span>
    <select id="pageSize" class="px-2 py-1 rounded bg-slate-800">
      <option value="50">50</option>
      <option value="100" selected>100</option>
      <option value="200">200</option>
      <option value="500">500</option>
    </select>
  `;
  host.parentElement.insertBefore(bar, host);

  // Events
  document.getElementById('pagerPrev').addEventListener('click', ()=>{
    if (PAGING.page > 1) loadChannelsPage(PAGING.page - 1);
  });
  document.getElementById('pagerNext').addEventListener('click', ()=>{
    if (PAGING.page < PAGING.pages) loadChannelsPage(PAGING.page + 1);
  });
  document.getElementById('pageSize').addEventListener('change', (e)=>{
    PAGING.limit = Number(e.target.value) || 100;
    loadChannelsPage(1);
  });
}

function updatePagerUI(){
  const info = document.getElementById('pagerInfo');
  if (!info) return;
  info.textContent = `Seite ${PAGING.page} / ${Math.max(1,PAGING.pages)} • ${PAGING.total} Einträge`;
  document.getElementById('pagerPrev')?.toggleAttribute('disabled', PAGING.page <= 1);
  document.getElementById('pagerNext')?.toggleAttribute('disabled', PAGING.page >= PAGING.pages);
}

function loadChannelsPage(nextPage){
  return loadChannelsMapping({ page: nextPage, limit: PAGING.limit });
}

let FILTERS = { q: "", group: "" };

function debounce(fn, wait = 250){
  let t; 
  return (...args) => { clearTimeout(t); t = setTimeout(()=>fn(...args), wait); };
}

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
      parts.push(
        `<div class="flex items-center justify-between text-xs bg-slate-800/60 rounded p-2 mb-1">
          <div class="truncate"><b>${s.name}</b> — ${s.url}</div>
          <button data-type="m3u" data-id="${s.id}" class="delSource px-2 py-1 rounded bg-red-600 hover:bg-red-500">Delete</button>
        </div>`
      );
    }
  }
  if (x.length){
    parts.push('<div class="mt-3 mb-2 font-semibold text-slate-300">Xtream Sources</div>');
    for (const s of x){
      parts.push(
        `<div class="flex items-center justify-between text-xs bg-slate-800/60 rounded p-2 mb-1">
          <div class="truncate"><b>${s.name}</b> — ${s.base_url}</div>
          <button data-type="xtream" data-id="${s.id}" class="delSource px-2 py-1 rounded bg-red-600 hover:bg-red-500">Delete</button>
        </div>`
      );
    }
  }
  wrapM.innerHTML = parts.join('') || 'No sources yet.';
  document.querySelectorAll('.delSource').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const t = btn.getAttribute('data-type'); const id = btn.getAttribute('data-id');
      if (!confirm('Delete this source?')) return;
      await fetchJSON(`/api/sources/${t}/${id}`, { method:'DELETE' });
      await loadSources(); await loadChannelsMapping(); await checkWizard();
    });
  });
}

async function loadEPGIndex(){
  try { 
    const arr = await fetchJSON('/api/epg/channels');
    ID_NAMES = arr;
    // Build fast lookup for suggestions
    EPG_IDX = {};
    for (const it of arr){
      for (const n of (it.names||[])){ EPG_IDX[n.toLowerCase()] = it.id; }
    }
  } catch { EPG_IDX = {}; ID_NAMES = []; }
}

async function loadEPGSources(){
  const host = document.getElementById('epgList'); if (!host) return;
  try{
    const list = await fetchJSON('/api/epg/sources');
    host.innerHTML = list.map(x => {
      const badge = x.status === 'active'
        ? '<span class="ml-2 text-xs px-2 py-1 rounded bg-emerald-700">active</span>'
        : '<span class="ml-2 text-xs px-2 py-1 rounded bg-red-700">pending</span>';
      return `<div class="flex items-center justify-between bg-slate-800/60 rounded p-2">
        <div class="truncate"><b>${x.name}</b> — ${x.url}</div>
        <div>${badge}</div>
      </div>`;
    }).join('') || '<div class="text-slate-400">Keine EPG Quellen.</div>';
  }catch(e){ host.innerHTML = '<div class="text-red-400">Fehler beim Laden der EPG-Liste</div>'; }
}

function groupMap(chs){
  const m = new Map();
  for (const c of chs){
    const g = c.group_name || 'Ungrouped';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(c);
  }
  return m;
}

function ensureGroupOptions(){
  const sel = document.getElementById('groupFilter'); if (!sel) return;
  const list = Array.isArray(ALL_CH) ? ALL_CH : toArray(ALL_CH);
  const names = Array.from(new Set(list.map(c => c?.group_name).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">Alle Gruppen</option>' + names.map(n => `<option value="${n}">${n}</option>`).join('');
}

function epgSuggest(term){
  const t = (term||'').toLowerCase().trim();
  if (!t) return [];
  const hits = [];
  const seen = new Set();

  // zuerst: Name -> ID (aus EPG_IDX)
  for (const [name,id] of Object.entries(EPG_IDX)){
    if (name.includes(t) && !seen.has(id)) { hits.push({ id, name }); seen.add(id); }
    if (hits.length >= 8) break;
  }

  // zusätzlich: ID enthält Suchbegriff (aus ID_NAMES)
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

const applyFilterAndSearch = debounce(()=>{
  const sEl = document.getElementById('searchBox');
  const gEl = document.getElementById('groupFilter');
  FILTERS.q = (sEl?.value || "").trim();
  FILTERS.group = gEl?.value || "";

  // nur EINE Netz-Anfrage (Seite 1), KEIN renderGrouped hier!
  loadChannelsMapping({ page: 1, q: FILTERS.q, group: FILTERS.group });
}, 250);

function renderGrouped(chs){
  const host = document.getElementById('groupedChannels'); if (!host) return;
  host.innerHTML = '';
  const groups = groupMap(chs);
  const sorted = Array.from(groups.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  for (const [gname, list] of sorted){
    const wrap = document.createElement('div');
    wrap.className = 'rounded-2xl border border-slate-800 overflow-hidden';
    const header = document.createElement('div');
    header.className = 'bg-slate-900 px-4 py-2 flex items-center justify-between cursor-pointer';
    header.innerHTML = `<div class="font-semibold">${gname} <span class="text-xs text-slate-400">(${list.length})</span></div><div>▼</div>`;
    const body = document.createElement('div');
    body.className = 'bg-slate-900/40';
    const inner = document.createElement('div');
    inner.className = 'divide-y divide-slate-800';

    for (const ch of list){
      const row = document.createElement('div');
      row.className = 'p-3 flex items-start justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'flex items-center gap-3 min-w-0';
      left.innerHTML = `<img src="${ch.logo||''}" onerror="this.style.display='none'" class="w-8 h-8 rounded shrink-0" />
        <div class="min-w-0">
          <div class="truncate font-medium">${ch.number ?? ''} ${ch.name}</div>
          <div class="text-xs text-slate-400 truncate">URL: ${ch.url}</div>
          <div class="text-xs ${ch.tvg_id ? 'text-emerald-400' : 'text-amber-400'}">EPG: ${ch.tvg_id || '— nicht zugeordnet —'}</div>
        </div>`;
      const right = document.createElement('div');
      right.className = 'flex items-center gap-2';
      right.innerHTML = `
        <label class="text-xs flex items-center gap-2"><input type="checkbox" class="rowSelect" data-id="${ch.id}"> Wählen</label>
        <select class="epgSourceSel px-2 py-2 rounded bg-slate-800 text-sm"><option value="">Auto/Global</option></select>
        <input type="text" placeholder="EPG suchen…" class="epgSearch px-3 py-2 rounded bg-slate-800 text-sm w-52" data-id="${ch.id}" />
        <button class="assignBtn px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-sm" data-id="${ch.id}">Zuweisen</button>
        <label class="text-xs flex items-center gap-2 ml-2">
          <input type="checkbox" ${ch.enabled ? 'checked' : ''} data-id="${ch.id}" class="toggleEnabled">
          Enabled
        </label>
      `;

      // populate epg source select
            (async ()=>{
              try {
                const sel = right.querySelector('.epgSourceSel');
                const list = await getEpgSourcesCached();  // <-- Nur 1x geladen und gecached
                for (const it of list){ 
                  const opt = document.createElement('option'); 
                  opt.value = it.name; 
                  opt.textContent = it.name; 
                  sel.appendChild(opt); 
                }
                const d = document.createElement('option'); 
                d.value = 'SF Dummy'; 
                d.textContent = 'SF Dummy'; 
                sel.appendChild(d);
                if (ch.epg_source){ sel.value = ch.epg_source; }
              } catch {}
            })();


      const sugg = document.createElement('div');
      sugg.className = 'text-xs text-slate-300 grid grid-cols-2 gap-2 mt-2 hidden';

      const assign = async ()=>{
        const inp = right.querySelector('.epgSearch');
        const epgSel = right.querySelector('.epgSourceSel');
        const val = (inp && inp.value) ? inp.value.trim() : '';
        if (!val){ showToast('Bitte zuerst EPG-ID eintippen oder wählen', 'warn'); return; }
        await fetchJSON('/api/channels/'+ch.id+'/assign-epg', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tvg_id: val, epg_source: epgSel?.value||null })
        });
        showToast('EPG zugewiesen');
        await loadChannelsMapping();
      };

      row.querySelector = (sel)=>row.querySelectorAll(sel)[0]; // ensure scope

      right.querySelector('.assignBtn').addEventListener('click', assign);
      right.querySelector('.toggleEnabled').addEventListener('change', async (e)=>{
        await fetchJSON('/api/channels/'+ch.id, {
          method:'PATCH',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ enabled: e.target.checked })
        });
      });
      const epgInput = right.querySelector('.epgSearch');
      epgInput.addEventListener('input', (e)=>{
        const hits = epgSuggest(e.target.value);
        if (!hits.length){ sugg.classList.add('hidden'); sugg.innerHTML=''; return; }
        sugg.classList.remove('hidden');
        sugg.innerHTML = hits.map(h => `<button class="suggest px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-left" data-id="${h.id}" title="${h.name}">${h.id}</button>`).join('');
        sugg.querySelectorAll('.suggest').forEach(b => b.addEventListener('click', ()=>{
          epgInput.value = b.getAttribute('data-id');
          sugg.classList.add('hidden');
        }));
      });

      row.appendChild(left);
      row.appendChild(right);
      inner.appendChild(row);
      inner.appendChild(sugg);
    }

    body.appendChild(inner);
    wrap.appendChild(header);
    wrap.appendChild(body);
    header.addEventListener('click', ()=> body.classList.toggle('hidden'));
    host.appendChild(wrap);
  }
  bindBulkControls();
}

async function loadChannelsMapping({ page, limit, q, group } = {}){
  try {
    showLoading(true);
    ensurePagerBar();

    if (typeof q === 'string') FILTERS.q = q;
    if (typeof group === 'string') FILTERS.group = group;

    const p = Number(page ?? PAGING.page ?? 1);
    const l = Number(limit ?? PAGING.limit ?? 100);

    const u = new URL('/api/channels', location.origin);
    u.searchParams.set('page', String(p));
    u.searchParams.set('limit', String(l));
    if (FILTERS.q)     u.searchParams.set('q', FILTERS.q);
    if (FILTERS.group) u.searchParams.set('group', FILTERS.group);

    const r = await fetch(u, { cache: 'no-cache' });
    const payload = await r.json();
    const rows = Array.isArray(payload) ? payload
               : Array.isArray(payload?.rows) ? payload.rows
               : [];

    PAGING.page  = Number((Array.isArray(payload) ? p : payload?.page)  ?? p);
    PAGING.limit = Number((Array.isArray(payload) ? l : payload?.limit) ?? l);
    PAGING.total = Number((Array.isArray(payload) ? rows.length : payload?.total) ?? rows.length);
    PAGING.pages = Math.max(1, Math.ceil(PAGING.total / Math.max(1, PAGING.limit)));

    ALL_CH = rows.map(ch => ({
      id: ch.id ?? ch.channel_id ?? ch.stream_id ?? null,
      name: ch.name ?? ch.channelName ?? 'Channel',
      group_name: ch.group_name ?? ch.group ?? ch.category_name ?? '',
      tvg_id: ch.tvg_id ?? ch.epg_channel_id ?? '',
      logo: ch.logo ?? ch.tvg_logo ?? '',
      number: (ch.number != null) ? Number(ch.number) : null,
      url: ch.url ?? ch.stream_url ?? '',
      enabled: ch.enabled ?? ch.enable ?? false,
      epg_source: ch.epg_source ?? null,
    })).filter(ch => ch.url);

    updatePagerUI();
    ensureGroupOptions();
    renderGrouped(ALL_CH); // <— nur rendern
  } catch(e){
    console.error(e);
    ALL_CH = [];
    renderGrouped(ALL_CH);
  } finally {
    showLoading(false);
  }
}

function getSelectedIds(){
  return Array.from(document.querySelectorAll('.rowSelect:checked')).map(x => Number(x.getAttribute('data-id')));
}

function bindBulkControls(){
  const selAll = document.getElementById('selectAll');
  const bulkEn = document.getElementById('bulkEnable');
  const bulkDis = document.getElementById('bulkDisable');
  const bulkNum = document.getElementById('bulkRenumber');
  selAll?.addEventListener('change', ()=>{
    const on = selAll.checked;
    document.querySelectorAll('.rowSelect').forEach(cb => { cb.checked = on; });
  });
  bulkEn?.addEventListener('click', async ()=>{
    const ids = getSelectedIds(); if (!ids.length) return showToast('Keine Kanäle ausgewählt','warn');
    await fetchJSON('/api/channels/bulk', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, action:'enable' })
    });
    showToast('Aktiviert');
    await loadChannelsMapping();
  });
  bulkDis?.addEventListener('click', async ()=>{
    const ids = getSelectedIds(); if (!ids.length) return showToast('Keine Kanäle ausgewählt','warn');
    await fetchJSON('/api/channels/bulk', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, action:'disable' })
    });
    showToast('Deaktiviert');
    await loadChannelsMapping();
  });
  bulkNum?.addEventListener('click', async ()=>{
    const ids = getSelectedIds(); if (!ids.length) return showToast('Keine Kanäle ausgewählt','warn');
    const start = Number(document.getElementById('startNumber')?.value || 0);
    await fetchJSON('/api/channels/bulk', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, action:'renumber', startNumber: start })
    });
    showToast('Nummern gesetzt');
    await loadChannelsMapping();
  });
}

document.addEventListener('DOMContentLoaded', async ()=>{
  try {
    // Bind UI
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
        await p;
        clearInterval(timer);
        await loadChannelsMapping();
        await loadEPGSources();
        showToast('Refresh abgeschlossen');
      } catch(e){
        showToast(e.message || 'Refresh fehlgeschlagen', 'error');
      } finally { showLoading(false); }
    });

    const m3uFormEl = document.getElementById('m3uForm');
    m3uFormEl?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try {
        showLoading(true);
        const fd = new FormData(m3uFormEl);
        await fetchJSON('/api/sources/m3u', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(Object.fromEntries(fd.entries()))
        });
        m3uFormEl.reset();
        await loadSources();
        await loadChannelsMapping();
        await checkWizard();
        showToast('M3U hinzugefügt & aktualisiert');
      } catch (err){
        showToast(err.message || 'Fehler beim Hinzufügen', 'error');
      } finally { showLoading(false); }
    });

    const xtForm = document.getElementById('xtreamForm');
    xtForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try {
        showLoading(true);
        const fd = new FormData(xtForm);
        await fetchJSON('/api/sources/xtream', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(Object.fromEntries(fd.entries()))
        });
        xtForm.reset();
        await loadSources();
        await loadChannelsMapping();
        await checkWizard();
        showToast('Xtream hinzugefügt & aktualisiert');
      } catch (err){
        showToast(err.message || 'Fehler beim Hinzufügen', 'error');
      } finally { showLoading(false); }
    });

    const epgForm = document.getElementById('epgForm');
    epgForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try {
        showLoading(true);
        const fd = new FormData(epgForm);
        await fetchJSON('/api/epg', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(Object.fromEntries(fd.entries()))
        });
        epgForm.reset();
        await loadEPGSources();
        await checkWizard();
        showToast('EPG hinzugefügt');
      } catch (err){
        showToast(err.message || 'Fehler beim Hinzufügen', 'error');
      } finally { showLoading(false); }
    });

    document.getElementById('wizardClose')?.addEventListener('click', ()=> document.getElementById('setupWizard')?.classList.add('hidden'));

    document.getElementById('searchBox')?.addEventListener('input', applyFilterAndSearch);
    document.getElementById('groupFilter')?.addEventListener('change', applyFilterAndSearch);

    window.addEventListener('hashchange', async ()=>{
      const page = (location.hash.replace('#/','')||'playlist');
      if (page === 'mapping'){ await loadEPGIndex(); await loadChannelsMapping({ page: 1 }); }
      if (page === 'xmltv'){ await loadEPGSources(); }
    });

    await loadSources();
    await loadEPGIndex();
    await loadEPGSources();
    await loadChannelsMapping({ page: 1 }); // nur Seite 1 laden
    await checkWizard();
  } catch (e){
    console.error(e);
    showToast('Init error: '+ (e.message||e), 'error');
  }
});
