const express = require('express')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

require('dotenv').config({ path: path.join(__dirname, '.env') })

const BASE = path.join(__dirname, '..')
const SESSIONS_DIR = path.join(BASE, 'sessions')
// best available model wins; drop better .bin files into models/ and restart
const MODEL_PREFERENCE = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-medium.bin',
  'ggml-small.bin',
]
const MODEL = MODEL_PREFERENCE.map((m) => path.join(BASE, 'models', m)).find((p) =>
  fs.existsSync(p),
)
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || '0'
const SEGMENT_SECONDS = Number(process.env.SEGMENT_SECONDS || 15)
const PORT = Number(process.env.PORT || 3033)

fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// ---------- session storage ----------

const metaPath = (id) => path.join(SESSIONS_DIR, id, 'meta.json')

function readMeta(id) {
  return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'))
}

function writeMeta(id, patch) {
  const meta = { ...readMeta(id), ...patch }
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2))
  return meta
}

function listSessions() {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((d) => fs.existsSync(metaPath(d)))
    .map((d) => readMeta(d))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function readTranscript(id) {
  const p = path.join(SESSIONS_DIR, id, 'transcript.jsonl')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
}

function readNotes(id) {
  const md = path.join(SESSIONS_DIR, id, 'notes.md')
  if (fs.existsSync(md)) return fs.readFileSync(md, 'utf8')
  // migrate legacy timestamped notes.json
  const legacy = path.join(SESSIONS_DIR, id, 'notes.json')
  if (fs.existsSync(legacy)) {
    const entries = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    return entries.map((n) => `- ${n.text}`).join('\n') + '\n'
  }
  return ''
}

function listPhotos(id) {
  const p = path.join(SESSIONS_DIR, id, 'photos')
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
}

// ---------- SSE ----------

const sseClients = new Map() // sessionId -> Set<res>

function broadcast(id, event) {
  const clients = sseClients.get(id)
  if (!clients) return
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(data)
}

// ---------- recording + transcription ----------

// Single mic — one active recording at a time.
let rec = null // { sessionId, proc, audioDir, watcher, transcribed:Set, queue, busy }

function segIndexOf(file) {
  const m = /^seg-(\d+)\.wav$/.exec(file)
  return m ? Number(m[1]) : null
}

function enqueueTranscription(state, segFile) {
  if (state.transcribed.has(segFile)) return
  state.transcribed.add(segFile)
  state.queue.push(segFile)
  drainQueue(state)
}

function drainQueue(state) {
  if (state.busy || state.queue.length === 0) return
  state.busy = true
  const segFile = state.queue.shift()
  const wav = path.join(state.audioDir, segFile)
  // seed whisper with the talk title + tail of the previous chunk so
  // terminology and sentence flow carry across segment boundaries
  const title = readMeta(state.sessionId).title
  const prompt = `${title}. ${(state.lastText || '').slice(-150)}`
  const whisper = spawn('whisper-cli', [
    '-m',
    MODEL,
    '-f',
    wav,
    '-l',
    'auto',
    '-nt',
    '--no-prints',
    '--prompt',
    prompt,
  ])
  let out = ''
  whisper.stdout.on('data', (d) => (out += d))
  whisper.on('close', () => {
    const text = out.trim()
    // drop whisper silence hallucinations like [BLANK_AUDIO], (music)
    const isNoise = !text || /^[\[\(][^\]\)]*[\]\)]$/.test(text)
    if (!isNoise) {
      state.lastText = text
      const entry = { seg: segIndexOf(segFile), time: new Date().toISOString(), text }
      fs.appendFileSync(
        path.join(SESSIONS_DIR, state.sessionId, 'transcript.jsonl'),
        JSON.stringify(entry) + '\n',
      )
      broadcast(state.sessionId, { type: 'chunk', ...entry })
    }
    state.busy = false
    if (state.queue.length === 0 && state.drainedCallback) state.drainedCallback()
    drainQueue(state)
  })
}

