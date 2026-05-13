import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  CapturedSession,
  CapturedMessage,
  CapturedInteraction,
  CapturedRecord,
} from '../lib/anthropic-types'

// JSONL layout:
//   ~/.agentmind/sessions/<sessionId>.jsonl
//   ~/.agentmind/index.jsonl  (one line per session for quick listing)
//
// Each session JSONL is append-only; record kinds:
//   {type: "session", ...}         exactly one, first line
//   {type: "message", ...}         once per user-message turn
//   {type: "interaction", ...}     once per HTTP round-trip (overwritten via tail rewrite would be nice, but we
//                                  keep multiple writes — see writeInteraction below)
//
// Interactions update twice: once at request-start (partial), once at response-end (final).
// We don't seek-and-replace — instead we append the final record and the reader merges by
// interactionId, last-wins. Simple, crash-safe.

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agentmind')

export interface StorageOpts {
  dataDir?: string
}

export class Storage {
  readonly dataDir: string
  readonly sessionsDir: string

  constructor(opts: StorageOpts = {}) {
    this.dataDir = opts.dataDir ?? process.env.AGENTMIND_DATA_DIR ?? DEFAULT_DATA_DIR
    this.sessionsDir = path.join(this.dataDir, 'sessions')
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  sessionFile(sessionId: string) {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`)
  }

  appendRecord(sessionId: string, rec: CapturedRecord) {
    const line = JSON.stringify(rec) + '\n'
    fs.appendFileSync(this.sessionFile(sessionId), line, 'utf8')
  }

  // List sessions by mtime desc — fast, no parse.
  listSessions(): Array<{ sessionId: string; mtime: number; size: number }> {
    if (!fs.existsSync(this.sessionsDir)) return []
    const entries = fs.readdirSync(this.sessionsDir)
    const out: Array<{ sessionId: string; mtime: number; size: number }> = []
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const stat = fs.statSync(path.join(this.sessionsDir, name))
      out.push({ sessionId, mtime: stat.mtimeMs, size: stat.size })
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  // Read all records of a session. last-wins merge on interactionId.
  loadSession(sessionId: string): {
    session?: CapturedSession
    messages: CapturedMessage[]
    interactions: CapturedInteraction[]
  } {
    const file = this.sessionFile(sessionId)
    if (!fs.existsSync(file)) {
      return { messages: [], interactions: [] }
    }
    const text = fs.readFileSync(file, 'utf8')
    let session: CapturedSession | undefined
    const messages = new Map<string, CapturedMessage>()
    const interactions = new Map<string, CapturedInteraction>()
    for (const line of text.split('\n')) {
      if (!line) continue
      let rec: CapturedRecord
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec.type === 'session') session = rec
      else if (rec.type === 'message') messages.set(rec.messageId, rec)
      else if (rec.type === 'interaction') {
        const prev = interactions.get(rec.interactionId)
        // Merge: later record wins per-field, but preserve sseEvents from whichever side has them.
        if (prev) {
          interactions.set(rec.interactionId, {
            ...prev,
            ...rec,
            sseEvents: rec.sseEvents ?? prev.sseEvents,
            response: rec.response ?? prev.response,
          })
        } else {
          interactions.set(rec.interactionId, rec)
        }
      }
    }
    const messageList = Array.from(messages.values()).sort((a, b) => a.index - b.index)
    const interactionList = Array.from(interactions.values()).sort((a, b) => {
      if (a.messageId !== b.messageId) {
        const aMsg = messages.get(a.messageId)
        const bMsg = messages.get(b.messageId)
        return (aMsg?.index ?? 0) - (bMsg?.index ?? 0)
      }
      return a.index - b.index
    })
    return { session, messages: messageList, interactions: interactionList }
  }
}

export function newId(): string {
  return randomUUID()
}
