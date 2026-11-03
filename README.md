# OFFNOTE — your private notebook

OFFNOTE is a lightweight, offline-first note-taking app designed to feel quiet and private. It runs entirely in the browser and keeps notes saved on the current device, making it easy to capture ideas without relying on a cloud service.

## Features

- Create, edit, archive, pin, and delete notes
- Organize with folders and tags
- Search notes quickly
- Markdown-style writing with a preview panel
- Link notes with double-bracket references like `[[Note title]]`
- Works offline as a progressive web app (PWA)
- Keeps data local to the browser on the current device

## Run locally

Because this project is a static web app, you can open it directly in a browser or serve it locally.

### Option 1: Open directly

Open `index.html` in your browser.

### Option 2: Run a local web server

From the project folder, run:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Project files

- `index.html` — app shell and layout
- `styles.css` — UI styling
- `app.js` — application logic and note management
- `manifest.json` — PWA manifest
- `sw.js` — service worker for offline support
- `icon.svg` — app icon

## Notes

This app is intentionally focused on local, private note storage. It does not require backend services or account setup for normal use.