function startRecording(id) {
  if (rec) throw new Error(`already recording session ${rec.sessionId}`)
  const meta = readMeta(id)
  const audioDir = path.join(SESSIONS_DIR, id, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const startNumber = meta.segCount || 0

  const proc = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    `:${AUDIO_DEVICE}`,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    // print per-frame RMS level on stdout → live mic meter in the UI
    '-af',
    'astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'segment',
    '-segment_time',
    String(SEGMENT_SECONDS),
    '-reset_timestamps',
    '1',
    '-segment_start_number',
    String(startNumber),
    path.join(audioDir, 'seg-%04d.wav'),
  ])
  proc.stderr.on('data', (d) => console.error(`[ffmpeg] ${d}`))
  let lastLevelSent = 0
  proc.stdout.on('data', (d) => {
    const m = /RMS_level=(-?[\d.]+|-inf)/.exec(d.toString())
    if (!m) return
    const now = Date.now()
    if (now - lastLevelSent < 250) return // throttle to 4/s
    lastLevelSent = now
    const db = m[1] === '-inf' ? -90 : Number(m[1])
    broadcast(id, { type: 'level', db })
  })

  const state = {
    sessionId: id,
    proc,
    audioDir,
    transcribed: new Set(
      readTranscript(id).map((e) => `seg-${String(e.seg).padStart(4, '0')}.wav`),
    ),
    queue: [],
    busy: false,
    drainedCallback: null,
  }

  // when seg N appears, seg N-1 is closed and ready to transcribe
  state.watcher = fs.watch(audioDir, (_evt, file) => {
    const idx = segIndexOf(file || '')
    if (idx === null || idx <= startNumber) return
    const prev = `seg-${String(idx - 1).padStart(4, '0')}.wav`
    if (fs.existsSync(path.join(audioDir, prev))) enqueueTranscription(state, prev)
  })

  proc.on('close', () => {
    state.watcher.close()
    // transcribe whatever segments remain (incl. final partial one)
    for (const f of fs.readdirSync(audioDir).sort()) {
      if (segIndexOf(f) !== null) enqueueTranscription(state, f)
    }
    const last = fs
      .readdirSync(audioDir)
      .map(segIndexOf)
      .filter((n) => n !== null)
    writeMeta(id, { segCount: last.length ? Math.max(...last) + 1 : 0 })
    const finish = () => broadcast(id, { type: 'status', status: readMeta(id).status })
    if (state.queue.length === 0 && !state.busy) finish()
    else state.drainedCallback = finish
    if (rec && rec.sessionId === id) rec = null
  })

  rec = state
  return writeMeta(id, { status: 'recording' })
}

function stopRecording(id, nextStatus) {
  if (!rec || rec.sessionId !== id) {
    return writeMeta(id, { status: nextStatus })
  }
  rec.proc.kill('SIGINT') // graceful: ffmpeg finalizes current segment
  const meta = writeMeta(id, { status: nextStatus })
  broadcast(id, { type: 'status', status: nextStatus })
  return meta
}

// ---------- summarize ----------

function buildContext(id) {
  const meta = readMeta(id)
  const transcript = readTranscript(id)
    .map((e) => e.text)
    .join('\n')
  const notes = readNotes(id).trim()
  return (
    `TALK TITLE: ${meta.title}\n\nTRANSCRIPT:\n${transcript}\n\n` +
    (notes ? `MY OWN NOTES TAKEN DURING THE TALK:\n${notes}\n` : '')
  )
}

const SUMMARY_PROMPT =
  'You are summarizing a JavaScript conference talk from an auto-generated transcript ' +
  "(expect transcription errors — infer the intended technical terms). The attendee's own " +
  'notes, if present, signal what mattered most to them: weave them in and give them weight. ' +
  'Produce a markdown summary with: a 2-3 sentence TL;DR, key technical points as bullets, ' +
  'libraries/tools/APIs mentioned (with what was said about them), notable quotes or hot ' +
  'takes, and action items worth trying later. The transcript and notes follow on stdin.'

