# Task: refactor-and-docs

Two related cleanups packaged together:

1. **Begin SRP refactor of `server/player.js`** by extracting the
   selector-resolution and resilient click/fill primitives into a focused
   module (`server/selectors.js`).
2. **Documentation** — `.devin/skills/macro-recorder/SKILL.md` for future Devin
   sessions, and a rewritten `README.md` covering architecture, MCP, resilient
   selectors, snapshot GC, and the editor's debug/undo features.

## Acceptance Criteria

### AC1 — `server/selectors.js` extracted
- Exports `resolveSelector`, `smartClick`, `smartFill`, `debugHighlightAndShot`.
- Pure (no module-level mutable state). Takes `wss` / `tempDir` /
  `broadcastStatus` via opts.

### AC2 — `player.js` delegates
- Imports from `./selectors.js` at the top.
- Thin shims (~3 lines each) preserve the existing call signatures.
- Old function bodies removed.
- Net `wc -l` decrease in `player.js`.

### AC3 — `npm run smoke` PASS
- 36/36 still PASS — selector behaviour unchanged.

### AC4 — Skill file
- `.devin/skills/macro-recorder/SKILL.md` covers layout, common commands, env
  vars, step concepts, "when making changes" workflow.

### AC5 — README rewritten
- Architecture diagram + per-file table.
- Sections: install (server + extension + MCP), run macros (UI / API / MCP),
  editor features, supported blocks, resilient selectors, snapshot GC, smoke
  tests.

### AC6 — No behaviour regression
- Same module-level state, same exec contract, same WebSocket events.

## Procedure

1. Build `server/selectors.js` with extracted helpers.
2. Replace inline functions in `player.js` with import + shims.
3. Update `README.md`.
4. Add `.devin/skills/macro-recorder/SKILL.md`.
5. Run smoke, commit, push, open PR.
