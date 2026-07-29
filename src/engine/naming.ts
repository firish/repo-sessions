import { CssError } from './common.js';
import type { ProjectEntry } from './vault.js';

/**
 * Session names (chat name). Names live in the vault index, so they travel
 * across machines with the sessions and work identically for every adapter —
 * no dependence on tool-native naming. Anywhere a command takes a session,
 * it accepts a name, a full id, or a unique id prefix.
 */

const NAME_RE = /^[A-Za-z0-9][\w./-]{0,59}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateName(raw: string): string {
  const name = raw.trim();
  if (!NAME_RE.test(name)) {
    throw new CssError(`invalid name "${raw}"`, 'letters/digits then letters, digits, . _ / -; max 60 chars; no spaces');
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(name)) {
    throw new CssError('names must not look like session ids');
  }
  return name;
}

export function findByName(project: ProjectEntry, name: string): { toolId: string; sessionId: string } | null {
  for (const [toolId, tool] of Object.entries(project.tools)) {
    for (const [sessionId, entry] of Object.entries(tool.sessions)) {
      if (entry.name === name) return { toolId, sessionId };
    }
  }
  return null;
}

/** name -> id -> unique id prefix, in that order. */
export function resolveSessionInput(project: ProjectEntry | undefined, input: string): string {
  if (UUID_RE.test(input)) return input;
  if (!project) throw new CssError(`no session named "${input}" (vault has nothing for this repo yet)`);
  const byName = findByName(project, input);
  if (byName) return byName.sessionId;

  if (/^[0-9a-f-]{6,}$/i.test(input)) {
    const matches = new Set<string>();
    for (const tool of Object.values(project.tools)) {
      for (const sessionId of Object.keys(tool.sessions)) {
        if (sessionId.startsWith(input.toLowerCase())) matches.add(sessionId);
      }
    }
    if (matches.size === 1) return [...matches][0]!;
    if (matches.size > 1) throw new CssError(`ambiguous id prefix "${input}" (${matches.size} matches)`);
  }
  throw new CssError(`no session named "${input}"`, 'chat list shows names and ids');
}

/** Derived names (split/duplicate) never collide: base, base-2, base-3, … */
export function uniquifyName(project: ProjectEntry, base: string): string {
  if (!findByName(project, base)) return base;
  for (let i = 2; ; i++) {
    if (!findByName(project, `${base}-${i}`)) return `${base}-${i}`;
  }
}
