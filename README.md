# tvtime-to-SIMKL-import-file-convertor

Convert a TV Time GDPR export ZIP into a SIMKL JSON backup ZIP, with a web review step for SIMKL IDs before download.

The main flow is now a web app:

1. Upload the ZIP exported by TV Time.
2. The server parses the TV Time CSV files and converts watched movies, watched episodes, rewatches, and optional plan-to-watch items into SIMKL backup JSON shape.
3. The server searches SIMKL for each TV show, anime, or movie and tries to attach a verified SIMKL ID.
4. The review page shows found items in green, missing items in red, and manually changed items in yellow.
5. You can correct SIMKL IDs manually, validate changed IDs against the SIMKL API, save confirmed IDs to MongoDB, and download a ready-to-import `SimklBackup.json` ZIP.

## Features

- Web UI for uploading a TV Time GDPR export ZIP.
- SIMKL API lookup by title/year and by manually entered SIMKL ID.
- Uses the `type` returned by the SIMKL API to distinguish `tv`, `anime`, and `movie`.
- MongoDB cache for confirmed SIMKL IDs, so future users need to fix fewer records manually.
- Session IDs that can be copied immediately after upload. Users can close the browser tab and later resume the session while the server continues processing.
- Progress display with processed/total, percentage, elapsed time, ETA, and remaining items.
- Export filters for TV shows, movies, and anime.
- Optional CLI converter kept for local/batch usage.

## Requirements

- Node.js 18 or newer.
- A SIMKL API `client_id`.
- MongoDB is optional, but recommended if more than one person will use the app or if you want session recovery after restart.

## Create a SIMKL App

This project only needs a SIMKL `client_id` for catalog/search requests. It does not use OAuth or an access token.

Suggested app details:

- Name: `TV Time to SIMKL Import File Convertor`
- Description: `Local or self-hosted tool to convert a personal TV Time GDPR export into a SIMKL backup import file and review SIMKL IDs before downloading the final ZIP.`
- Redirect URI: leave it empty if SIMKL allows it. If it is required, use the public URL where you host the app, for example `http://127.0.0.1:3000/` locally or `https://your-domain.example/` in production.

Copy the `client_id` into `.env`:

```env
SIMKL_CLIENT_ID=your_client_id
MONGODB_URL=mongodb://127.0.0.1:27017/tvtime_simkl
MONGODB_SESSION_COLLECTION=simkl_sessions
SIMKL_API_DELAY_MS=110
SIMKL_API_TIMEOUT_MS=20000
```

## Local Usage

Install dependencies:

```bash
npm install
```

Start the web app:

```bash
npm start
```

Open the URL printed in the terminal, normally:

```text
http://127.0.0.1:3000/
```

You can also pass the SIMKL client ID through the environment. Environment variables take priority over `.env` values:

```powershell
$env:SIMKL_CLIENT_ID="your_client_id"
npm start
```

## Review States

- Green: the record has a validated SIMKL ID.
- Red: the record does not have a validated SIMKL ID.
- Yellow: the ID or type was changed manually and still needs SIMKL validation.

The `Validate changed` button calls the SIMKL API for yellow records and fills the SIMKL title/type if the ID is valid.

The `Generate ZIP` button downloads a ZIP containing `SimklBackup.json` without leaving the page. Before generating the ZIP, the app asks whether confirmed IDs should also be saved to MongoDB.

When a SIMKL ID is applied, the final JSON writes `ids.simkl`, which is the canonical key used by current SIMKL backup examples.

## Sessions

As soon as the upload is accepted, the page displays a session ID before processing is finished. Copy this ID if you want to resume later.

If a user pastes the session ID while the ZIP is still processing, the page shows the current server-side progress. When processing finishes, the same session opens the review table automatically.

Closing the browser tab is safe while the server keeps running. The local Node process must keep running for in-progress jobs to continue. If the computer is turned off or the server process stops, an in-progress job stops too.

If `MONGODB_URL` is configured, completed sessions are saved in MongoDB and can be restored after restarting the server.

