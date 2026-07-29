#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdDisable, cmdDoctor, cmdDuplicate, cmdEnable, cmdGc, cmdHook, cmdHooks, cmdInit, cmdList, cmdName, cmdPull, cmdPush, cmdRebase, cmdSplit, cmdStatus } from './commands.js';
import { CssError, log } from './engine/common.js';

const HELP = `chat — your agent sessions follow your repo (Claude Code + Codex)

usage:
  chat init [--url <git-url>] [--path <dir>]  one-time machine setup (private vault)
  chat enable [--no-hooks]                    register this repo + install git hooks
  chat disable                                remove hooks + registration (data untouched)
  chat push [-q]                              local sessions -> vault
  chat pull [-q] [--id <session|name>]        vault sessions -> local
  chat list                                   sessions for this repo
  chat status                                 sync state, conflicts, reachability
  chat name <session|name> <new-name>         name a session (names sync via the vault)
  chat rebase <session|name>                  reconcile a diverged session (replay tails onto trunk)
  chat split <session|name>                   turn a diverged branch into its own session
  chat duplicate <session|name>               fork a session into a new id
  chat hooks [install|uninstall|status]       manage the git hooks for this repo
  chat gc --keep <n> --days <n>               prune old sessions from the vault
  chat doctor [--verify <session-id>]         environment checks, secret scan, resume canary

  chat hook session-start|session-end|stop    (internal: Claude Code plugin events)

Anywhere a <session> is expected, a name, full id, or unique id prefix works.
("css" is kept as an alias bin.)
`;

interface Flags {
  quiet: boolean;
  noHooks: boolean;
  url?: string;
  path?: string;
  id?: string;
  verify?: string;
  keep?: number;
  days?: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { quiet: false, noHooks: false };
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
    else throw new CssError(`unknown argument: ${a}`, 'run chat help');
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

  // subcommand-style verbs take bare words (action, session, name) before flags
  const subArgs: string[] = [];
  if (['hooks', 'hook', 'merge', 'rebase', 'split', 'duplicate', 'name'].includes(cmd)) {
    while (rest[0] && !rest[0].startsWith('-')) subArgs.push(rest.shift()!);
  }
  const sub = subArgs[0];

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
    case 'rebase':
    case 'merge': // quiet alias for the pre-rename verb
      cmdRebase(cwd, sub);
      break;
    case 'split':
      cmdSplit(cwd, sub);
      break;
    case 'duplicate':
      cmdDuplicate(cwd, sub);
      break;
    case 'name':
      cmdName(cwd, sub, subArgs[1]);
      break;
    case 'doctor':
      await cmdDoctor(cwd, { verify: flags.verify });
      break;
    default:
      throw new CssError(`unknown command: ${cmd}`, 'run chat help');
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
