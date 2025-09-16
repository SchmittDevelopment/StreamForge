import db from './db.js';

export function getDiscover(){
  return {
    FriendlyName: "StreamForge HDHR",
    Manufacturer: "StreamForge",
    ModelNumber: "HDHR-Emu-1",
    FirmwareName: "hdhomerun_emu",
    FirmwareVersion: "1.0",
    TunerCount: 1,
    LineupURL: "/lineup.json"
  };
}

export function getLineupStatus(){
  return { ScanInProgress: 0, ScanPossible: 1, Source: "Cable", SourceList: ["Cable"] };
}

export function getLineup(req){
  const host = `${req.protocol}://${req.get('host')}`;
  const rows = db.prepare('SELECT id,name,number FROM channels WHERE enabled=1 ORDER BY COALESCE(number, 9999), name').all();
  return rows.map(r => ({ GuideName: r.name, GuideNumber: String(r.number ?? ''), URL: `${host}/stream/${r.id}` }));
}
