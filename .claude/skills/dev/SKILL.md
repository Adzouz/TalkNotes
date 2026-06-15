---
name: dev
description: Rebuild the TalkNotes UI and restart the local server safely. Use after any change under app/ui/src (the server serves the prebuilt app/ui/dist, there is no hot reload) or after editing app/server.js. Refuses to restart while a session is actively recording so a live talk is never interrupted.
---

# Rebuild & restart TalkNotes

The server (`app/server.js`, port 3033) serves the **prebuilt** UI from `app/ui/dist`.
UI source changes are invisible until you rebuild. Server changes need a process restart.
Restarting kills the recording ffmpeg process — never do it mid-talk.

All commands below assume the repo root as the working directory:

```bash
cd "$(git rev-parse --show-toplevel)"
```

## Steps

1. **Guard against a live recording.** Abort the restart if any session is recording:

   ```bash
   grep -l '"status": "recording"' sessions/*/meta.json 2>/dev/null \
     && echo "RECORDING IN PROGRESS — do not restart" || echo "safe to restart"
   ```

   If a session is recording, stop here and tell the user; only proceed once they confirm.

2. **Rebuild the UI** (skip if only `app/server.js` changed):

   ```bash
   npm --prefix app/ui run lint && npm --prefix app/ui run build
   ```

   `npm run build` is required after any `app/ui/src` edit. Lint should be clean before commit.

3. **Restart the server** (only needed for `app/server.js` changes; UI-only changes are
   picked up on browser refresh once dist is rebuilt):

   ```bash
   pkill -f "node server.js"; sleep 1
   nohup node app/server.js > /tmp/talk-notes.log 2>&1 &
   sleep 1; head -4 /tmp/talk-notes.log
   ```

   The log prints the UI URL, the active whisper model, and the phone LAN URL.

4. **Verify it's up:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" localhost:3033/api/sessions
   ```

## Notes

- `index.html` is served `no-cache` and hashed assets are immutable, so a plain browser
  refresh always loads the newest build — no hard-refresh needed after a rebuild.
- Logs (including caught exceptions) go to `/tmp/talk-notes.log`.
- To change the whisper model, drop a better `.bin` into `models/` and restart — the server
  picks the best one from `MODEL_PREFERENCE`.
