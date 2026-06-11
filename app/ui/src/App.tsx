import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { NotesEditor } from '@/components/NotesEditor'
import {
  api,
  json,
  type AppConfig,
  type SessionDetail,
  type SessionMeta,
  type SessionStatus,
  type SseEvent,
} from '@/lib/api'
import {
  AudioLines,
  Camera,
  Check,
  Download,
  ImageIcon,
  Menu,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const STATUS_STYLE: Record<SessionStatus, { dot: string; label: string; text: string }> = {
  recording: { dot: 'bg-red-500 animate-pulse', label: 'Recording', text: 'text-red-400' },
  paused: { dot: 'bg-yellow-500', label: 'Paused', text: 'text-yellow-400' },
  stopped: { dot: 'bg-emerald-500', label: 'Done', text: 'text-emerald-400' },
  idle: { dot: 'bg-zinc-500', label: 'Idle', text: 'text-muted-foreground' },
}

function StatusPill({ status, compact }: { status: SessionStatus; compact?: boolean }) {
  const s = STATUS_STYLE[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${
        compact
          ? `text-[11px] ${s.text}`
          : `rounded-full border bg-background/40 px-3 py-1 text-xs font-medium ${s.text}`
      }`}
    >
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

// live mic meter — proves audio is actually being captured
function MicMeter({ db }: { db: number | null }) {
  if (db === null) return null
  const pct = Math.max(0, Math.min(1, (db + 60) / 45)) // -60dB → 0, -15dB → full
  const bars = 5
  const lit = Math.round(pct * bars)
  return (
    <span
      className="inline-flex items-end gap-[3px] rounded-full border bg-background/40 px-2.5 py-1.5"
      title={`mic level ${Math.round(db)} dB`}
    >
      <MicIcon active={lit > 0} />
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          style={{ height: 5 + i * 2.5 }}
          className={`w-[3px] rounded-full transition-colors duration-150 ${
            i < lit ? (i >= bars - 1 ? 'bg-red-400' : 'bg-emerald-400') : 'bg-muted-foreground/25'
          }`}
        />
      ))}
    </span>
  )
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <Mic
      className={`mr-1 size-3 self-center ${
        active ? 'text-emerald-400' : 'text-muted-foreground/50'
      }`}
    />
  )
}

function PaneHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b px-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [micLevel, setMicLevel] = useState<number | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [notionUrl, setNotionUrl] = useState<string | null>(null)
  const [config, setConfig] = useState<AppConfig>({ notion: false })
  const transcriptRef = useRef<HTMLDivElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)

  const loadSessions = useCallback(() => api<SessionMeta[]>('/sessions').then(setSessions), [])

  const openSession = useCallback(async (id: string) => {
    setCurrent(id)
    setEditingTitle(false)
    setSheetOpen(false)
    setNotionUrl(null)
    setDetail(await api<SessionDetail>(`/sessions/${id}`))
  }, [])

  // load config + session list, auto-open the most recent session
  useEffect(() => {
    api<AppConfig>('/config').then(setConfig)
    api<SessionMeta[]>('/sessions').then((list) => {
      setSessions(list)
      if (list.length > 0) openSession(list[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SSE subscription per session
  useEffect(() => {
    if (!current) return
    const es = new EventSource(`/api/sessions/${current}/events`)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as SseEvent
      if (ev.type === 'level') {
        setMicLevel(ev.db)
        return
      }
      if (ev.type === 'status') setMicLevel(null)
      setDetail((d) => {
        if (!d) return d
        if (ev.type === 'chunk') {
          const { seg, time, text } = ev
          return { ...d, transcript: [...d.transcript, { seg, time, text }] }
        }
        if (ev.type === 'status') {
          loadSessions()
          return { ...d, meta: { ...d.meta, status: ev.status } }
        }
        if (ev.type === 'photo') return { ...d, photos: [...d.photos, ev.file] }
        if (ev.type === 'summary') return { ...d, summary: ev.summary }
        return d
      })
    }
    return () => es.close()
  }, [current, loadSessions])

  // stale-meter guard: clear if level events stop arriving (ffmpeg died/paused)
  useEffect(() => {
    if (micLevel === null) return
    const t = setTimeout(() => setMicLevel(null), 2000)
    return () => clearTimeout(t)
  }, [micLevel])

  // autoscroll transcript when near bottom
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      el.scrollTop = el.scrollHeight
    }
  }, [detail?.transcript.length])

  const createSession = async () => {
    const title = newTitle.trim()
    if (!title) return
    const meta = await api<SessionMeta>('/sessions', json({ title }))
    setNewTitle('')
    await loadSessions()
    openSession(meta.id)
  }

  const ctl = async (action: 'start' | 'pause' | 'stop') => {
    if (!current) return
    try {
      const meta = await api<SessionMeta>(`/sessions/${current}/${action}`, { method: 'POST' })
      setDetail((d) => (d ? { ...d, meta } : d))
      loadSessions()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const startRename = () => {
    if (!detail) return
    setTitleDraft(detail.meta.title)
    setEditingTitle(true)
  }

  const saveRename = async () => {
    const title = titleDraft.trim()
    setEditingTitle(false)
    if (!current || !detail || !title || title === detail.meta.title) return
    const meta = await api<SessionMeta>(`/sessions/${current}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    setDetail((d) => (d ? { ...d, meta } : d))
    loadSessions()
  }

  const deleteSession = async () => {
    if (!current) return
    await api(`/sessions/${current}`, { method: 'DELETE' })
    setDeleteOpen(false)
    setDetail(null)
    setCurrent(null)
    const list = await api<SessionMeta[]>('/sessions')
    setSessions(list)
    if (list.length > 0) openSession(list[0].id)
  }

  // saved summary opens instantly; AI only runs when there is none (or on Regenerate)
  const summarize = async () => {
    if (!current || !detail) return
    if (detail.summary) {
      setSummaryOpen(true)
      return
    }
    await runSummarize()
  }

  const runSummarize = async () => {
    if (!current) return
    setSummarizing(true)
    try {
      const { summary } = await api<{ summary: string }>(`/sessions/${current}/summarize`, {
        method: 'POST',
      })
      setDetail((d) => (d ? { ...d, summary } : d))
      setNotionUrl(null)
      setSummaryOpen(true)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setSummarizing(false)
    }
  }

  const publishNotion = async () => {
    if (!current) return
    setPublishing(true)
    try {
      const { url } = await api<{ url: string }>(`/sessions/${current}/notion`, {
        method: 'POST',
      })
      setNotionUrl(url)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const uploadPhotos = useCallback(
    async (files: File[]) => {
      if (!current || files.length === 0) return
      const fd = new FormData()
      files.forEach((f) => fd.append('photos', f))
      await fetch(`/api/sessions/${current}/photos`, { method: 'POST', body: fd })
    },
    [current],
  )

  // paste / drop anywhere (outside the notes editor) adds photos
  useEffect(() => {
    const inEditor = (e: Event) => e.target instanceof Element && e.target.closest('.notes-editor')
    const onPaste = (e: ClipboardEvent) => {
      if (inEditor(e) || !e.clipboardData) return
      uploadPhotos([...e.clipboardData.files].filter((f) => f.type.startsWith('image/')))
    }
    const onDragOver = (e: DragEvent) => {
      if (!inEditor(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (inEditor(e) || !e.dataTransfer) return
      e.preventDefault()
      uploadPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')))
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [uploadPhotos])

  const status = detail?.meta.status ?? 'idle'

  const sidebarContent = (
    <>
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
          <Mic className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">Talk Notes</div>
          <div className="text-[11px] text-muted-foreground">conference recorder</div>
        </div>
      </div>
      <div className="flex gap-2 px-4 pb-3.5">
        <Input
          className="h-8 text-sm"
          placeholder="New talk title…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createSession()}
        />
        <Button size="sm" className="h-8 shrink-0 px-2.5" onClick={createSession}>
          <Plus className="size-4" />
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 p-2">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left transition-colors ${
                current === s.id ? 'bg-accent' : 'hover:bg-accent/50'
              }`}
            >
              <div className="truncate text-[13px] font-medium">{s.title}</div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {new Date(s.createdAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <StatusPill status={s.status} compact />
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No sessions yet.
              <br />
              Name the talk above and hit +
            </p>
          )}
        </div>
      </ScrollArea>
    </>
  )

  return (
    <div className="flex h-dvh gap-2.5 overflow-hidden bg-background p-2.5">
      {/* ── sidebar (desktop) ───────────────────────── */}
      <aside className="hidden w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:flex">
        {sidebarContent}
      </aside>

      {/* ── sidebar (mobile sheet) ──────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Sessions</SheetTitle>
          </SheetHeader>
          {sidebarContent}
        </SheetContent>
      </Sheet>

      {/* ── main ────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto lg:overflow-hidden">
        {!detail ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-xl border bg-card text-muted-foreground">
            <Mic className="mb-3 size-10 opacity-30" />
            <h2 className="text-sm font-medium text-foreground">No session selected</h2>
            <p className="mt-1 text-xs">Create or pick a session.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 lg:hidden"
              onClick={() => setSheetOpen(true)}
            >
              <Menu className="size-4" /> Sessions
            </Button>
          </div>
        ) : (
          <>
            {/* header */}
            <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 lg:px-5">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 lg:hidden"
                onClick={() => setSheetOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <div className="group flex min-w-0 flex-[1_1_60%] items-center gap-1.5 sm:flex-1">
                {editingTitle ? (
                  <div className="flex w-full max-w-md items-center gap-1.5">
                    <Input
                      autoFocus
                      className="h-8"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename()
                        if (e.key === 'Escape') setEditingTitle(false)
                      }}
                      onBlur={saveRename}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      onMouseDown={saveRename}
                    >
                      <Check className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <h2 className="truncate text-base font-semibold leading-tight">
                        {detail.meta.title}
                      </h2>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0 text-muted-foreground opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100"
                        onClick={startRename}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0 text-muted-foreground opacity-100 transition-opacity hover:text-red-400 lg:opacity-0 lg:group-hover:opacity-100"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {fmtDate(detail.meta.createdAt)}
                    </p>
                  </div>
                )}
              </div>
              <MicMeter db={micLevel} />
              <StatusPill status={status} />
              <div className="flex flex-wrap items-center gap-1.5">
                {status !== 'recording' && (
                  <Button size="sm" onClick={() => ctl('start')}>
                    <Play /> {status === 'paused' ? 'Resume' : 'Start recording'}
                  </Button>
                )}
                {status === 'recording' && (
                  <Button size="sm" variant="secondary" onClick={() => ctl('pause')}>
                    <Pause /> Pause
                  </Button>
                )}
                {(status === 'recording' || status === 'paused') && (
                  <Button size="sm" variant="destructive" onClick={() => ctl('stop')}>
                    <Square /> Stop
                  </Button>
                )}
                <Separator orientation="vertical" className="mx-1 hidden !h-5 sm:block" />
                <Button size="sm" variant="outline" disabled={summarizing} onClick={summarize}>
                  <Sparkles className={summarizing ? 'animate-pulse' : ''} />
                  {summarizing ? 'Summarizing…' : detail.summary ? 'Summary' : 'Summarize'}
                </Button>
              </div>
            </header>

            <div className="flex min-h-0 flex-col gap-2.5 lg:flex-1 lg:flex-row">
              {/* transcript */}
              <section className="flex h-[45dvh] shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:h-auto min-w-0 lg:min-h-0 lg:flex-[5] lg:shrink">
                <PaneHeader label="Live transcript">
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {detail.transcript.length > 0 && `${detail.transcript.length} chunks`}
                  </span>
                </PaneHeader>
                <div ref={transcriptRef} className="flex-1 overflow-y-auto py-3">
                  {detail.transcript.map((c, i) => (
                    <div
                      key={c.seg}
                      className={`group flex gap-3 px-4 py-1 hover:bg-accent/40 lg:px-5 ${
                        i === detail.transcript.length - 1
                          ? 'animate-in fade-in slide-in-from-bottom-1 duration-300'
                          : ''
                      }`}
                    >
                      <span className="w-11 shrink-0 pt-[3px] text-right font-mono text-[10px] leading-relaxed text-muted-foreground/70">
                        {fmtTime(c.time)}
                      </span>
                      <p className="min-w-0 text-sm leading-relaxed">{c.text}</p>
                    </div>
                  ))}
                  {detail.transcript.length === 0 && (
                    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                      <AudioLines className="mb-3 size-9 opacity-30" />
                      <p className="text-sm font-medium text-foreground/80">
                        {status === 'recording' ? 'Listening…' : 'Nothing recorded yet'}
                      </p>
                      <p className="mt-1 text-xs">
                        {status === 'recording'
                          ? 'First words land in ~20 seconds.'
                          : 'Hit “Start recording” when the speaker begins.'}
                      </p>
                    </div>
                  )}
                </div>
              </section>

              {/* notes + photos */}
              <section className="flex shrink-0 flex-col gap-2.5 min-w-0 lg:min-h-0 lg:flex-[4] lg:shrink">
                <div className="flex h-[55dvh] shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:h-auto lg:min-h-0 lg:flex-[3] lg:shrink">
                  <NotesEditor
                    key={detail.meta.id}
                    sessionId={detail.meta.id}
                    initialMarkdown={detail.notes}
                  />
                </div>
                <div className="flex min-h-36 shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:min-h-0 lg:flex-[1] lg:shrink">
                  <PaneHeader label="Photos">
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      multiple
                      hidden
                      onChange={(e) => {
                        uploadPhotos([...(e.target.files ?? [])])
                        e.target.value = ''
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => photoInputRef.current?.click()}
                    >
                      <Camera className="size-3.5" /> Add
                    </Button>
                  </PaneHeader>
                  <div className="flex flex-wrap content-start gap-2 overflow-y-auto p-3">
                    {detail.photos.map((f) => (
                      <img
                        key={f}
                        src={`/files/${detail.meta.id}/photos/${f}`}
                        className="h-[72px] w-24 cursor-pointer rounded-md border object-cover transition-opacity hover:opacity-75"
                        onClick={() => setLightbox(`/files/${detail.meta.id}/photos/${f}`)}
                      />
                    ))}
                    {detail.photos.length === 0 && (
                      <button
                        onClick={() => photoInputRef.current?.click()}
                        className="flex h-[72px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
                      >
                        <ImageIcon className="size-4 opacity-50" />
                        <span className="text-[11px]">Drop, paste, or snap from your phone</span>
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </main>

      {/* summary dialog */}
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-yellow-400" /> {detail?.meta.title}
            </DialogTitle>
          </DialogHeader>
          <div className="prose prose-invert prose-sm min-h-0 max-w-none flex-1 overflow-y-auto prose-headings:font-semibold">
            <ReactMarkdown>{detail?.summary ?? ''}</ReactMarkdown>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            {notionUrl && (
              <a
                href={notionUrl}
                target="_blank"
                rel="noreferrer"
                className="mr-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                View in Notion ↗
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (window.location.href = `/api/sessions/${current}/summary.md`)}
            >
              <Download className="size-3.5" /> Save .md
            </Button>
            {config.notion && (
              <Button
                variant="ghost"
                size="sm"
                disabled={publishing || !!notionUrl}
                onClick={publishNotion}
              >
                <Send className="size-3.5" />
                {notionUrl ? 'Published ✓' : publishing ? 'Publishing…' : 'Publish to Notion'}
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={summarizing} onClick={runSummarize}>
              <Sparkles className={`size-3.5 ${summarizing ? 'animate-pulse' : ''}`} />
              {summarizing ? 'Regenerating…' : 'Regenerate'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{detail?.meta.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the recording, transcript, notes and photos permanently. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={deleteSession}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* lightbox */}
      <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent className="max-w-[95vw] border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
          <DialogHeader className="sr-only">
            <DialogTitle>Photo</DialogTitle>
          </DialogHeader>
          {lightbox && (
            <img src={lightbox} className="max-h-[90dvh] w-full rounded-lg object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
