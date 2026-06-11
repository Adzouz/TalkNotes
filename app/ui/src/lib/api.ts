export type SessionStatus = 'idle' | 'recording' | 'paused' | 'stopped'

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  status: SessionStatus
  segCount: number
}

export interface Chunk {
  seg: number
  time: string
  text: string
}

export interface AppConfig {
  notion: boolean
}

export interface SessionDetail {
  meta: SessionMeta
  transcript: Chunk[]
  notes: string
  photos: string[]
  summary: string | null
}

export type SseEvent =
  | { type: 'hello' }
  | ({ type: 'chunk' } & Chunk)
  | { type: 'status'; status: SessionStatus }
  | { type: 'level'; db: number }
  | { type: 'photo'; file: string }
  | { type: 'summary'; summary: string }

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, opts)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      /* keep statusText */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
