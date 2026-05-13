// Deterministic projectId derived from cwd.
//
// One project per cwd is the entire grouping model now (no time-window
// fallback), so every interaction that resolves a cwd lands in the same
// project — across multiple `claude` runs, across multiple days, across
// proxy restarts. Making the id a stable hash of the cwd has three
// payoffs:
//
//   1. Storage layer never needs a "find the existing file for this cwd"
//      lookup — the filename IS the answer.
//   2. URLs are stable for bookmarking; reopening a project days later
//      goes to the same `/projects/<id>` page.
//   3. Two proxy processes seeing the same cwd produce the same id, so
//      restarting the proxy mid-run never forks a project.
//
// 16 hex chars (64 bits) is plenty for the few-hundred-projects scale
// we expect on a single developer's machine, and short enough to fit in
// log lines and URLs comfortably.

import { createHash } from 'node:crypto'
import * as path from 'node:path'

const ID_LEN = 16

export function projectIdForCwd(cwd: string): string {
  // Normalise so trivial differences (trailing slash, mixed separators on
  // Windows, …/./… segments) collapse onto the same project. We
  // intentionally do NOT resolve symlinks — two different paths reaching
  // the same physical directory stay as two projects, because that's
  // also how `claude` shows them.
  const norm = path.normalize(cwd).replace(/[/\\]+$/, '')
  return createHash('sha256').update(norm).digest('hex').slice(0, ID_LEN)
}

const FILENAME_RE = new RegExp(`^[0-9a-f]{${ID_LEN}}$`)

// True iff `name` looks like a projectId — used by the storage layer's
// one-shot migration to decide whether a legacy random-UUID jsonl needs
// to be merged into its cwd-derived destination.
export function isProjectIdFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}
