import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAdapters } from './adapters/registry.js';
import { CssError, isPrefixOf, log, normalizeEol, nowIso, sha256hex } from './engine/common.js';
import { defaultVaultPath, deviceName, loadConfig, saveConfig, type CssConfig } from './engine/config.js';
import { git, gitCommonDir, originUrl, repoToplevel } from './engine/git.js';
import { pruneVault } from './engine/gc.js';
import { forkSessionAt, listRemovedSessions, restoreSession } from './engine/history.js';
import { appendIgnore, loadIgnorePatterns, makeIgnoreFn, IGNORE_FILE } from './engine/ignore.js';
import { duplicateSession, mergeSession, summarizeMerge } from './engine/merge.js';
import { absoluteCssInvocation, customHooksPath, hookStatus, installHooks, uninstallHooks } from './engine/hooks.js';
import { findByName, resolveSessionInput, uniquifyName, validateName } from './engine/naming.js';
import { repoKeyFromOrigin } from './engine/repoKey.js';
import { rmSession } from './engine/rm.js';
import { describeFindings, scanSecrets } from './engine/secrets.js';
import { pullSessions, pushSessions, type SyncCtx } from './engine/sync.js';
import { Vault, readTranscript, type ProjectEntry, type SessionEntry } from './engine/vault.js';

interface Marker {
  dirName: string;
  slug: string;
  origin: string;
  enabledAt: string;
  lastPush?: string;
  lastPull?: string;
  /** Last background push attempt (Stop-hook debounce cooldown). */
  lastAttemptAt?: string;
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
  if (!cfg) throw new CssError('chat is not set up on this machine', 'run: chat setup   (one-time; creates your private vault)');
  return cfg;
}

/** Read-only view of this repo's vault namespace (local clone, no network). */
function loadProject(cfg: CssConfig, marker: Marker): ProjectEntry | undefined {
  const vault = new Vault(cfg);
  vault.ensureCloned();
  return vault.loadIndex().projects[marker.dirName];
}

/** Accepts a name, full id, or unique id prefix anywhere a session is expected. */
function resolveTarget(cfg: CssConfig, marker: Marker, input: string): string {
  return resolveSessionInput(loadProject(cfg, marker), input);
}

function entryById(project: ProjectEntry, sessionId: string): SessionEntry | undefined {
  for (const tool of Object.values(project.tools)) {
    const e = tool.sessions[sessionId];
    if (e) return e;
  }
  return undefined;
}

function requireRepo(cwd: string): string {
  const root = repoToplevel(cwd);
  if (!root) throw new CssError('not inside a git repository');
  return root;
}

function requireEnabled(repoRoot: string): Marker {
  const marker = readMarker(repoRoot);
  if (!marker) throw new CssError('this repo is not enabled for session sync', 'run: chat init  (in this repo)');
  return marker;
}

function buildCtx(repoRoot: string, cfg: CssConfig): SyncCtx {
  const adapters = detectAdapters();
  if (adapters.length === 0) log.warn('no supported agent tools detected on this machine');
  return { repoRoot, cfg, home: homedir(), adapters, ignore: makeIgnoreFn(loadIgnorePatterns(repoRoot)) };
}

function gh(args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 });
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() };
}

// ---------------------------------------------------------------- init

