# Browser Macro Recorder

Build a complete browser macro recorder with these components:

## Architecture
1. **Chrome Extension** (recorder) — content script that highlights elements on hover, captures clicks/typing, sends steps to server via WebSocket
2. **Node.js Server** (localhost:3700) — Express + WebSocket, stores macros as JSON, serves the editor UI
3. **Web Editor** (served by the server) — edit/reorder/delete steps, view snapshots, run macros
4. **Playwright Player** — executes recorded macros

## Key Feature: Pause/Resume Recording
The most important UX feature: when recording multi-step flows where step 2's button only appears after clicking step 1's button, the user needs to:
- Record step 1 (e.g., click "Login" button)
- **Pause recording** → click the button for real (browser navigates) → **Resume recording**
- Record step 2 (now visible after navigation)

Implementation:
- **⏸ Pause/▶ Resume** button in the extension popup AND as a floating overlay on the page
- **▶ Execute Step** button next to each recorded step in the editor (executes that single step via Playwright so the page navigates, then you can continue recording)
- **▶▶ Execute All Up To Here** button — runs all steps up to a selected point

## Chrome Extension Details
- manifest.json (Manifest V3)
- content.js — injects into all pages, highlights elements on hover (blue outline), on click shows a floating menu with actions:
  - 📌 Click (record a click on this element)
  - ✍️ Type Text (record typing into this field, shows input for text)
  - 👁 Read Text (record reading text from this element)
  - ⏳ Wait (wait for this element to appear)
  - ⏸ Real Click (perform actual click WITHOUT recording — for navigation between steps)
- popup.html/popup.js — shows recording status, macro name, pause/resume, stop, list of recorded steps
- background.js — service worker, manages WebSocket connection to server
- Uses CSS selector + XPath + text content for robust element identification
- Takes a mini-screenshot/snapshot of the element area when recording

## Server Details
- Express server on port 3700
- WebSocket for real-time communication with extension
- REST API:
  - GET /api/macros — list all macros
  - GET /api/macros/:id — get macro with steps
  - POST /api/macros — create new macro
  - PUT /api/macros/:id — update macro
  - DELETE /api/macros/:id — delete macro
  - POST /api/macros/:id/run — execute macro via Playwright
  - POST /api/macros/:id/steps/:stepIndex/run — execute single step
  - POST /api/macros/:id/run-to/:stepIndex — execute all steps up to index
- Stores macros in ./data/ as JSON files
- Each step has: type, selector, xpath, textContent, value, timestamp, screenshot (base64 thumbnail)

## Editor UI Details
- Modern dark theme, clean UI
- Left sidebar: list of macros
- Main area: step list with drag-to-reorder
- Each step shows: icon, description, selector preview, mini-screenshot
- Each step has buttons: ▶ Execute, ✏️ Edit, 🗑 Delete
- Top toolbar: ▶▶ Run All, ▶ Run To Selected, ⏸ Pause at step, + Add Step manually
- Status bar: shows Playwright execution progress

## Tech Stack
- Node.js + Express + ws (WebSocket)
- Playwright for execution
- Vanilla JS for extension (no build step needed)
- Editor: vanilla HTML/CSS/JS (served by Express, no framework needed)
- Simple, no unnecessary dependencies

## File Structure
```
macro-recorder/
├── server/
│   ├── index.js          (Express + WS server)
│   ├── player.js         (Playwright executor)
│   ├── package.json
│   └── data/             (stored macros)
├── editor/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   ├── popup.css
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

Build everything. Make it work. Use modern JS (ES modules where possible).
All UI text in Russian.
