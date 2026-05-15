import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  projectIdFor,
  projectIdForCwdLegacy,
  isProjectIdFilename,
} from './projectId'
import type {
  AgentType,
  CapturedProject,
  CapturedMessage,
  CapturedInteraction,
  CapturedRecord,
} from '../lib/anthropic-types'

// JSONL layout (current):
//   ~/.agentmind/projects/<projectId>.jsonl
//
// Where `projectId = sha256(cwd \0 agent).slice(0,16)`. One file per
// (cwd, agent) pair; the file accumulates every message + interaction
// ever captured for that agent in that working directory. A developer
// who runs both `claude` and `codex` in /foo gets two project files
// (one per agent), each containing only its own agent's traffic.
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
// Legacy on read (one-shot migrated on Storage init):
//   - `~/.agentmind/sessions/`  (renamed → `projects/`)
//   - `{type:"session", sessionId, …}` records (translated → project)
//   - `sessionId` field on message/interaction records (read as projectId)
//   - pre-0.2.0 files keyed by `sha256(cwd)` only — when these contain
//     interactions from multiple agents we split them per agent; when
//     they're single-agent we just rename them to the new id scheme.

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
    // Pass 1: pre-projectId-format files (UUID names from the
    // pre-0.1 sessions/ era). These get bucketed into legacy
    // cwd-only ids first; pass 2 then re-keys them.
    for (const name of fs.readdirSync(this.projectsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const base = name.slice(0, -'.jsonl'.length)
      if (isProjectIdFilename(base)) continue
      this.migrateOneLegacyFile(name)
    }
    // Pass 2: re-key any file whose name doesn't match the new
    // `sha(cwd, agent)` scheme — i.e. pre-0.2.0 cwd-only ids, or
    // mixed-agent files born from a single cwd that ran both
    // `claude` and `codex`. We can detect both by recomputing the
    // expected id from the file's actual contents.
    for (const name of fs.readdirSync(this.projectsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const base = name.slice(0, -'.jsonl'.length)
      if (!isProjectIdFilename(base)) continue
      this.maybeReKeyByAgent(name)
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

    // Stage 1 of migration only — emit using the LEGACY (cwd-only) id
    // so pass 2 can pick the file up and split it per-agent. Going
    // straight to the per-agent id here would mis-bucket mixed-agent
    // legacy files (they'd all end up tagged with whichever agent the
    // header claims, while the interactions span multiple).
    const projectId = projectIdForCwdLegacy(cwd)
    const dst = path.join(this.projectsDir, `${projectId}.jsonl`)

    const rewritten: string[] = []
    for (const { rec } of parsed) {
      const next: any = { ...rec, projectId }
      delete next.sessionId
      if ((rec as any).type === 'session') next.type = 'project'
      rewritten.push(JSON.stringify(next))
    }
    rewritten.push('')
    fs.appendFileSync(dst, rewritten.join('\n'), 'utf8')
    try { fs.unlinkSync(src) } catch {}
  }

  // Re-key one project file from the legacy `sha(cwd)`-only scheme to
  // the current `sha(cwd, agent)` scheme. If the file's interactions
  // span multiple agents (a developer ran both `claude` and `codex`
  // in the same dir before 0.2.0), split it into N files — one per
  // agent — each carrying only that agent's records.
  private maybeReKeyByAgent(filename: string) {
    const src = path.join(this.projectsDir, filename)
    const oldId = filename.slice(0, -'.jsonl'.length)
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

    // Walk the file once. We need: cwd, primaryAgent (from header),
    // per-interaction agentType, and a map messageId → agentType so we
    // can route the message records too.
    let cwd: string | undefined
    let headerAgent: AgentType | undefined
    let header: any
    const recsByType: { project: any[]; message: any[]; interaction: any[] } = {
      project: [],
      message: [],
      interaction: [],
    }
    const msgAgent = new Map<string, AgentType>()
    for (const line of lines) {
      const p = parseLegacyRecord(line, oldId)
      if (!p) continue
      const rec: any = p.rec
      if (rec.type === 'project') {
        recsByType.project.push(rec)
        if (!cwd && p.cwdHint) cwd = p.cwdHint
        if (!headerAgent && rec.primaryAgent) headerAgent = rec.primaryAgent
        header = rec
      } else if (rec.type === 'message') {
        recsByType.message.push(rec)
      } else if (rec.type === 'interaction') {
        recsByType.interaction.push(rec)
        if (!cwd && p.cwdHint) cwd = p.cwdHint
        const ag: AgentType = rec.agentType ?? headerAgent ?? 'claude-code'
        if (rec.messageId) msgAgent.set(rec.messageId, ag)
      }
    }

    // Fall back to whatever the header reports if no interaction or
    // header carried a cwd hint. Without ANY cwd we can't compute a
    // new id — leave the file alone (sidebar still surfaces it under
    // the old id; the user will see it but can't get per-agent
    // splitting until they next touch the project).
    if (!cwd && header?.cwd) cwd = header.cwd
    if (!cwd) return

    // If the file is already at the correct (cwd, agent) id AND
    // contains only one agent, nothing to do.
    const interactionAgents = new Set<AgentType>()
    for (const it of recsByType.interaction) {
      interactionAgents.add(it.agentType ?? headerAgent ?? 'claude-code')
    }
    if (interactionAgents.size === 0 && headerAgent) {
      interactionAgents.add(headerAgent)
    }
    if (interactionAgents.size === 1) {
      const onlyAgent = [...interactionAgents][0]!
      const expectedId = projectIdFor(cwd, onlyAgent)
      if (expectedId === oldId) return // already correct
    }

    // Split: for each agent represented in this file, emit a new
    // project file with all records belonging to that agent. Project
    // headers get cloned and stamped with the agent. Messages route
    // by the agentType of their interactions (msgAgent map).
    for (const agent of interactionAgents) {
      const newId = projectIdFor(cwd, agent)
      const dst = path.join(this.projectsDir, `${newId}.jsonl`)
      const out: string[] = []

      // Clone project header for this agent
      const baseHeader = header ?? { type: 'project' }
      const ph: any = {
        ...baseHeader,
        type: 'project',
        projectId: newId,
        cwd,
        primaryAgent: agent,
      }
      delete ph.sessionId
      out.push(JSON.stringify(ph))

      for (const m of recsByType.message) {
        const mAgent = msgAgent.get(m.messageId) ?? headerAgent ?? agent
        if (mAgent !== agent) continue
        out.push(JSON.stringify({ ...m, projectId: newId }))
      }
      for (const it of recsByType.interaction) {
        const itAgent: AgentType = it.agentType ?? headerAgent ?? agent
        if (itAgent !== agent) continue
        out.push(JSON.stringify({ ...it, projectId: newId, agentType: itAgent }))
      }
      out.push('')
      fs.appendFileSync(dst, out.join('\n'), 'utf8')
    }

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