export function cmdSetup(opts: { url?: string; path?: string }): void {
  let url = opts.url;
  if (!url) {
    // No URL given: reuse the standard vault repo if it exists (second+
    // machine), otherwise create it. Never proceed with a public one.
    if (!gh(['--version']).ok) {
      throw new CssError('no vault URL given and gh is not installed', 'run: chat setup --url <private-git-url>');
    }
    const login = gh(['api', 'user', '-q', '.login']);
    if (!login.ok || !login.stdout) throw new CssError('gh is not authenticated', 'gh auth login, or pass --url');
    const name = 'claude-sessions-vault';
    const slug = `${login.stdout}/${name}`;
    const view = gh(['repo', 'view', slug, '--json', 'visibility', '-q', '.visibility']);
    if (view.ok) {
      if (view.stdout.toUpperCase() !== 'PRIVATE') {
        throw new CssError(`${slug} exists but is ${view.stdout} — refusing`, 'make it private first, or pass --url');
      }
      log.info(`reusing existing private vault repo ${slug}`);
    } else {
      const create = gh(['repo', 'create', slug, '--private']);
      if (!create.ok) {
        throw new CssError(`could not create ${slug}`, 'create a private repo yourself and pass --url');
      }
      log.info(`created private vault repo ${slug}`);
    }
    // Follow gh's configured git protocol — https users often have no SSH keys.
    const proto = gh(['config', 'get', '-h', 'github.com', 'git_protocol']);
    url = proto.ok && proto.stdout.trim() === 'ssh' ? `git@github.com:${slug}.git` : `https://github.com/${slug}.git`;
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
  log.info('next: run "chat init" inside a repo you want synced');
}

// ---------------------------------------------------------------- enable

function resolveBinCmd(): string {
  for (const bin of ['chat', 'css']) {
    const which = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return bin;
  }
  return absoluteCssInvocation();
}

function installGitHooks(root: string): void {
  const custom = customHooksPath(root);
  if (custom) {
    log.warn(`core.hooksPath is set (${custom}) — git hooks not installed`);
    log.warn('add "chat push -q" / "chat pull -q" to your hook pipeline manually');
    return;
  }
  for (const r of installHooks(root, resolveBinCmd())) {
    log.info(`hook ${r.name}: ${r.action}${r.note ? ` (${r.note})` : ''}`);
  }
}

export function cmdInit(cwd: string, opts: { noHooks?: boolean } = {}): void {
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
  const marker: Marker = { dirName: key.dirName, slug: key.slug, origin: key.normalized, enabledAt: nowIso() };
  writeMarker(root, marker);
  log.info(`enabled: ${key.slug} -> vault namespace ${key.dirName}`);
  if (opts.noHooks) {
    log.info('hooks skipped (--no-hooks) — sync manually with chat push / chat pull');
  } else {
    installGitHooks(root);
    log.info('sessions now ride git push / git pull on this repo');
  }
  // First pull right away — a fresh clone should be resume-ready after enable.
  try {
    const res = pullSessions(buildCtx(root, cfg));
    marker.lastPull = nowIso();
    writeMarker(root, marker);
    if (res.installed + res.fastForwarded > 0) {
      log.info(`pulled ${res.installed + res.fastForwarded} session(s) from the vault`);
    }
  } catch {
    log.warn('initial pull skipped (vault unreachable) — run chat pull later');
  }
}

// ---------------------------------------------------------------- disable

export function cmdDisable(cwd: string): void {
  const root = requireRepo(cwd);
  for (const r of uninstallHooks(root)) {
    log.info(`hook ${r.name}: ${r.action}${r.note ? ` (${r.note})` : ''}`);
  }
  const p = markerPath(root);
  if (existsSync(p)) {
    rmSync(p);
    log.info('repo disabled — local sessions and vault data untouched');
  } else {
    log.info('repo was not enabled');
  }
}

// ---------------------------------------------------------------- hooks management

export function cmdHooks(cwd: string, action: string | undefined): void {
  const root = requireRepo(cwd);
  switch (action) {
    case 'install': {
      requireConfig();
      requireEnabled(root);
      installGitHooks(root);
      break;
    }
    case 'uninstall': {
      for (const r of uninstallHooks(root)) {
        log.info(`hook ${r.name}: ${r.action}${r.note ? ` (${r.note})` : ''}`);
      }
      break;
    }
    case 'status':
    case undefined: {
      const custom = customHooksPath(root);
      if (custom) log.info(`core.hooksPath = ${custom} (css does not manage hooks here)`);
      for (const s of hookStatus(root)) log.info(`hook ${s.name}: ${s.state}`);
      break;
    }
    default:
      throw new CssError(`unknown hooks action: ${action}`, 'use chat hooks install|uninstall|status');
  }
}

// ---------------------------------------------------------------- plugin-event hooks (css hook …)

/** Guards shared by every session-lifecycle hook: never throw, never block a
 *  session over sync problems — silently do nothing when not set up. */
function hookContext(cwd: string): { cfg: CssConfig; root: string; marker: Marker } | null {
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const root = repoToplevel(cwd);
    if (!root) return null;
    const marker = readMarker(root);
    if (!marker) return null;
    return { cfg, root, marker };
  } catch {
    return null;
  }
}

