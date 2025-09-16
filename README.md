# StreamForge

StreamForge is a lightweight IPTV middleware that lets you:

- Ingest **M3U** and **Xtream** sources
- Map **XMLTV (EPG)** to channels (manual, exact, or fuzzy auto-mapping)
- Export a clean **M3U**
- Serve **HDHomeRun** endpoints (`/`, `/discover.json`, `/lineup.json`)
- Optionally **transcode via FFmpeg**
- Run via **Docker** or as a **single binary** (optional)
- Minimal, fast web UI at `/web`

---

## Quick Start

### Docker (recommended)

```bash
docker run -d --name streamforge \
  -p 8000:8000 \
  -v $(pwd)/data:/data \
  -e PORT=8000 -e HOST=0.0.0.0 -e DATA_DIR=/data \
  schmittdev/streamforge:latest
```

Open:
- Web UI: `http://localhost:8000/web`
- M3U: `http://localhost:8000/m3u`
- XMLTV: `http://localhost:8000/xmltv`
- HDHR discover: `http://localhost:8000/`

### Docker Compose

```yaml
version: "3.8"
services:
  streamforge:
    image: schmittdev/streamforge:latest
    container_name: streamforge
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - HOST=0.0.0.0
      - DATA_DIR=/data
    volumes:
      - ./data:/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Node.js (dev)

```bash
npm ci
npm start
```

---

## Configuration

Environment variables:

- `PORT` (default: `8000`)
- `HOST` (default: `0.0.0.0`)
- `DATA_DIR` (default: `<project>/data`)

FFmpeg (optional transcoding):
- Linux default: `/usr/bin/ffmpeg`
- macOS default: `/opt/homebrew/bin/ffmpeg`
- Windows default: `ffmpeg` in PATH

---

## Endpoints

- **Web UI**: `/web`
- **M3U output**: `/m3u`
- **XMLTV merged**: `/xmltv`
- **HDHomeRun**:
  - `/` (discover)
  - `/discover.json`
  - `/lineup.json`

---

## EPG (XMLTV)

- Add sources in **XMLTV** tab (URL + name)
- Refresh to download & index (ETag/Last-Modified aware)
- Mapping tab: search & assign `tvg_id`
- **Optional auto-mapping**:
  - `POST /api/mapping/auto` with body `{ minScore?: 0.6, dryRun?: false, epgSource?: "Name" }`

---

## Build the Docker Image

```bash
# build
docker build -t schmittdev/streamforge:latest .
# optional semver tag
docker tag schmittdev/streamforge:latest USER/streamforge:0.6.0
# push
docker push schmittdev/streamforge:latest
docker push schmittdev/streamforge:0.6.0
```

**Multi-arch build** (amd64+arm64):

```bash
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 \
  -t USER/streamforge:latest --push .
```

---

## Single Binary (optional)

Build portable executables using `pkg`:

```bash
npm i -D pkg
# package.json → "pkg.targets": ["node18-linux-x64","node18-macos-arm64","node18-macos-x64","node18-win-x64"]
npm run build:bin
# outputs in dist/
```

Run:
```bash
./dist/streamforge-linux-x64 --port 8000
# DATA_DIR=/var/streamforge ./dist/streamforge-linux-x64
```

> Note: native addons (e.g., better-sqlite3) require prebuilds for each target.

---

> **Disclaimer**
> StreamForge does **not** provide any content or streams.  
> This software is only a tool for managing IPTV streams you legally own access to.  
> SchmittDEV are not responsible for any illegal use of this tool.

---

## License

MIT
