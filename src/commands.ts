import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAdapters } from './adapters/registry.js';
import { CssError, isPrefixOf, log, nowIso, sha256hex } from './engine/common.js';
import { defaultVaultPath, deviceName, loadConfig, saveConfig, type CssConfig } from './engine/config.js';
import { git, gitCommonDir, originUrl, repoToplevel } from './engine/git.js';
import { repoKeyFromOrigin } from './engine/repoKey.js';
import { pullSessions, pushSessions, type SyncCtx } from './engine/sync.js';
import { Vault } from './engine/vault.js';

interface Marker {
  dirName: string;
  slug: string;
  origin: string;
  enabledAt: string;
  lastPush?: string;
  lastPull?: string;
  dirty?: boolean;
}

function markerPath(repoRoot: string): string {
  return join(gitCommonDir(repoRoot), 'css.json'); // inside .git — never tracked
}

function readMarker(repoRoot: string): Marker | null {
  const p = markerPath(repoRoot);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Marker) : null;
}

function writeMarker(repoRoot: string, marker: Marker): void {
  writeFileSync(markerPath(repoRoot), `${JSON.stringify(marker, null, 2)}\n`);
}

function requireConfig(): CssConfig {
  const cfg = loadConfig();
  if (!cfg) throw new CssError('css is not initialized on this machine', 'run: css init --url <private-git-url>');
  return cfg;
}

function requireRepo(cwd: string): string {
  const root = repoToplevel(cwd);
  if (!root) throw new CssError('not inside a git repository');
  return root;
}

function requireEnabled(repoRoot: string): Marker {
  const marker = readMarker(repoRoot);
  if (!marker) throw new CssError('this repo is not enabled for session sync', 'run: css enable');
  return marker;
}

function buildCtx(repoRoot: string, cfg: CssConfig): SyncCtx {
  const adapters = detectAdapters();
  if (adapters.length === 0) log.warn('no supported agent tools detected on this machine');
  return { repoRoot, cfg, home: homedir(), adapters };
}

function gh(args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 });
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() };
}

// ---------------------------------------------------------------- init

export function cmdInit(opts: { url?: string; path?: string }): void {
  let url = opts.url;
  if (!url) {
    // No URL given: try to create a private vault repo via gh.
    if (!gh(['--version']).ok) {
      throw new CssError('no vault URL given and gh is not installed', 'run: css init --url <private-git-url>');
    }
    const login = gh(['api', 'user', '-q', '.login']);
    if (!login.ok || !login.stdout) throw new CssError('gh is not authenticated', 'gh auth login, or pass --url');
    const name = 'claude-sessions-vault';
    const create = gh(['repo', 'create', `${login.stdout}/${name}`, '--private']);
    if (!create.ok) {
      throw new CssError(`could not create ${login.stdout}/${name}`, 'create a private repo yourself and pass --url');
    }
    url = `git@github.com:${login.stdout}/${name}.git`;
    log.info(`created private vault repo ${login.stdout}/${name}`);
  }

  // The vault must be private — hard requirement (transcripts may hold secrets).
  const ghMatch = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (ghMatch && gh(['--version']).ok) {
    const vis = gh(['repo', 'view', `${ghMatch[1]}/${ghMatch[2]}`, '--json', 'visibility', '-q', '.visibility']);
    if (vis.ok && vis.stdout.toUpperCase() !== 'PRIVATE') {
      throw new CssError(`vault repo ${ghMatch[1]}/${ghMatch[2]} is ${vis.stdout} — refusing`, 'make it private first');
    }
  } else {
    log.warn('cannot verify vault visibility — make sure this remote is private');
  }

  const vaultPath = opts.path ?? defaultVaultPath();
  if (existsSync(join(vaultPath, '.git'))) {
    const existing = git(['remote', 'get-url', 'origin'], { cwd: vaultPath, allowFail: true });
    if (!existing.ok || existing.stdout !== url) {
      throw new CssError(`${vaultPath} already exists with a different remote`, 'pass --path to use another location');
    }
  }

  const cfg: CssConfig = { vaultUrl: url, vaultPath, device: deviceName() };
  new Vault(cfg).ensureCloned();
  saveConfig(cfg);
  log.info(`vault ready at ${vaultPath} (device: ${cfg.device})`);
  log.info('next: run "css enable" inside a repo you want synced');
}