function spawnBackgroundPush(root: string): void {
  if (process.env.CSS_HOOK_FOREGROUND === '1') {
    try {
      pushSessions(buildCtx(root, requireConfig()));
      const m = readMarker(root);
      if (m) {
        m.lastPush = nowIso();
        m.dirty = false;
        writeMarker(root, m);
      }
    } catch {
      /* hooks never fail */
    }
    return;
  }
  const cli = process.argv[1];
  if (!cli) return;
  spawn(process.execPath, [cli, 'push', '-q'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
}

const DEFAULT_STOP_DEBOUNCE_MIN = 2;
const ATTEMPT_COOLDOWN_MS = 2 * 60 * 1000;

/** Claude Code hook payload arrives on stdin; tolerate manual invocations. */
function readHookStdin(): { session_id?: string; source?: string } {
  try {
    if (process.stdin.isTTY) return {};
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as { session_id?: string; source?: string }) : {};
  } catch {
    return {};
  }
}

export function cmdHook(cwd: string, kind: string | undefined): void {
  const ctx = hookContext(cwd);
  if (!ctx) return; // not initialized/enabled — stay invisible

  switch (kind) {
    case 'session-start': {
      // Pull before the session begins; surface a notice only when something arrived.
      const payload = readHookStdin();
      try {
        const res = pullSessions(buildCtx(ctx.root, ctx.cfg));
        ctx.marker.lastPull = nowIso();
        writeMarker(ctx.root, ctx.marker);

        const parts: string[] = [];
        // The dangerous case first: THIS session was resumed while another
        // device had pushed newer turns — the just-pulled file is ahead of
        // what Claude loaded into context.
        if (payload.session_id && res.updatedIds.includes(payload.session_id)) {
          parts.push(
            'repo-sessions WARNING: this session has newer turns from another device that were just pulled — the context you resumed is a stale snapshot. Tell the user to exit and resume again to include them (continuing here will fork the transcript; chat rebase can reconcile later).',
          );
        }
        const otherIds = [...res.installedIds, ...res.updatedIds].filter((id) => id !== payload.session_id);
        if (otherIds.length > 0) {
          const first = otherIds[0];
          const summary = first ? res.detail[first]?.summary : undefined;
          const label = summary ? `"${summary.slice(0, 40)}…" (${first?.slice(0, 8)})` : `${otherIds.length} session(s)`;
          parts.push(
            `repo-sessions: synced ${label}${otherIds.length > 1 ? ` and ${otherIds.length - 1} more` : ''} from other devices — /sessions list to browse, claude --resume <id> to continue one.`,
          );
        }
        if (parts.length > 0) {
          console.log(
            JSON.stringify({
              hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') },
            }),
          );
        }
      } catch {
        /* vault unreachable: session starts as if we did not exist (G5) */
      }
      return;
    }
    case 'session-end': {
      spawnBackgroundPush(ctx.root);
      return;
    }
    case 'stop': {
      // Fires after every response — must be near-free. Debounce on last
      // successful push; the attempt cooldown only bites while an attempt is
      // outstanding (vault down), so debounce 0 really means every response.
      const debounceMs = (ctx.cfg.stopDebounceMinutes ?? DEFAULT_STOP_DEBOUNCE_MIN) * 60 * 1000;
      const now = Date.now();
      const last = ctx.marker.lastPush ? Date.parse(ctx.marker.lastPush) : 0;
      const attempt = ctx.marker.lastAttemptAt ? Date.parse(ctx.marker.lastAttemptAt) : 0;
      const attemptPending = attempt > last && now - attempt < ATTEMPT_COOLDOWN_MS;
      if (now - last < debounceMs || attemptPending) return;
      ctx.marker.lastAttemptAt = nowIso();
      writeMarker(ctx.root, ctx.marker);
      spawnBackgroundPush(ctx.root);
      return;
    }
    default:
      throw new CssError(`unknown hook event: ${kind}`, 'use chat hook session-start|session-end|stop');
  }
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
        (res.memoryPushed ? `, ${res.memoryPushed} memory` : '') +
        (res.conflicts ? `, ${res.conflicts} CONFLICT` : '') +
        (changed || res.memoryPushed || res.conflicts ? ' — vault updated' : ''),
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
    const onlyId = opts.id ? resolveTarget(cfg, marker, opts.id) : undefined;
    const res = pullSessions(buildCtx(root, cfg), onlyId);
    marker.lastPull = nowIso();
    writeMarker(root, marker);
    log.info(
      `pull: ${res.installed} installed, ${res.fastForwarded} updated, ${res.upToDate} up-to-date` +
        (res.localAhead ? `, ${res.localAhead} local-ahead` : '') +
        (res.memoryInstalled ? `, ${res.memoryInstalled} memory` : '') +
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
  name?: string;
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
        rows.push({ sessionId, name: entry.name, tool: adapter.id, state: 'remote', device: entry.device, lastTs: entry.lastTs, summary: entry.summary, conflicts: entry.conflicts });
        continue;
      }
      const localTok = adapter.tokenize(readFileSync(local.filePath, 'utf8'), {
        projectRoot: ctx.repoRoot,
        home: ctx.home,
        toolDataDir: env.dataDir,
      }, { json: true });
      let state: Row['state'];
      if (sha256hex(localTok) === entry.sha256) state = 'synced';
      else {
        const remoteTok = readTranscript(join(vault.path, key.dirName, adapter.id, 'sessions', sessionId)) ?? '';
        state = isPrefixOf(remoteTok, localTok) ? 'ahead' : isPrefixOf(localTok, remoteTok) ? 'behind' : 'diverged';
      }
      rows.push({ sessionId, name: entry.name, tool: adapter.id, state, device: entry.device, lastTs: local.lastTs ?? entry.lastTs, summary: local.summary ?? entry.summary, conflicts: entry.conflicts });
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
  const nameWidth = Math.max(4, ...rows.map((r) => (r.name ?? '').length));
  for (const r of rows) {
    const age = r.lastTs ? r.lastTs.slice(0, 16).replace('T', ' ') : '                ';
    const flag = r.conflicts?.length ? ` [conflicts: ${r.conflicts.join(',')}]` : '';
    // Full id: it needs to be copy-pasteable into `claude --resume <id>`.
    log.info(
      `${(r.name ?? '').padEnd(nameWidth)}  ${r.sessionId}  ${r.tool.padEnd(6)}  ${r.state.padEnd(8)}  ${r.device.padEnd(12)}  ${age}  ${(r.summary ?? '').slice(0, 40)}${flag}`,
    );
  }
}

export function cmdStatus(cwd: string): void {
  const cfg = loadConfig();
  if (!cfg) {
    log.info('chat: not initialized (run chat init)');
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
    log.info('repo: not enabled (run chat enable)');
    return;
  }
  log.info(`repo: ${marker.slug} (${marker.dirName})${marker.dirty ? ' — DIRTY, last push failed' : ''}`);
  log.info(`last push: ${marker.lastPush ?? 'never'}   last pull: ${marker.lastPull ?? 'never'}`);

  const ctx = buildCtx(root, cfg);
  const rows = collectRows(ctx);
  const count = (s: Row['state']): number => rows.filter((r) => r.state === s).length;
  log.info(
    `sessions: ${rows.length} total — ${count('synced')} synced, ${count('unsynced')} unsynced, ` +
      `${count('ahead')} ahead, ${count('behind')} behind, ${count('remote')} remote-only, ${count('diverged')} diverged`,
  );
  const mem = collectMemoryRows(ctx, loadProject(cfg, marker));
  if (mem.length > 0) {
    const mcount = (s: MemoryRow['state']): number => mem.filter((r) => r.state === s).length;
    log.info(
      `memory: ${mem.length} file(s) — ${mcount('synced')} synced, ${mcount('unsynced')} unsynced, ` +
        `${mcount('ahead')} ahead, ${mcount('behind')} behind, ${mcount('remote-only')} remote-only`,
    );
  }
}

// ---------------------------------------------------------------- rebase / split / duplicate / name

export function cmdRebase(cwd: string, target: string | undefined): void {
  if (!target) throw new CssError('rebase needs a session', 'chat rebase <session-id|name>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const id = resolveTarget(cfg, marker, target);
  const res = mergeSession(buildCtx(root, cfg), id, { split: false });
  if (res.outcome) summarizeMerge(res.outcome, id);
  log.info('rebased transcript installed locally — resume with the same id; other devices converge on next pull');
}

/** Give derived names to freshly created sessions once they exist in the index. */
function nameNewSessions(
  cfg: CssConfig,
  marker: Marker,
  assignments: { sessionId: string; base: string }[],
  message: string,
): void {
  if (assignments.length === 0) return;
  const vault = new Vault(cfg);
  const index = vault.loadIndex();
  const project = index.projects[marker.dirName];
  if (!project) return;
  let named = 0;
  for (const a of assignments) {
    const entry = entryById(project, a.sessionId);
    if (entry && !entry.name) {
      entry.name = uniquifyName(project, a.base);
      log.info(`named: ${entry.name} (${a.sessionId.slice(0, 8)})`);
      named++;
    }
  }
  if (named > 0) {
    vault.saveIndex(index);
    vault.commitAndPush(message);
  }
}

export function cmdSplit(cwd: string, target: string | undefined): void {
  if (!target) throw new CssError('split needs a session', 'chat split <session-id|name>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const id = resolveTarget(cfg, marker, target);
  const ctx = buildCtx(root, cfg);
  const originalName = loadProject(cfg, marker) && entryById(loadProject(cfg, marker)!, id)?.name;

  const res = mergeSession(ctx, id, { split: true });
  for (const s of res.splits ?? []) log.info(`split ${s.device} -> new session ${s.newSessionId}`);
  if (res.localReset) log.info(`local ${id.slice(0, 8)} reset to the vault transcript (divergent turns live in the new session)`);

  pushSessions(ctx); // the new session files enter the vault immediately
  const base = originalName ?? id.slice(0, 8);
  nameNewSessions(
    cfg,
    marker,
    (res.splits ?? []).map((s) => ({ sessionId: s.newSessionId, base: `${base}/${s.device}` })),
    `name(${marker.slug}): derived split name(s) for ${id.slice(0, 8)}`,
  );
}

/** Deleted sessions have no index entry — fall back to matching against ids
 *  found in rm commits, so restore/fork --at still take prefixes. */
function resolveTargetOrHistorical(cfg: CssConfig, marker: Marker, input: string): string {
  try {
    return resolveTarget(cfg, marker, input);
  } catch (err) {
    if (/^[0-9a-f-]{6,}$/i.test(input)) {
      const removed = listRemovedSessions(new Vault(cfg)).filter((r) => r.id.startsWith(input.toLowerCase()));
      if (removed.length === 1 && removed[0]!.id.length === 36) return removed[0]!.id;
    }
    throw err;
  }
}

export function cmdFork(cwd: string, target: string | undefined, opts: { at?: string } = {}): void {
  if (!target) throw new CssError('fork needs a session', 'chat fork <session-id|name> [--at <vault-hash>]');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const ctx = buildCtx(root, cfg);
  const id = resolveTargetOrHistorical(cfg, marker, target);
  const originalName = loadProject(cfg, marker) && entryById(loadProject(cfg, marker)!, id)?.name;

  let newSessionId: string;
  if (opts.at !== undefined || !entryById(loadProject(cfg, marker) ?? { slug: '', origin: '', tools: {} }, id)) {
    // historical fork: from a past vault state (or the last state of a deleted session)
    const res = forkSessionAt(ctx, id, opts.at);
    newSessionId = res.newSessionId;
    log.info(`forked ${id.slice(0, 8)} @ ${res.hash.slice(0, 8)} -> ${newSessionId}`);
  } else {
    const res = duplicateSession(ctx, id);
    newSessionId = res.newSessionId;
    log.info(`forked ${id.slice(0, 8)} -> ${newSessionId}`);
  }
  pushSessions(ctx);
  if (originalName) {
    nameNewSessions(
      cfg,
      marker,
      [{ sessionId: newSessionId, base: `${originalName}-fork` }],
      `name(${marker.slug}): ${newSessionId.slice(0, 8)} named from ${originalName}`,
    );
  }
  log.info(`resume the fork: chat resume ${newSessionId}`);
}

// ---------------------------------------------------------------- open / restore

export function cmdOpen(cwd: string, target: string | undefined): void {
  if (!target) throw new CssError('open needs a session', 'chat open <session-id|name>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const id = resolveTarget(cfg, marker, target);
  const ctx = buildCtx(root, cfg);

  const find = (): string | undefined =>
    ctx.adapters.flatMap((a) => a.adapter.locate(root, a.env)).find((r) => r.sessionId === id)?.filePath;
  let filePath = find();
  if (!filePath) {
    log.info('session not local yet — pulling from the vault…');
    pullSessions(ctx, id);
    filePath = find();
  }
  if (!filePath) throw new CssError(`session ${id.slice(0, 8)} not found locally after pull`);

  log.info(filePath);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (editor) {
    spawnSync(editor, [filePath], { stdio: 'inherit' });
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [filePath], { stdio: 'ignore' });
  }
}

export function cmdRestore(cwd: string, target: string | undefined, opts: { at?: string }): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);

  if (!target) {
    // list deleted sessions still absent from the vault
    const vault = new Vault(cfg);
    vault.ensureCloned();
    const project = loadProject(cfg, marker);
    const removed = listRemovedSessions(vault).filter((r) => !(project && r.id.length === 36 && entryById(project, r.id)));
    if (removed.length === 0) {
      log.info('no deleted sessions found in vault history');
      return;
    }
    for (const r of removed) log.info(`${r.id}  ${r.when.replace('T', ' ')}  ${r.name ?? ''}`);
    log.info('restore one with: chat restore <id>');
    return;
  }

  const id = resolveTargetOrHistorical(cfg, marker, target);
  const res = restoreSession(buildCtx(root, cfg), id, { at: opts.at });
  log.info(`restored ${id.slice(0, 8)} (${res.toolId}) from vault commit ${res.hash.slice(0, 8)}`);
  if (res.installedAt) log.info(`installed locally — chat resume ${id.slice(0, 8)} to continue it`);
}

// ---------------------------------------------------------------- rm / resume / ignore

export function cmdRm(cwd: string, target: string | undefined, opts: { force: boolean }): void {
  if (!target) throw new CssError('rm needs a session', 'chat rm <session-id|name> [--force]');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const id = resolveTarget(cfg, marker, target);
  const res = rmSession(buildCtx(root, cfg), id, { force: opts.force });
  if (res.removedLocal > 0) log.info(`removed ${res.removedLocal} local transcript(s)`);
  if (res.removedVault) {
    log.info('removed from the vault (recoverable from vault git history)');
    log.info('note: other devices keep their local copies until they rm too');
  }
  log.info(`rm ${id.slice(0, 8)}${res.name ? ` (${res.name})` : ''} done`);
}

const NESTED_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
];

