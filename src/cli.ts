#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdDoctor, cmdEnable, cmdInit, cmdList, cmdPull, cmdPush, cmdStatus } from './commands.js';
import { CssError, log } from './engine/common.js';

const HELP = `css — repo-scoped session sync for Claude Code (and soon Codex)

usage:
  css init [--url <git-url>] [--path <dir>]   one-time machine setup (private vault)
  css enable                                  register this repo for sync
  css push [-q]                               local sessions -> vault
  css pull [-q] [--id <session-id>]           vault sessions -> local
  css list                                    sessions for this repo
  css status                                  sync state, conflicts, reachability
  css doctor [--verify <session-id>]          environment checks / resume canary
`;

interface Flags {
  quiet: boolean;
  url?: string;
  path?: string;
  id?: string;
  verify?: string;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { quiet: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-q' || a === '--quiet') flags.quiet = true;
    else if (a === '--url') flags.url = args[++i];
    else if (a === '--path') flags.path = args[++i];
    else if (a === '--id') flags.id = args[++i];
    else if (a === '--verify') flags.verify = args[++i];
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

  const flags = parseFlags(rest);
  log.quiet = flags.quiet;

  switch (cmd) {
    case 'init':
      cmdInit({ url: flags.url, path: flags.path });
      break;
    case 'enable':
      cmdEnable(cwd);
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
