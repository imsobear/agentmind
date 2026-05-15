// Deterministic projectId derived from (cwd, agentType).
//
// A "project" in AgentMind groups all traffic from one agent running in
// one working directory. Two reasons agent is part of the key:
//
//   1. Mixed-agent cwds: developers regularly run both `claude` and
//      `codex` in the same repo, sometimes alternating turns. Stuffing
//      them into a single project mangles the message chain (Codex's
//      `input[]` and Claude's `messages[]` never share a prefix, so
//      every interaction opens a fresh "message" anyway) AND forces a
//      single `primaryAgent` badge that lies about half the content.
//      Splitting by agent makes each project a coherent conversation.
//
//   2. UI affordance: the sidebar already shows an agent badge per
//      project. Keeping that badge truthful means projects must be
//      single-agent — otherwise we'd need a chimeric badge nobody asked
//      for.
//
// The id is `sha256(cwd \0 agent).slice(0,16)`. The \0 separator is
// safe because no legal cwd component contains a null byte, and it
// prevents accidental collisions between cwds whose hashes would
// otherwise touch the agent suffix space.
//
// 16 hex chars (64 bits) is plenty for the few-hundred-projects scale
// we expect on a single developer's machine, and short enough to fit in
// log lines and URLs comfortably.

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { AgentType } from '../lib/anthropic-types'

const ID_LEN = 16

function normaliseCwd(cwd: string): string {
  // Trivial differences (trailing slash, mixed separators on Windows,
  // …/./… segments) collapse onto the same project. We intentionally
  // do NOT resolve symlinks — two different paths reaching the same
  // physical directory stay as two projects, because that's also how
  // `claude` and `codex` show them.
  return path.normalize(cwd).replace(/[/\\]+$/, '')
}

export function projectIdFor(cwd: string, agent: AgentType): string {
  const norm = normaliseCwd(cwd)
  return createHash('sha256').update(norm).update('\0').update(agent).digest('hex').slice(0, ID_LEN)
}

// Pre-0.2.x scheme — kept ONLY for the storage migration that re-keys
// legacy files onto the new (cwd, agent) scheme. Production code should
// never call this except from `migrateLegacy`.
export function projectIdForCwdLegacy(cwd: string): string {
  const norm = normaliseCwd(cwd)
  return createHash('sha256').update(norm).digest('hex').slice(0, ID_LEN)
}

const FILENAME_RE = new RegExp(`^[0-9a-f]{${ID_LEN}}$`)

// True iff `name` looks like a projectId — used by the storage layer's
// one-shot migration to decide whether a legacy random-UUID jsonl needs
// to be merged into its hashed destination.
export function isProjectIdFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}