## MongoDB

Default MongoDB settings:

```env
MONGODB_URL=mongodb://127.0.0.1:27017/tvtime_simkl
MONGODB_COLLECTION=simkl_id_mappings
MONGODB_SESSION_COLLECTION=simkl_sessions
```

The mapping cache is stored in `simkl_id_mappings`. Future uploads load these IDs before calling the SIMKL API, reducing lookup time and manual work.

New matches found during upload are saved automatically when MongoDB is configured. Manually corrected IDs are saved after they have been validated by SIMKL, either with `Save IDs to database` or through the save prompt shown before ZIP generation.

Empty ID fields are ignored when saving. They do not delete existing database mappings.

## API Rate and Timeout Settings

SIMKL requests can be slowed down or timed out with environment variables:

```env
SIMKL_API_DELAY_MS=110
SIMKL_API_TIMEOUT_MS=20000
```

Increase `SIMKL_API_DELAY_MS` to `150` or `200` if you see `429` responses.

Set `SIMKL_API_TIMEOUT_MS=0` to disable the per-request timeout.

## Self-Hosting

This app is a plain Node.js HTTP server with static frontend files. There is no build step.

Recommended production setup:

1. Install Node.js 18+ on the host.
2. Clone the repository and run `npm install --omit=dev` if you only need runtime dependencies.
3. Create a `.env` file with `SIMKL_CLIENT_ID`, `MONGODB_URL`, and optional API timing settings.
4. Run the app behind a process manager such as PM2, systemd, Docker, or your hosting provider's Node runtime.
5. Put a reverse proxy such as Nginx, Caddy, Traefik, or a platform proxy in front of it if you want HTTPS and a public domain.
6. Point the SIMKL app redirect URI at your public app URL if SIMKL requires a redirect URI.

Example PM2 command:

```bash
pm2 start server.js --name tvtime-simkl-converter
```

Example systemd service shape:

```ini
[Unit]
Description=TV Time to SIMKL Import File Convertor
After=network.target

[Service]
WorkingDirectory=/opt/tvtime-to-SIMKL-import-file-convertor
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

For Docker-style hosting, make sure the container receives the environment variables and that MongoDB is reachable from inside the container.

Important operational notes:

- The server currently stores in-progress jobs in memory. Use MongoDB for completed session recovery, but keep the Node process running while a ZIP is being processed.
- This app handles personal TV Time exports. Avoid logging uploaded files or generated backups on shared hosts.
- Use HTTPS if exposing it beyond localhost.
- Restrict access if the app is hosted for a small group, because uploads may contain private watch history.

## CLI

The older CLI converter is still available:

```bash
node index.js gdpr-data.zip
```

Or with an explicit output folder:

```bash
node index.js --input gdpr-data.zip --output-dir output
```

CLI outputs:

- `SimklBackup-<timestamp>.json`
- `SimklBackup-<timestamp>.zip`
- `failed-records-<timestamp>.md/.csv`
- `summary-<timestamp>.json`

## Repair Old ZIP Files With `simkl_id`

Older versions wrote `ids.simkl_id`. The current output uses `ids.simkl`.

Repair an old ZIP or JSON file:

```bash
npm run repair:ids -- path/to/SimklBackup.zip
```

The command creates a new `*-ids-fixed.zip` file containing `SimklBackup.json`.

## Project Structure

```text
index.js               CLI wrapper
server.js              Web server wrapper
scripts/               Repair and maintenance scripts
src/core.js            TV Time parser and converter
src/session-service.js Web session, review list, and ZIP generation
src/simkl-api.js       SIMKL API client
src/mongo-store.js     MongoDB mapping/session store
src/multipart.js       Dependency-free multipart parser
src/web-server.js      HTTP routes
public/                Web interface
```

## Privacy

`SimklBackup.json`, `gdpr-data.zip`, `*.zip`, `not_found*.json`, and `output/` are ignored by git to reduce the risk of publishing private data.
