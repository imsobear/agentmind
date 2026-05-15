import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { projectIdForCwd, isProjectIdFilename } from './projectId'
import type {
  CapturedProject,
  CapturedMessage,
  CapturedInteraction,
  CapturedRecord,
} from '../lib/anthropic-types'

// JSONL layout (current):
//   ~/.agentmind/projects/<projectId>.jsonl
//
// Where `projectId = sha256(cwd).slice(0,16)`. One file per cwd; the file
// accumulates every message + interaction ever captured for that cwd.
//
// Each line is one record:
//   {type: "project",     ...}   one or more (last one wins per field)
//   {type: "message",     ...}   one per user-message turn
//   {type: "interaction", ...}   one or two per HTTP round-trip
//
// Interactions update twice (partial at request-start, final at
// response-end). We don't seek-and-replace — the reader merges by
// interactionId, last-wins. Simple, crash-safe.
//
// Legacy on read:
//   - `~/.agentmind/sessions/`  (renamed → `projects/`)
//   - `{type:"session", sessionId, …}` records (translated → project)
//   - `sessionId` field on message/interaction records (read as projectId)
// All legacy data is one-shot migrated on Storage init: same-cwd files
// are merged into the new cwd-keyed file with their records rewritten
// to the new schema, then the source file is removed.

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agentmind')

export interface StorageOpts {
  dataDir?: string
}

interface ParsedRecord {
  rec: CapturedRecord
  cwdHint?: string
}

export class Storage {
  readonly dataDir: string
  readonly projectsDir: string

  constructor(opts: StorageOpts = {}) {
    this.dataDir = opts.dataDir ?? process.env.AGENTMIND_DATA_DIR ?? DEFAULT_DATA_DIR
    this.projectsDir = path.join(this.dataDir, 'projects')
    fs.mkdirSync(this.projectsDir, { recursive: true })
    this.migrateLegacy()
  }

  projectFile(projectId: string) {
    return path.join(this.projectsDir, `${projectId}.jsonl`)
  }

  appendRecord(projectId: string, rec: CapturedRecord) {
    const line = JSON.stringify(rec) + '\n'
    fs.appendFileSync(this.projectFile(projectId), line, 'utf8')
  }

