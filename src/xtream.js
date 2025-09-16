import fetch from 'node-fetch';
import { parseM3U } from './m3u.js';

function normBase(u){ if(!/^https?:\/\//i.test(u)) u='http://'+u; return u.replace(/\/+$/, ''); }
async function j(url, headers){ const r = await fetch(url, { timeout: 20000, headers }); if(!r.ok) throw new Error(String(r.status)); return r.json(); }
async function t(url, headers){ const r = await fetch(url, { timeout: 20000, headers }); if(!r.ok) throw new Error(String(r.status)); return r.text(); }

export async function fetchXtreamChannels({ baseUrl, username, password, userAgent }){
  const b = normBase(baseUrl);
  const headers = {}; if (userAgent) headers['user-agent'] = userAgent;

  try {
    const list = await j(`${b}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`, headers);
    return list.map(i => ({
      name: i.name || `Channel ${i.stream_id}`,
      url: `${b}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${i.stream_id}.ts`,
      group_name: i.category_name || null,
      logo: i.stream_icon || null,
      tvg_id: i.epg_channel_id || null,
    }));
  } catch {}

  try {
    const meta = await j(`${b}/panel_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, headers);
    if (meta && Array.isArray(meta.available_channels)){
      return meta.available_channels.map(i => ({
        name: i.name || `Channel ${i.stream_id}`,
        url: `${b}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${i.stream_id}.ts`,
        group_name: i.category_name || null,
        logo: i.stream_icon || null,
        tvg_id: i.epg_channel_id || null,
      }));
    }
  } catch {}

  try {
    const m3u = await t(`${b}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=mpegts`, headers);
    const parsed = parseM3U(m3u);
    if (parsed.length) return parsed;
  } catch {}

  throw new Error('All Xtream endpoints failed');
}
