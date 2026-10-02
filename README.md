# Pulte Pic System

Photo-run app for Verdana Village update photos.

- `docs/index.html` is the photographer's side (iPhone). Upload the agents' starred map, confirm the lots, follow the route, shoot each lot. Photos upload in the background at full resolution.
- `docs/agent.html` is the agents' side (PC). Each agent has a private link that shows only their lots, with thumbnails, the customer note and downloads.
- `apps-script/Code.gs` is the backend. It runs in the photographer's Google account, stores photos in Google Drive under `Pulte Pics / Verdana Village / date / agent / Lot N`, emails agents, and deletes runs after 11 days.

No photos are stored on GitHub. The site is only the app.

Everything is free: GitHub Pages hosts the app, Google Drive and Gmail (through Apps Script) hold and send the photos, and the map is read on the phone itself with open-source code (pdf.js and OpenCV). No paid API is used.

## One-time setup

1. Go to [script.google.com](https://script.google.com), create a new project, and replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo.
2. In the editor choose the `setup` function and press Run. Approve the permissions. The execution log prints your owner token.
3. Press Deploy, New deployment, type Web app. Set "Execute as" to Me and "Who has access" to Anyone. Copy the web app URL.
4. Open the app on the iPhone, go to Settings, paste the URL and the owner token, fill in each agent's email, and press Save and connect.
5. Copy each agent's link from Settings and send it to them once. In Safari use Share, then Add to Home Screen, to install the app.

After changing `Code.gs`, use Deploy, Manage deployments, Edit, New version, so the URL stays the same.

## Each photo run

1. Route tab: pick the date, choose the agents' map PDF, press Read the map. It takes a minute or two on the phone.
2. Each star is shown beside the lot number it resolved to. Fix anything flagged, then press Build my route.
3. Press Go to next lot. The compass, distance and mini-map lead you there. Press I'm here, shoot, pick the stage, press Submit.
4. Photos upload as you go and the agents are emailed automatically when the last lot is in.

## How the map is read

- `docs/mapread.js` takes the stars (position and colour) and the legend names straight from the PDF's own drawing data, then finds where each map screenshot sits on the master map by template matching, and gives each star the nearest lot label. Every lot number is checked against `docs/lots.json`.
- `docs/route.js` plans the visiting order over `docs/roads.png`, a grid of the community's streets and lakes, so the route follows roads and goes around water.
- The map has to be a PDF like the agents send now, with the stars drawn on top of map screenshots. A plain screenshot cannot be read; add those lots by hand.

## Rebuilding the master map

`docs/lots.json`, `docs/map.jpg` and `docs/roads.png` come from the Pulte brochure PDF. If the community map changes:

```
py tools/extract.py path/to/brochure.pdf docs
py tools/georef.py docs
```

`georef.py` pins the map to GPS coordinates using the street layout in `tools/osm-roads.json` (© OpenStreetMap contributors, ODbL). Needs `pymupdf numpy pillow scipy opencv-python-headless`.