function summarize(id, cb) {
  const context = buildContext(id)
  if (!readTranscript(id).length && !readNotes(id).trim()) {
    return cb(new Error('Nothing to summarize yet — record a transcript or write notes first.'))
  }
  const proc = spawn('claude', ['-p', SUMMARY_PROMPT])
  let out = ''
  let err = ''
  proc.stdout.on('data', (d) => (out += d))
  proc.stderr.on('data', (d) => (err += d))
  // spawn failure (claude missing from PATH, etc.) — must be handled or it throws
  proc.on('error', (e) =>
    cb(
      new Error(
        e.code === 'ENOENT'
          ? 'The `claude` CLI was not found on PATH. Install Claude Code and restart the server.'
          : `Failed to run claude: ${e.message}`,
      ),
    ),
  )
  proc.on('close', (code) => {
    if (code !== 0) {
      // claude often writes the real reason to stdout, not stderr
      const detail = (err || out).trim().slice(0, 500)
      return cb(
        new Error(detail || `claude exited ${code} (no output — check your Claude login/usage)`),
      )
    }
    if (!out.trim()) return cb(new Error('claude returned an empty summary — try Regenerate.'))
    fs.writeFileSync(path.join(SESSIONS_DIR, id, 'summary.md'), out)
    cb(null, out)
  })
  proc.stdin.on('error', () => {}) // ignore EPIPE if claude exits early
  proc.stdin.write(context)
  proc.stdin.end()
}

// ---------- HTTP ----------

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(
  express.static(path.join(__dirname, 'ui', 'dist'), {
    // hashed assets can cache forever; index.html must always revalidate
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache')
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }),
)
app.use('/files', express.static(SESSIONS_DIR))

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(SESSIONS_DIR, req.params.id, 'photos')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg'
      cb(null, `${Date.now()}${ext}`)
    },
  }),
})

app.get('/api/config', (_req, res) =>
  res.json({
    // feature flags driven by env — see README "Publish to Notion"
    notion: Boolean(process.env.NOTION_TOKEN && process.env.NOTION_PARENT_PAGE_ID),
  }),
)

app.get('/api/sessions', (_req, res) => res.json(listSessions()))

app.post('/api/sessions', (req, res) => {
  const title = (req.body.title || 'Untitled talk').trim()
  const id = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'talk'
  }`
  fs.mkdirSync(path.join(SESSIONS_DIR, id), { recursive: true })
  const meta = {
    id,
    title,
    createdAt: new Date().toISOString(),
    status: 'idle',
    segCount: 0,
  }
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2))
  res.json(meta)
})

app.get('/api/sessions/:id', (req, res) => {
  const { id } = req.params
  if (!fs.existsSync(metaPath(id))) return res.status(404).json({ error: 'not found' })
  const summaryPath = path.join(SESSIONS_DIR, id, 'summary.md')
  res.json({
    meta: readMeta(id),
    transcript: readTranscript(id),
    notes: readNotes(id),
    photos: listPhotos(id),
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null,
  })
})

app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params
  if (!fs.existsSync(metaPath(id))) return res.status(404).json({ error: 'not found' })
  const title = (req.body.title || '').trim()
  if (!title) return res.status(400).json({ error: 'title required' })
  res.json(writeMeta(id, { title }))
})

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params
  if (!fs.existsSync(metaPath(id))) return res.status(404).json({ error: 'not found' })
  if (rec && rec.sessionId === id) {
    rec.proc.kill('SIGINT')
    rec = null
  }
  fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true })
  sseClients.delete(id)
  res.json({ ok: true })
})

app.post('/api/sessions/:id/start', (req, res) => {
  try {
    res.json(startRecording(req.params.id))
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

app.post('/api/sessions/:id/pause', (req, res) => res.json(stopRecording(req.params.id, 'paused')))

app.post('/api/sessions/:id/stop', (req, res) => res.json(stopRecording(req.params.id, 'stopped')))

app.patch('/api/sessions/:id/transcript/:seg', (req, res) => {
  const { id } = req.params
  const seg = Number(req.params.seg)
  const text = (req.body.text || '').trim()
  const p = path.join(SESSIONS_DIR, id, 'transcript.jsonl')
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no transcript' })
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const entry = lines.find((l) => l.seg === seg)
  if (!entry) return res.status(404).json({ error: 'segment not found' })
  entry.text = text
  // emptied chunk = deleted chunk (useful for whisper hallucinations)
  const kept = lines.filter((l) => l.text)
  fs.writeFileSync(p, kept.map((l) => JSON.stringify(l)).join('\n') + (kept.length ? '\n' : ''))
  broadcast(id, { type: 'chunk-edit', seg, text })
  res.json({ seg, text })
})

app.put('/api/sessions/:id/notes', (req, res) => {
  const { id } = req.params
  fs.writeFileSync(path.join(SESSIONS_DIR, id, 'notes.md'), req.body.markdown || '')
  res.json({ ok: true })
})

app.get('/api/sessions/:id/notes.md', (req, res) => {
  const { id } = req.params
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${id}-notes.md"`)
  res.send(readNotes(id))
})