// ---------------------------------------------------------------- enable

export function cmdEnable(cwd: string): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const origin = originUrl(root);
  if (!origin) {
    throw new CssError('this repo has no "origin" remote', 'add one first: git remote add origin <url>');
  }
  const key = repoKeyFromOrigin(origin);
  const vault = new Vault(cfg);
  vault.ensureCloned();
  vault.refresh();
  writeMarker(root, { dirName: key.dirName, slug: key.slug, origin: key.normalized, enabledAt: nowIso() });
  log.info(`enabled: ${key.slug} -> vault namespace ${key.dirName}`);
  log.info('sessions will sync on css push / css pull (git hooks arrive in M2)');
}

// ---------------------------------------------------------------- push / pull

export function cmdPush(cwd: string, opts: { quiet: boolean }): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  try {
    const res = pushSessions(buildCtx(root, cfg));
    marker.lastPush = nowIso();
    marker.dirty = false;
    writeMarker(root, marker);
    const changed = res.pushed + res.fastForwarded;
    log.info(
      `push: ${res.pushed} new, ${res.fastForwarded} updated, ${res.upToDate} up-to-date` +
        (res.remoteAhead ? `, ${res.remoteAhead} remote-ahead` : '') +
        (res.conflicts ? `, ${res.conflicts} CONFLICT` : '') +
        (changed || res.conflicts ? ' — vault updated' : ''),
    );
  } catch (err) {
    // G5: a missing vault must never break the flow that triggered us.
    marker.dirty = true;
    writeMarker(root, marker);
    if (opts.quiet) return;
    throw err;
  }
}

export function cmdPull(cwd: string, opts: { quiet: boolean; id?: string }): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  try {
    const res = pullSessions(buildCtx(root, cfg), opts.id);
    marker.lastPull = nowIso();
    writeMarker(root, marker);
    log.info(
      `pull: ${res.installed} installed, ${res.fastForwarded} updated, ${res.upToDate} up-to-date` +
        (res.localAhead ? `, ${res.localAhead} local-ahead` : '') +
        (res.conflicts ? `, ${res.conflicts} diverged (kept local)` : ''),
    );
  } catch (err) {
    if (opts.quiet) return;
    throw err;
  }
}

// ---------------------------------------------------------------- list / status

interface Row {
  sessionId: string;
  tool: string;
  state: 'synced' | 'ahead' | 'behind' | 'remote' | 'unsynced' | 'diverged';
  device: string;
  lastTs?: string;
  summary?: string;
  conflicts?: string[];
}

function collectRows(ctx: SyncCtx): Row[] {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  try {
    vault.refresh();
  } catch {
    log.warn('vault unreachable — showing last-synced state');
  }
  const origin = originUrl(ctx.repoRoot);
  if (!origin) return [];
  const key = repoKeyFromOrigin(origin);
  const project = vault.loadIndex().projects[key.dirName];
  const rows: Row[] = [];

  for (const { adapter, env } of ctx.adapters) {
    const locals = adapter.locate(ctx.repoRoot, env);
    const localById = new Map(locals.map((r) => [r.sessionId, r]));
    const remote = project?.tools[adapter.id]?.sessions ?? {};

    for (const [sessionId, entry] of Object.entries(remote)) {
      const local = localById.get(sessionId);
      localById.delete(sessionId);
      if (!local) {
        rows.push({ sessionId, tool: adapter.id, state: 'remote', device: entry.device, lastTs: entry.lastTs, summary: entry.summary, conflicts: entry.conflicts });
        continue;
      }
      const localTok = adapter.tokenize(readFileSync(local.filePath, 'utf8'), {
        projectRoot: ctx.repoRoot,
        home: ctx.home,
      });
      let state: Row['state'];
      if (sha256hex(localTok) === entry.sha256) state = 'synced';
      else {
        const vaultTranscript = join(vault.path, key.dirName, adapter.id, 'sessions', sessionId, 'transcript.jsonl');
        const remoteTok = existsSync(vaultTranscript) ? readFileSync(vaultTranscript, 'utf8') : '';
        state = isPrefixOf(remoteTok, localTok) ? 'ahead' : isPrefixOf(localTok, remoteTok) ? 'behind' : 'diverged';
      }
      rows.push({ sessionId, tool: adapter.id, state, device: entry.device, lastTs: local.lastTs ?? entry.lastTs, summary: local.summary ?? entry.summary, conflicts: entry.conflicts });
    }
    for (const local of localById.values()) {
      rows.push({ sessionId: local.sessionId, tool: adapter.id, state: 'unsynced', device: ctx.cfg.device, lastTs: local.lastTs, summary: local.summary });
    }
  }
  return rows.sort((a, b) => (a.lastTs ?? '').localeCompare(b.lastTs ?? ''));
}

