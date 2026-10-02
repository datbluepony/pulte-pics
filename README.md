# Pulte Pic System

Photo-run app for Verdana Village update photos.

- `docs/index.html` is the photographer's side (iPhone). Upload the agents' starred map, confirm the lots, follow the route, shoot each lot. Photos upload in the background at full resolution.
- `docs/agent.html` is the agents' side (PC). Each agent has a private link that shows only their lots, with thumbnails, the customer note and downloads.
- `apps-script/Code.gs` is the backend. It runs in the photographer's Google account, stores photos in Google Drive under `Pulte Pics / Verdana Village / date / agent / Lot N`, emails agents, and deletes runs after 11 days.

No photos are stored on GitHub. The site is only the app.

## One-time setup

1. Go to [script.google.com](https://script.google.com), create a new project, and replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo.
2. To turn on map reading, open Project Settings, then Script Properties, and add `ANTHROPIC_API_KEY` with a key from [console.anthropic.com](https://console.anthropic.com). Without it you can still add lots by hand.
3. In the editor choose the `setup` function and press Run. Approve the permissions. The execution log prints your owner token.
4. Press Deploy, New deployment, type Web app. Set "Execute as" to Me and "Who has access" to Anyone. Copy the web app URL.
5. Open the app on the iPhone, go to Settings, paste the URL and the owner token, fill in each agent's email, and press Save and connect.
6. Copy each agent's link from Settings and send it to them once. In Safari use Share, then Add to Home Screen, to install the app.

After changing `Code.gs`, use Deploy, Manage deployments, Edit, New version, so the URL stays the same.

## Each photo run

1. Route tab: pick the date, choose the agents' map PDF, press Read the map.
2. Fix anything flagged, then press Build my route.
3. Open the next lot, take photos, tap the stage, press Done.
4. When the status bar says everything is sent, press Email agents their link.

## Rebuilding the master map

`docs/lots.json` and `docs/map.jpg` come from the Pulte brochure PDF. If the community map changes, rerun `tools/extract.py` with the new PDF.