app.get('/api/sessions/:id/summary.md', (req, res) => {
  const { id } = req.params
  const p = path.join(SESSIONS_DIR, id, 'summary.md')
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no summary yet' })
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${id}-summary.md"`)
  res.send(fs.readFileSync(p, 'utf8'))
})

app.post('/api/sessions/:id/notion', async (req, res) => {
  const { id } = req.params
  const token = process.env.NOTION_TOKEN
  const parent = process.env.NOTION_PARENT_PAGE_ID
  if (!token || !parent) {
    return res.status(400).json({
      error:
        'Notion not configured: set NOTION_TOKEN and NOTION_PARENT_PAGE_ID in app/.env and restart. ' +
        'Create an integration at notion.so/my-integrations, then share the parent page with it.',
    })
  }
  const summaryPath = path.join(SESSIONS_DIR, id, 'summary.md')
  if (!fs.existsSync(summaryPath)) {
    return res.status(404).json({ error: 'No summary yet — generate one first.' })
  }
  try {
    const { Client: NotionClient } = require('@notionhq/client')
    const { markdownToBlocks } = require('@tryfabric/martian')
    const notion = new NotionClient({ auth: token })
    const meta = readMeta(id)
    const blocks = markdownToBlocks(fs.readFileSync(summaryPath, 'utf8'))
    const page = await notion.pages.create({
      parent: { page_id: parent },
      properties: { title: { title: [{ text: { content: meta.title } }] } },
      // Notion caps children at 100 blocks per request
      children: blocks.slice(0, 100),
    })
    res.json({ url: page.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/sessions/:id/photos', upload.array('photos', 10), (req, res) => {
  const files = (req.files || []).map((f) => f.filename)
  for (const f of files) broadcast(req.params.id, { type: 'photo', file: f })
  res.json({ files })
})

app.post('/api/sessions/:id/summarize', (req, res) => {
  summarize(req.params.id, (err, summary) => {
    if (err) return res.status(500).json({ error: err.message })
    broadcast(req.params.id, { type: 'summary', summary })
    res.json({ summary })
  })
})

app.get('/api/sessions/:id/events', (req, res) => {
  const { id } = req.params
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: {"type":"hello"}\n\n')
  if (!sseClients.has(id)) sseClients.set(id, new Set())
  sseClients.get(id).add(res)
  req.on('close', () => sseClients.get(id)?.delete(res))
})

// conference safety net: log unexpected errors instead of dying mid-talk
process.on('uncaughtException', (err) => console.error('[uncaught]', err))
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))

app.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)
  console.log(`talk-notes UI  →  http://localhost:${PORT}`)
  console.log(`whisper model  →  ${path.basename(MODEL || 'NONE FOUND')}`)
  if (lan) console.log(`from phone     →  http://${lan.address}:${PORT}  (same wifi)`)
})
