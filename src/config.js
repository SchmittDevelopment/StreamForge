import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');
const EPG_DIR = path.join(DATA_DIR, 'epg');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EPG_DIR, { recursive: true });

export default {
  PORT: process.env.PORT || 8000,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  DB_FILE,
  EPG_DIR,
  INSTANCE_NAME: process.env.INSTANCE_NAME || 'StreamForge',
};
