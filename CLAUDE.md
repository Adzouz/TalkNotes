# TalkNotes — project notes for Claude

Local-first conference talk recorder: ffmpeg → whisper.cpp → SSE → React UI, summaries via `claude -p`.

## Layout

- `app/server.js` — single-file Express API + recording/transcription orchestration (CommonJS)
- `app/ui/` — Vite + React 19 + TS + Tailwind v4 + shadcn/ui (base preset, dark only)
- `talk` / `retranscribe.sh` — bash CLI tools (original pipeline / redo transcript from stored wavs)
- `sessions/<id>/` — runtime data (gitignored): meta.json, audio/seg-\*.wav, transcript.jsonl, notes.md, photos/, summary.md
- `models/` — whisper ggml models (gitignored); server picks best from `MODEL_PREFERENCE`

## Commands

- `npm start` — run server on :3033 (serves `app/ui/dist`)
- `npm run build` — build UI (REQUIRED after any `app/ui/src` change; server serves dist, no hot reload)
- `npm run dev` — Vite dev server, proxies `/api` + `/files` to :3033
- `npm run lint` / `npm run format`
- UI screenshot/verification: `node app/ui/shot.mjs <url> <out.png> [w] [h]` (playwright-core +
  installed Chrome; reports JS errors + horizontally overflowing elements; headless Chrome
  clamps `--window-size` width to ≥500 so use this for mobile viewports)

## Architecture decisions

- Live transcription = ffmpeg segment muxer (15s wavs) + `fs.watch`; when seg N appears, seg N-1
  is complete → whisper-cli transcribes it (serial queue) → append transcript.jsonl → SSE broadcast.
- Pause/resume = kill ffmpeg (SIGINT, finalizes segment) / respawn with `-segment_start_number segCount`.
- whisper gets `--prompt` = session title + last 150 chars of previous chunk (cross-segment context).
  Silence hallucinations filtered by bracket-pattern regex only.
- Mic level: ffmpeg `-af astats,ametadata` prints RMS to stdout → throttled SSE `level` events →
  MicMeter component. Mic permission belongs to the TERMINAL app (server-side recording);
  the browser never asks.
- One active recording at a time (single `rec` state, module-level).
- Summaries spawn `claude -p` with transcript+notes on stdin — no API key needed.

## Gotchas

- shadcn base preset ships dark `--accent` as near-white → overridden in `src/index.css` (.dark block).
- Toast UI editor (npm, v3.2.2) blended via `.notes-editor` overrides at the end of `index.css`
  (`!important` required). tui-color-picker CSS contains IE star-hacks →
  `css.lightningcss.errorRecovery: true` in vite.config.ts is required to build.
- `index.html` served with `Cache-Control: no-cache`, hashed assets immutable — don't undo,
  stale-HTML caching caused "missing features" reports.
- Type shims for untyped Toast UI packages live in `app/ui/src/toastui.d.ts`.
- Never restart the server while a session status is `recording` — check
  `sessions/*/meta.json` first; a restart kills ffmpeg and orphans the live talk.

## Conventions

- Conventional Commits (commitlint + husky enforce).
- Prettier: no semicolons, single quotes, width 100. shadcn `components/ui/` excluded from
  prettier + the react-refresh lint rule.