  // List projects by mtime desc — fast, no parse.
  listProjects(): Array<{ projectId: string; mtime: number; size: number }> {
    if (!fs.existsSync(this.projectsDir)) return []
    const entries = fs.readdirSync(this.projectsDir)
    const out: Array<{ projectId: string; mtime: number; size: number }> = []
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const projectId = name.slice(0, -'.jsonl'.length)
      const stat = fs.statSync(path.join(this.projectsDir, name))
      out.push({ projectId, mtime: stat.mtimeMs, size: stat.size })
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  // Read all records of a project. last-wins merge on interactionId.
  loadProject(projectId: string): {
    project?: CapturedProject
    messages: CapturedMessage[]
    interactions: CapturedInteraction[]
  } {
    const file = this.projectFile(projectId)
    if (!fs.existsSync(file)) {
      return { messages: [], interactions: [] }
    }
    const text = fs.readFileSync(file, 'utf8')
    let project: CapturedProject | undefined
    const messages = new Map<string, CapturedMessage>()
    const interactions = new Map<string, CapturedInteraction>()
    for (const line of text.split('\n')) {
      if (!line) continue
      const parsed = parseLegacyRecord(line, projectId)
      if (!parsed) continue
      const rec = parsed.rec
      if (rec.type === 'project') project = rec
      else if (rec.type === 'message') messages.set(rec.messageId, rec)
      else if (rec.type === 'interaction') {
        const prev = interactions.get(rec.interactionId)
        // Merge: later record wins per-field, but preserve sseEvents and
        // response from whichever side has them.
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
    return { project, messages: messageList, interactions: interactionList }
  }

  // One-shot migration on startup.
  //
  //   step A · rename ~/.agentmind/sessions/ → ~/.agentmind/projects/
  //            (best-effort move of each child; we never overwrite an
  //             existing destination — those will be handled in step B
  //             where they look the same as any other legacy file).
  //   step B · for each *.jsonl in projects/ whose name is NOT the new
  //            cwd-hashed format: read it, resolve its cwd, append all
  //            records (rewritten to project-schema) into the proper
  //            destination, then unlink the source.
  //
  // Idempotent — running twice on already-migrated data is a no-op.
  private migrateLegacy() {
    const oldDir = path.join(this.dataDir, 'sessions')
    if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
      for (const name of fs.readdirSync(oldDir)) {
        const src = path.join(oldDir, name)
        const dst = path.join(this.projectsDir, name)
        if (fs.existsSync(dst)) continue
        try {
          fs.renameSync(src, dst)
        } catch {
          // Cross-device or perms — bail on this entry, keep migrating
          // the rest. The legacy file stays in place, accessible later
          // if the user investigates.
        }
      }
      // Try removing the now-empty (hopefully) legacy dir.
      try {
        if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir)
      } catch {}
    }

    if (!fs.existsSync(this.projectsDir)) return
    for (const name of fs.readdirSync(this.projectsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const base = name.slice(0, -'.jsonl'.length)
      if (isProjectIdFilename(base)) continue
      this.migrateOneLegacyFile(name)
    }
  }

  private migrateOneLegacyFile(filename: string) {
    const src = path.join(this.projectsDir, filename)
    let text: string
    try {
      text = fs.readFileSync(src, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n').filter((l) => l.length > 0)
    if (!lines.length) {
      try { fs.unlinkSync(src) } catch {}
      return
    }
    // Resolve cwd: prefer the project/session header, else scan
    // interactions for the first request that exposes one in its system
    // prompt. Without a cwd we can't bucket this file into a project, so
    // we leave it on disk under its original name — the read-side list
    // will silently skip files whose names aren't projectIds.
    let cwd: string | undefined
    const parsed: ParsedRecord[] = []
    for (const line of lines) {
      const p = parseLegacyRecord(line, 'legacy')
      if (!p) continue
      parsed.push(p)
      if (!cwd && p.cwdHint) cwd = p.cwdHint
    }
    if (!cwd) return

    const projectId = projectIdForCwd(cwd)
    const dst = path.join(this.projectsDir, `${projectId}.jsonl`)

    // Translate each record to the new schema with the freshly-minted
    // projectId. The source file's UUID-style id is discarded; everything
    // for this cwd now points at the canonical projectId.
    const rewritten: string[] = []
    for (const { rec } of parsed) {
      const next: any = { ...rec, projectId }
      delete next.sessionId
      if ((rec as any).type === 'session') next.type = 'project'
      rewritten.push(JSON.stringify(next))
    }
    rewritten.push('') // trailing newline
    fs.appendFileSync(dst, rewritten.join('\n'), 'utf8')
    try { fs.unlinkSync(src) } catch {}
  }
}

// Parse a JSONL line tolerantly: accept both new (`{type:"project",
// projectId}`) and legacy (`{type:"session", sessionId}`) record shapes
// and surface a normalised CapturedRecord plus, for migration purposes,
// the best-guess cwd hint that line carries.
function parseLegacyRecord(line: string, contextProjectId: string): ParsedRecord | undefined {
  let raw: any
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined

  // type tag translation
  const t = raw.type
  if (t !== 'project' && t !== 'session' && t !== 'message' && t !== 'interaction') {
    return undefined
  }

  // Normalise: every record carries a projectId field internally. If the
  // legacy record only had `sessionId` we lift that into `projectId`. The
  // sessionId is otherwise meaningless after migration.
  const projectId: string = raw.projectId ?? raw.sessionId ?? contextProjectId
  const rec: any = { ...raw, projectId }
  delete rec.sessionId

  if (t === 'session') rec.type = 'project'

  let cwdHint: string | undefined
  if (rec.type === 'project' && typeof rec.cwd === 'string') {
    cwdHint = rec.cwd
  } else if (rec.type === 'interaction') {
    const sys = rec.request?.system
    let text = ''
    if (typeof sys === 'string') text = sys
    else if (Array.isArray(sys)) {
      for (const b of sys) {
        const tt = b?.text
        if (typeof tt === 'string') text += tt + '\n'
      }
    }
    if (text) {
      const m = text.match(/(?:cwd|working[_ ]?directory)\s*[:=]\s*([^\n]+)/i)
      const c = m?.[1]?.trim()
      if (c) cwdHint = c
    }
  }

  return { rec, cwdHint }
}

export function newId(): string {
  return randomUUID()
}
