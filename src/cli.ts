#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdDisable, cmdDoctor, cmdDuplicate, cmdEnable, cmdGc, cmdHook, cmdHooks, cmdInit, cmdList, cmdMerge, cmdPull, cmdPush, cmdStatus } from './commands.js';
import { CssError, log } from './engine/common.js';

const HELP = `css — repo-scoped session sync for Claude Code and Codex

usage:
  css init [--url <git-url>] [--path <dir>]   one-time machine setup (private vault)
  css enable [--no-hooks]                     register this repo + install git hooks
  css disable                                 remove hooks + registration (data untouched)
  css push [-q]                               local sessions -> vault
  css pull [-q] [--id <session-id>]           vault sessions -> local
  css list                                    sessions for this repo
  css status                                  sync state, conflicts, reachability
  css merge <session-id> [--split]            reconcile a diverged session (splice tails;
                                              --split keeps branches as separate sessions)
  css duplicate <session-id>                  fork a session into a new id
  css hooks [install|uninstall|status]        manage the git hooks for this repo
  css gc --keep <n> --days <n>                prune old sessions from the vault
  css doctor [--verify <session-id>]          environment checks, secret scan, resume canary

  css hook session-start|session-end|stop     (internal: Claude Code plugin events)
`;

interface Flags {
  quiet: boolean;
  noHooks: boolean;
  split: boolean;
  url?: string;
  path?: string;
  id?: string;
  verify?: string;
  keep?: number;
  days?: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { quiet: false, noHooks: false, split: false };
  const num = (v: string | undefined, flag: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new CssError(`${flag} needs a non-negative integer`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-q' || a === '--quiet') flags.quiet = true;
    else if (a === '--no-hooks') flags.noHooks = true;
    else if (a === '--url') flags.url = args[++i];
    else if (a === '--path') flags.path = args[++i];
    else if (a === '--id') flags.id = args[++i];
    else if (a === '--verify') flags.verify = args[++i];
    else if (a === '--keep') flags.keep = num(args[++i], '--keep');
    else if (a === '--days') flags.days = num(args[++i], '--days');
    else if (a === '--split') flags.split = true;
    else throw new CssError(`unknown argument: ${a}`, 'run css help');
  }
  return flags;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    console.log(pkg.version);
    return;
  }

  // subcommand-style verbs take a bare word (action or session id) before flags
  let sub: string | undefined;
  if ((cmd === 'hooks' || cmd === 'hook' || cmd === 'merge' || cmd === 'duplicate') && rest[0] && !rest[0].startsWith('-')) {
    sub = rest.shift();
  }

  const flags = parseFlags(rest);
  log.quiet = flags.quiet;

  switch (cmd) {
    case 'init':
      cmdInit({ url: flags.url, path: flags.path });
      break;
    case 'enable':
      cmdEnable(cwd, { noHooks: flags.noHooks });
      break;
    case 'disable':
      cmdDisable(cwd);
      break;
    case 'hooks':
      cmdHooks(cwd, sub);
      break;
    case 'hook':
      cmdHook(cwd, sub);
      break;
    case 'push':
      cmdPush(cwd, { quiet: flags.quiet });
      break;
    case 'pull':
      cmdPull(cwd, { quiet: flags.quiet, id: flags.id });
      break;
    case 'list':
      cmdList(cwd);
      break;
    case 'status':
      cmdStatus(cwd);
      break;
    case 'gc':
      cmdGc({ keep: flags.keep, days: flags.days });
      break;
    case 'merge':
      cmdMerge(cwd, sub, { split: flags.split });
      break;
    case 'duplicate':
      cmdDuplicate(cwd, sub);
      break;
    case 'doctor':
      await cmdDoctor(cwd, { verify: flags.verify });
      break;
    default:
      throw new CssError(`unknown command: ${cmd}`, 'run css help');
  }
}

main().catch((err: unknown) => {
  if (err instanceof CssError) {
    log.error(err.message);
    if (err.hint) log.error(`hint: ${err.hint}`);
  } else {
    log.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