export function cmdResume(cwd: string, target: string | undefined): void {
  if (!target) throw new CssError('resume needs a session', 'chat resume <session-id|name>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const id = resolveTarget(cfg, marker, target);
  const ctx = buildCtx(root, cfg);

  const find = (): { tool: string; cwd: string } | undefined =>
    ctx.adapters
      .map((a) => ({ tool: a.adapter.id, ref: a.adapter.locate(root, a.env).find((r) => r.sessionId === id) }))
      .filter((x) => x.ref)
      .map((x) => ({ tool: x.tool, cwd: x.ref!.cwd }))[0];

  let owner = find();
  if (!owner) {
    log.info('session not local yet — pulling from the vault…');
    pullSessions(ctx, id);
    owner = find();
  }
  if (!owner) throw new CssError(`session ${id.slice(0, 8)} not found locally after pull`);

  const [bin, args] =
    owner.tool === 'claude' ? ['claude', ['--resume', id]] : ['codex', ['resume', id]] as const;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !NESTED_SESSION_ENV.includes(k)) env[k] = v;
  }
  log.info(`resuming ${id.slice(0, 8)} with ${bin}…`);
  const res = spawnSync(bin as string, args as string[], { cwd: owner.cwd, stdio: 'inherit', env });
  process.exitCode = res.status ?? 1;
}