export function cmdList(cwd: string): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  requireEnabled(root);
  const rows = collectRows(buildCtx(root, cfg));
  if (rows.length === 0) {
    log.info('no sessions for this repo yet');
    return;
  }
  for (const r of rows) {
    const age = r.lastTs ? r.lastTs.slice(0, 16).replace('T', ' ') : '                ';
    const flag = r.conflicts?.length ? ` [conflicts: ${r.conflicts.join(',')}]` : '';
    log.info(
      `${r.sessionId.slice(0, 8)}  ${r.tool.padEnd(6)}  ${r.state.padEnd(8)}  ${r.device.padEnd(12)}  ${age}  ${(r.summary ?? '').slice(0, 48)}${flag}`,
    );
  }
}

export function cmdStatus(cwd: string): void {
  const cfg = loadConfig();
  if (!cfg) {
    log.info('css: not initialized (run css init)');
    return;
  }
  log.info(`vault: ${cfg.vaultUrl}`);
  const reachable = git(['ls-remote', '--heads', cfg.vaultUrl], { allowFail: true, timeoutMs: 10_000 });
  log.info(`vault reachable: ${reachable.ok ? 'yes' : 'NO'}`);

  const root = repoToplevel(cwd);
  if (!root) {
    log.info('repo: not inside a git repository');
    return;
  }
  const marker = readMarker(root);
  if (!marker) {
    log.info('repo: not enabled (run css enable)');
    return;
  }
  log.info(`repo: ${marker.slug} (${marker.dirName})${marker.dirty ? ' — DIRTY, last push failed' : ''}`);
  log.info(`last push: ${marker.lastPush ?? 'never'}   last pull: ${marker.lastPull ?? 'never'}`);

  const rows = collectRows(buildCtx(root, cfg));
  const count = (s: Row['state']): number => rows.filter((r) => r.state === s).length;
  log.info(
    `sessions: ${rows.length} total — ${count('synced')} synced, ${count('unsynced')} unsynced, ` +
      `${count('ahead')} ahead, ${count('behind')} behind, ${count('remote')} remote-only, ${count('diverged')} diverged`,
  );
}

// ---------------------------------------------------------------- doctor

export async function cmdDoctor(cwd: string, opts: { verify?: string }): Promise<void> {
  let failed = false;
  const check = (name: string, ok: boolean, detail?: string): void => {
    if (!ok) failed = true;
    log.info(`${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node >= 20', nodeMajor >= 20, `v${process.versions.node}`);
  check('git available', git(['--version'], { allowFail: true }).ok);

  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  check('claude CLI', claude.status === 0, (claude.stdout ?? '').trim() || 'not found');

  const cfg = loadConfig();
  check('config present', cfg !== null, cfg ? configSummary(cfg) : 'run css init');
  if (cfg) {
    check('vault reachable', git(['ls-remote', '--heads', cfg.vaultUrl], { allowFail: true, timeoutMs: 15_000 }).ok);
  }

  const root = repoToplevel(cwd);
  if (root) check('repo enabled', readMarker(root) !== null, 'run css enable');

  if (opts.verify) {
    if (!root) throw new CssError('--verify must run inside the repo');
    const adapters = detectAdapters();
    const claudeActive = adapters.find((a) => a.adapter.id === 'claude');
    if (!claudeActive) throw new CssError('claude adapter not active');
    log.info(`verifying resume of ${opts.verify.slice(0, 8)} (spawns claude, may take a minute)…`);
    const ok = await claudeActive.adapter.verifyResume(opts.verify, root);
    check('resume verification', ok);
  }

  if (failed) process.exitCode = 1;
}

function configSummary(cfg: CssConfig): string {
  return `${cfg.vaultUrl} @ ${cfg.vaultPath}`;
}
