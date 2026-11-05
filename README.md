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
- Customize the background, font color, and font family in Settings
- Use Google Fonts online or upload a WOFF2, WOFF, TTF, or OTF font (up to 10 MB); uploaded font files stay on this device
- Change the Private password and re-encrypt protected notes on this device

## Working

This app is a front-end-only notebook built with plain HTML, CSS, and JavaScript. When you open the project in a browser, the `index.html` page loads the UI and the app logic from `app.js`.

The application keeps everything in the browser using `localStorage`, which means your notes are stored on the same device where the app is running. There is no server, database, or login system involved in the normal workflow.

Here is the basic flow:

1. The page loads and initializes the app state.
2. `app.js` reads existing saved notes from `localStorage`.
3. The sidebar shows your note list, folders, tags, and filters.
4. When you create or edit a note, the app updates the in-memory data and saves it back to `localStorage`.
5. The editor renders the current note title, tags, folder, and markdown content.
6. The preview panel converts markdown to a rendered preview for easier reading.
7. Searches, pinned items, archives, and note relationships are derived from the saved data and UI state.
8. The service worker (`sw.js`) helps the app keep working when the browser is offline by caching the static assets.

Because the app is a PWA, it behaves like a small local app rather than a traditional web app. This makes it fast, simple, and private while still supporting offline use.

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
