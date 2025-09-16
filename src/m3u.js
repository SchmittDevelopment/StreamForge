export function parseM3U(text){
  const lines = text.split(/\r?\n/);
  const out = []; let cur=null;
  for (const lineRaw of lines){
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF:')){
      const name = line.split(',').slice(-1)[0]?.trim();
      const tvgId = /tvg-id="([^"]*)"/i.exec(line)?.[1] || null;
      const tvgName = /tvg-name="([^"]*)"/i.exec(line)?.[1] || null;
      const group = /group-title="([^"]*)"/i.exec(line)?.[1] || null;
      const logo  = /tvg-logo="([^"]*)"/i.exec(line)?.[1] || /logo="([^"]*)"/i.exec(line)?.[1] || null;
      const chno  = /tvg-chno="([^"]*)"/i.exec(line)?.[1] || null;
      cur = { name: tvgName || name || 'Channel', tvg_id: tvgId, group_name: group, logo, number: chno ? Number(chno) : null };
    } else if (!line.startsWith('#') && cur){
      cur.url = line; out.push(cur); cur=null;
    }
  }
  return out;
}

export function buildM3U(channels, { includeChno = true } = {}){
  const lines = ['#EXTM3U'];
  for (const ch of channels.filter(c=>c.enabled)){
    const attrs = [];
    if (ch.tvg_id) attrs.push(`tvg-id="${ch.tvg_id}"`);
    if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
    if (ch.group_name) attrs.push(`group-title="${ch.group_name}"`);
    if (includeChno && ch.number!=null) attrs.push(`tvg-chno="${ch.number}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')} ,${ch.name}`);
    lines.push(`${ch.url}`);
  }
  return lines.join('\n');
}
