---
name: verify-ui
description: Visually verify the TalkNotes web UI by driving the running app with a real browser — take screenshots at desktop and mobile viewports, and report JavaScript errors and horizontally overflowing elements. Use after UI changes to confirm layout and catch runtime errors and responsive breakage. Requires the server running on :3033 and a rebuilt dist.
---

# Verify the TalkNotes UI

Headless Chrome `--screenshot` silently clamps window width to ≥500px, so it cannot
screenshot true mobile viewports. Use the repo's `app/ui/shot.mjs` (playwright-core driving
installed Chrome) instead — it also reports `pageerror` events and any element wider than the
viewport.

## Prerequisites

Server must be running and dist rebuilt — run the `dev` skill first if unsure.

## Screenshot a viewport

From the repo root (`cd "$(git rev-parse --show-toplevel)"`):

```bash
cd app/ui
node shot.mjs http://localhost:3033/ /tmp/tn-desktop.png 1400 900   # desktop
node shot.mjs http://localhost:3033/ /tmp/tn-mobile.png 390 844     # phone
```

It prints `{ errors: [...], overflow: [...] }` — both arrays must be empty. Then Read the PNG
to inspect the layout visually.

## Drive a specific flow

For interactions (open a dialog, click a control, edit a transcript word), write an inline
playwright-core script. Pattern:

```bash
cd app/ui && node -e "
import('playwright-core').then(async ({ chromium }) => {
  const b = await chromium.launch({ channel: 'chrome', headless: true })
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
  await p.goto('http://localhost:3033/', { waitUntil: 'networkidle' }).catch(()=>{})
  await p.waitForTimeout(1200)
  // … interact: p.click('text=Summary'), p.fill(...), p.keyboard.press('Enter') …
  await p.screenshot({ path: '/tmp/tn-flow.png' })
  await b.close()
})"
```

## Notes

- The app auto-opens the most recent session, so a real transcript/notes/summary is usually
  on screen to test against.
- If you mutate real data while testing (edit a transcript word, rename, delete), revert it
  afterward via the matching API endpoint — the user records real talks in this app.
- `transcript words` are clickable spans with `title="Click to fix"`; the summary dialog
  exposes `Regenerate` / `Save .md` / (when configured) `Publish to Notion`.