export function cmdIgnore(cwd: string, target: string | undefined): void {
  if (!target) throw new CssError('ignore needs a session or pattern', 'chat ignore <session-id|name|glob>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  // Resolve to a concrete id when we can, so renames don't un-ignore it;
  // globs and unknown patterns go in verbatim.
  let entry = target;
  if (!target.includes('*')) {
    try {
      entry = resolveTarget(cfg, marker, target);
    } catch {
      throw new CssError(`"${target}" matches no session`, 'pass a session, a name, or a glob pattern');
    }
  }
  if (appendIgnore(root, entry)) {
    log.info(`added to ${IGNORE_FILE}: ${entry}`);
    log.info('this session will no longer sync in either direction on this machine');
    if (entry !== target) log.info(`(resolved "${target}" to its id so renaming cannot un-ignore it)`);
    log.warn(`already-synced copies stay in the vault — chat rm removes them`);
  } else {
    log.info(`already ignored: ${entry}`);
  }
}

export function cmdName(cwd: string, target: string | undefined, newName: string | undefined): void {
  if (!target || !newName) throw new CssError('usage: chat name <session-id|name> <new-name>');
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const vault = new Vault(cfg);
  vault.ensureCloned();
  vault.refresh();
  const index = vault.loadIndex();
  const project = index.projects[marker.dirName];
  if (!project) throw new CssError('vault has nothing for this repo yet', 'chat push first');
  const id = resolveSessionInput(project, target);
  const name = validateName(newName);
  const holder = findByName(project, name);
  if (holder && holder.sessionId !== id) {
    throw new CssError(`name "${name}" is already used by ${holder.sessionId.slice(0, 8)}`);
  }
  const entry = entryById(project, id);
  if (!entry) throw new CssError(`session ${id} not in the vault for this repo`, 'chat push first');
  entry.name = name;
  vault.saveIndex(index);
  vault.commitAndPush(`name(${marker.slug}): ${id.slice(0, 8)} -> ${name}`);
  log.info(`${id.slice(0, 8)} is now "${name}" (synced everywhere)`);
}

// ---------------------------------------------------------------- memory

interface MemoryRow {
  file: string;
  tool: string;
  state: 'synced' | 'ahead' | 'behind' | 'unsynced' | 'remote-only';
  device: string;
  mtimeMs: number;
}

function collectMemoryRows(ctx: SyncCtx, project: ProjectEntry | undefined): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const { adapter, env } of ctx.adapters) {
    if (!adapter.locateMemory) continue;
    const locals = new Map(adapter.locateMemory(ctx.repoRoot, env).map((r) => [r.fileName, r]));
    const mem = project?.tools[adapter.id]?.memory ?? {};
    const pathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: env.dataDir };
    for (const [file, entry] of Object.entries(mem)) {
      const local = locals.get(file);
      locals.delete(file);
      let state: MemoryRow['state'] = 'remote-only';
      if (local) {
        const tok = normalizeEol(adapter.tokenize(readFileSync(local.filePath, 'utf8'), pathCtx));
        state = sha256hex(tok) === entry.sha256 ? 'synced' : local.mtimeMs > entry.mtimeMs ? 'ahead' : 'behind';
      }
      rows.push({ file, tool: adapter.id, state, device: entry.device, mtimeMs: entry.mtimeMs });
    }
    for (const local of locals.values()) {
      rows.push({ file: local.fileName, tool: adapter.id, state: 'unsynced', device: ctx.cfg.device, mtimeMs: local.mtimeMs });
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

export function cmdMemory(cwd: string): void {
  const cfg = requireConfig();
  const root = requireRepo(cwd);
  const marker = requireEnabled(root);
  const rows = collectMemoryRows(buildCtx(root, cfg), loadProject(cfg, marker));
  if (rows.length === 0) {
    log.info('no project memory yet (memory syncs automatically with chat push / chat pull)');
    return;
  }
  const w = Math.max(4, ...rows.map((r) => r.file.length));
  for (const r of rows) {
    const when = new Date(r.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
    log.info(`${r.file.padEnd(w)}  ${r.tool.padEnd(6)}  ${r.state.padEnd(11)}  ${r.device.padEnd(12)}  ${when}`);
  }
}

// ---------------------------------------------------------------- gc

export function cmdGc(opts: { keep?: number; days?: number }): void {
  if (opts.keep === undefined && opts.days === undefined) {
    throw new CssError('gc needs a retention rule', 'chat gc --keep <n> and/or --days <n>');
  }
  const cfg = requireConfig();
  const vault = new Vault(cfg);
  vault.ensureCloned();
  vault.refresh();
  const res = pruneVault(vault, opts);
  if (res.pruned > 0) vault.commitAndPush(`gc: pruned ${res.pruned} session(s)`);
  log.info(`gc: pruned ${res.pruned}, kept ${res.kept}`);
}

// ---------------------------------------------------------------- doctor

export async function cmdDoctor(cwd: string, opts: { verify?: string }): Promise<void> {
  let failed = false;
  const check = (name: string, ok: boolean, detail?: string): void => {
    if (!ok) failed = true;
    log.info(`${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const note = (name: string, detail: string): void => {
    log.info(` --   ${name} — ${detail}`);
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node >= 20', nodeMajor >= 20, `v${process.versions.node}`);
  check('git available', git(['--version'], { allowFail: true }).ok);

  const adapters = detectAdapters();
  check('agent tools detected', adapters.length > 0, adapters.map((a) => a.adapter.id).join(', ') || 'none');
  for (const tool of ['claude', 'codex'] as const) {
    const res = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    note(`${tool} CLI`, res.status === 0 ? (res.stdout ?? '').trim() : 'not on PATH (sync still works; resume needs it)');
  }

  const cfg = loadConfig();
  check('config present', cfg !== null, cfg ? configSummary(cfg) : 'run chat init');
  if (cfg) {
    check('vault reachable', git(['ls-remote', '--heads', cfg.vaultUrl], { allowFail: true, timeoutMs: 15_000 }).ok);
  }

  const root = repoToplevel(cwd);
  if (root) check('repo enabled', readMarker(root) !== null, 'run chat enable');

  // Secret scan over this repo's local sessions (plan §4: warn before pushing).
  if (root && readMarker(root)) {
    let dirty = 0;
    for (const { adapter, env } of adapters) {
      for (const ref of adapter.locate(root, env)) {
        const findings = scanSecrets(readFileSync(ref.filePath, 'utf8'));
        if (findings.length > 0) {
          dirty++;
          log.warn(`session ${ref.sessionId.slice(0, 8)} (${adapter.id}): ${describeFindings(findings)}`);
        }
      }
    }
    note('secret scan', dirty === 0 ? 'clean' : `${dirty} session(s) with possible secrets — review before relying on vault privacy`);
  }

  if (opts.verify) {
    if (!root) throw new CssError('--verify must run inside the repo');
    const owner = detectAdapters()
      .map((a) => ({ a, ref: a.adapter.locate(root, a.env).find((r) => r.sessionId === opts.verify) }))
      .find((x) => x.ref);
    if (!owner) throw new CssError(`session ${opts.verify} not found locally`, 'css pull first?');
    log.info(`verifying ${owner.a.adapter.id} resume of ${opts.verify.slice(0, 8)} (spawns the tool, may take a minute)…`);
    const ok = await owner.a.adapter.verifyResume(opts.verify, root, owner.a.env);
    check('resume verification', ok);
  }

  if (failed) process.exitCode = 1;
}

function configSummary(cfg: CssConfig): string {
  return `${cfg.vaultUrl} @ ${cfg.vaultPath}`;
}
