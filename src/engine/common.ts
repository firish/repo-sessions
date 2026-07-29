import { createHash } from 'node:crypto';

/** Error with a user-facing hint; the CLI prints message + hint and exits 1. */
export class CssError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export const log = {
  quiet: false,
  info(msg: string): void {
    if (!this.quiet) console.log(msg);
  },
  warn(msg: string): void {
    if (!this.quiet) console.error(`chat: warning: ${msg}`);
  },
  error(msg: string): void {
    console.error(`chat: ${msg}`);
  },
};

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** CRLF -> LF. Vault content is LF-canonical; Windows git checkouts
 *  (core.autocrlf) reintroduce CRLF, which must never read as a content
 *  change — it caused false "overwriting X's version" memory warnings. */
export function normalizeEol(s: string): string {
  return s.replaceAll('\r\n', '\n');
}

/** True when `shorter` is a strict or equal prefix of `longer`. Transcripts are
 *  append-only, so prefix relations decide fast-forward vs conflict. */
export function isPrefixOf(shorter: string, longer: string): boolean {
  return longer.length >= shorter.length && longer.startsWith(shorter);
}

export function nowIso(): string {
  return new Date().toISOString();
}
