# TalkNotes 🎙️

Record conference talks, transcribe them **locally** in near-real-time with whisper.cpp, take rich
markdown notes and slide photos alongside, then generate an AI summary at the end. Built to survive
conference wifi: everything runs on your laptop, only the summary step calls Claude.

![status](https://img.shields.io/badge/status-v0.1-blue) ![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

## Features

- **Live transcription** — audio recorded in 15s segments, each transcribed as it lands
  (~20s behind the speaker), streamed to the browser over SSE
- **Sessions** — one per talk: create, rename, delete, pause/resume, browse history
- **Live mic meter** — see that audio is actually being captured
- **WYSIWYG notes** — Toast UI editor (headings, bold, colors…), stored as plain `notes.md`,
  autosaved, exportable
- **Photos** — drag-drop / paste on laptop, or open the LAN URL on your phone and snap
  slides straight into the session
- **AI summary** — transcript + your notes → structured markdown summary via `claude -p`
  (your notes are weighted as "what mattered"); saved per session and reopened instantly,
  with Regenerate / Save .md / Publish to Notion actions
- **Responsive UI** — React + Tailwind + shadcn/ui, works from a phone

## Requirements

- macOS (uses avfoundation for mic capture)
- [Homebrew](https://brew.sh): `brew install ffmpeg whisper-cpp node`
- [Claude Code](https://claude.com/claude-code) CLI on PATH (for summaries)
- A whisper model in `models/` — recommended:
  ```bash
  mkdir -p models
  curl -L -o models/ggml-large-v3-turbo-q5_0.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  ```
  The server picks the best model present (see `MODEL_PREFERENCE` in `app/server.js`).

## Run

```bash
npm install
npm --prefix app install
npm --prefix app/ui install
npm run build          # build the UI once
npm start              # http://localhost:3033 (+ LAN URL for your phone)
```

Grant microphone access to your terminal app when macOS asks
(System Settings → Privacy & Security → Microphone).

## Develop

```bash
npm start              # API server on :3033
npm run dev            # Vite dev server with HMR, proxies /api → :3033
npm run lint           # ESLint (UI)
npm run format         # Prettier (repo-wide)
```

Pre-commit hooks (husky): lint-staged runs Prettier + ESLint; commit messages must follow
[Conventional Commits](https://www.conventionalcommits.org) (enforced by commitlint).

## How it works

```
mic ──ffmpeg──▶ sessions/<id>/audio/seg-NNNN.wav   (16 kHz mono, 15s segments)
                      │ fs.watch: segment complete
                      ▼
               whisper-cli (local, Metal)           --prompt = title + previous chunk
                      │
                      ▼
               transcript.jsonl ──SSE──▶ browser (live transcript + mic level)
                      │
                      ▼  "Summarize"
               claude -p (transcript + notes.md) ──▶ summary.md
```

Each session is a plain folder under `sessions/` — audio, `transcript.jsonl`, `notes.md`,
`photos/`, `summary.md`. Easy to back up, grep, or post-process.

`./retranscribe.sh <session-id>` re-runs transcription on stored audio (e.g. after
upgrading the model) — the original transcript is kept as a `.bak`.

## Configuration (env vars)

| Variable          | Default | Description                            |
| ----------------- | ------- | -------------------------------------- |
| `PORT`            | `3033`  | HTTP port                              |
| `AUDIO_DEVICE`    | `0`     | avfoundation audio device index        |
| `SEGMENT_SECONDS` | `15`    | segment length = transcription cadence |

List devices: `ffmpeg -f avfoundation -list_devices true -i ""`

## Publish to Notion (optional)

The "Publish to Notion" button only appears in the summary dialog once both env vars below
are set — without them the feature is hidden entirely.

> Creating a connection requires **workspace owner** rights in Notion. On a work
> workspace where you're a regular member, either ask an owner to create it for you,
> or use a personal workspace.

1. Create a connection at [notion.so/my-integrations](https://www.notion.so/my-integrations)
   → New connection → auth method **Access token** (not OAuth) → select workspace → copy
   the `ntn_…` secret.
2. In Notion, open the page that should hold the summaries → ⋯ menu → Connections →
   add your integration.
3. Copy the page id (the 32-char hex part of the page URL) and create `app/.env`:
   ```
   NOTION_TOKEN=ntn_xxx
   NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
4. Restart the server. "Publish to Notion" in the summary dialog creates a child page
   titled after the session.

## Privacy

Recordings, transcripts, notes and photos never leave your machine — `sessions/` and `models/`
are gitignored. The only network call is the optional summary step through your Claude account.
