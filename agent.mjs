#!/usr/bin/env node
// Oqool Agent — يربط نماذج الذكاء بحاسبة المستخدم · connects AI models to the user's computer.
// The small program on the user's machine. No engine, no model, no provider keys: a model (Oqool Cloud, Claude,
// ChatGPT, any MCP client through the Oqool relay) sends it exact operations; it does them on this computer and returns
// the result as it is. Outbound WebSocket only — no open port, no IP. The whole computer by default; the user narrows
// it with allowed folders and blocks commands with a block list.
// اتصال خارج فقط بلا منفذ مفتوح؛ الحاسبة كلها افتراضياً، والمستخدم يقيّدها بمجلدات مسموحة وقائمة منع.
// Node 22+ (global WebSocket and fetch), or the single-file program built from this file (no Node needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createOps, SKIP_DIRS } from './ops.mjs';
import { openBrowser, uninstallService, serviceStatus } from './service.mjs';
import * as ui from './ui.mjs';

const VERSION = '0.6.0';
// how the user started it: the installed program (`oqool-agent`) or the script (`node agent.mjs`)
// installed as one script run by Node (Windows: Smart App Control blocks unsigned programs; Node is signed) or as
// one compiled program (Linux, macOS) · سكربت يشغّله Node على Windows، أو برنامج واحد على Linux وmacOS
const SCRIPT = path.basename(process.argv[1] || '') === 'oqool-agent.mjs' ? fs.realpathSync(process.argv[1]) : null;
const BIN = SCRIPT || !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ? 'oqool-agent' : 'node agent.mjs';
/** How to start this same agent again (a service, a restart after an update). */
const SELF = SCRIPT ? [process.execPath, SCRIPT] : [process.execPath];
const T = {
  linkCode: 'Link code',
  open: 'Approve in your browser',
  opened: '(opened in your browser)',
  linked: '✓ This computer is linked to your Oqool account',
  expired: 'The code expired. Run {bin} login again.',
  notLinked: 'Not linked yet. Run: {bin} setup',
  help: `Oqool Agent {v} — connects AI models to your computer

  {bin} setup          link this computer, then run in this window (start here)
  {bin}                run in this window (the whole computer); close the window or Ctrl+C to disconnect
  {bin} [folders…]     run limited to those folders
  {bin} status         linked? running?
  {bin} login          link this computer to your Oqool account
  {bin} logout         forget the link
  {bin} uninstall      stop an agent left running by an older version (nothing starts by itself)
  {bin} update         update now (it also updates itself on every start)
  {bin} --version      version

No open port, no keys on this computer. Limit it with allowed folders and a block list (settings).`,
  online: '✓ Oqool Agent online',
  wholeMachine: 'the whole computer',
  stop: 'Stop at once: Ctrl+C',
  reconnect: '… disconnected, retrying',
  revoked: 'This computer was removed from the account. Run {bin} setup again.',
  replaced: 'Another Oqool Agent on this computer took over the connection; this one stops.',
  run: '▶ running',
  wrote: '✎ wrote',
  loggedOut: 'Link forgotten.',
  updating: '↻ updating Oqool Agent to',
  updated: '✓ updated to',
  upToDate: '✓ up to date',
  updateFailed: 'Could not update now; continuing with this version',
  setupNext: 'Add the connector in Claude or ChatGPT:',
  keepOpen: 'Keep this window open while you work. Closing it disconnects; run {bin} to connect again.',
  uninstalled: '✓ No Oqool Agent runs by itself on this computer.',
};
const t = (k) => T[k].replaceAll('{bin}', BIN).replaceAll('{v}', VERSION);
// in the background (--service) there is no terminal: every line goes to ~/.oqool-agent/agent.log with the time
// so a stopped background agent always leaves a reason · كي يترك الـ Agent الخلفي سبب توقفه دائماً
let LOG_FILE = null;
const out = (s) => {
  if (!LOG_FILE) { process.stdout.write(s + '\n'); return; }
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${s}\n`);
    if (fs.statSync(LOG_FILE).size > 1_000_000) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').slice(-500_000));
  } catch { /* the log never stops the agent */ }
};

const RELAY = (process.env.OQOOL_AGENT_RELAY || 'https://oqool-relay-cloud.moaid15.workers.dev').replace(/\/+$/, '');
const SITE = (process.env.OQOOL_AGENT_SITE || 'https://oqool-net-cloud.moaid15.workers.dev').replace(/\/+$/, '');
const HOME = process.env.OQOOL_AGENT_HOME || path.join(os.homedir(), '.oqool-agent');
const ACCOUNT = path.join(HOME, 'account.json');

// What is never sent to the cloud copy (SKIP_DIRS, from ops.mjs): dependencies, VCS and build output stay on the machine.
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;

function readAccount() { try { return JSON.parse(fs.readFileSync(ACCOUNT, 'utf8')); } catch { return null; } }

async function login() {
  const r = await fetch(`${RELAY}/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: os.hostname(), platform: `agent-${process.platform}-${process.arch}` }) });
  const { code, pollId, expiresIn } = await r.json();
  const link = `${SITE}/en/connect/?code=${code}`;
  out(`${t('linkCode')}: ${code}`);
  out(`${t('open')}: ${link}${openBrowser(link) ? `  ${t('opened')}` : ''}`);
  const until = Date.now() + (expiresIn || 600) * 1000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 2000));
    const p = await (await fetch(`${RELAY}/pair/poll?id=${encodeURIComponent(pollId)}`)).json().catch(() => ({}));
    if (p.status === 'approved') {
      fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
      fs.writeFileSync(ACCOUNT, JSON.stringify({ token: p.token, deviceId: p.deviceId, name: p.name, relay: RELAY, site: SITE, created: Date.now() }, null, 2), { mode: 0o600 });
      out(t('linked'));
      return 0;
    }
    if (p.status === 'expired') break;
  }
  out(t('expired'));
  return 1;
}

// ── self-update · تحديث ذاتي: the installed program only, at start, never mid-work · عند البدء فقط، لا أثناء العمل ──
// The newest release on GitHub is read from the /releases/latest redirect (no API rate limit); the file for this
// system is downloaded next to the program, checked against the release's SHA256SUMS, swapped in, and started again
// with the same arguments. Any failure leaves the current version running. OQOOL_AGENT_NO_UPDATE=1 turns it off.
const REPO = 'moaid15-hub/oqool-agent';
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const assetName = () => {
  if (SCRIPT) return 'oqool-agent.mjs';
  const os_ = process.platform === 'win32' ? 'windows' : process.platform;
  return `oqool-agent-${os_}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
};
async function latestVersion() {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const m = /\/tag\/v?([0-9]+\.[0-9]+\.[0-9]+)/.exec(r.headers.get('location') || '');
  return m ? m[1] : null;
}
async function selfUpdate(explicit = false) {
  if (BIN !== 'oqool-agent') return false; // the development script updates with git, not here
  const exe = SCRIPT || process.execPath;
  try { fs.rmSync(exe + '.old', { force: true }); } catch { /* still locked on Windows: next time */ }
  if (!explicit && process.env.OQOOL_AGENT_NO_UPDATE === '1') return false;
  try {
    const v = await latestVersion();
    if (!v || !newer(v, VERSION)) { if (explicit) out(`${t('upToDate')} (${VERSION})`); return false; }
    out(`${t('updating')} ${v} …`);
    const base = `https://github.com/${REPO}/releases/download/v${v}`;
    const name = assetName();
    const [bin, sums] = await Promise.all([
      fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300000) }).then((r) => { if (!r.ok) throw new Error(`download ${r.status}`); return r.arrayBuffer(); }),
      fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(15000) }).then((r) => { if (!r.ok) throw new Error(`sums ${r.status}`); return r.text(); }),
    ]);
    const buf = Buffer.from(bin);
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
    if (!want || crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('checksum');
    const tmp = exe + '.new';
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    if (SCRIPT) fs.renameSync(tmp, exe); // a script is not locked while Node runs it
    else if (process.platform === 'win32') { fs.renameSync(exe, exe + '.old'); fs.renameSync(tmp, exe); }
    else fs.renameSync(tmp, exe); // the running program keeps its old inode; the path now holds the new one
    out(`${t('updated')} ${v}`);
    return true;
  } catch (e) {
    out(`${t('updateFailed')} (${String(e?.message || e).slice(0, 80)})`);
    return false;
  }
}
const UPDATE_EVERY = Number(process.env.OQOOL_AGENT_UPDATE_EVERY_MS) || 10 * 60 * 1000;
const OPS = ['info', 'snapshot', 'write', 'delete', 'exec', 'kill', 'read', 'read_many', 'list', 'stat', 'mkdir', 'move', 'edit',
  'search.start', 'search.more', 'search.stop', 'search.list', 'session.start', 'session.read', 'session.input', 'session.list', 'session.stop',
  'pdf.write', 'ps', 'ps.kill', 'config.get', 'config.set', 'log', 'stats', 'shutdown'];

/** Starts the freshly installed program with the same arguments and leaves with its exit code. */
function restartSelf(argv = process.argv.slice(2)) {
  const env = { ...process.env, OQOOL_AGENT_FRESH: '1' }; // just updated: no check at its start (later checks still run)
  let child;
  // a parent without a console (a service, a remote shell) cannot hand its handles over on Windows: pipe them instead
  const args = [...SELF.slice(1), ...argv];
  try { child = spawn(SELF[0], args, { stdio: 'inherit', env }); }
  catch {
    child = spawn(SELF[0], args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  }
  process.on('SIGINT', () => { /* the child gets Ctrl+C itself */ });
  child.on('exit', (code) => process.exit(code ?? 0));
  return new Promise(() => {});
}

// ── the folder ──
function inside(root, rel) {
  const abs = path.resolve(root, String(rel || '.'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('outside_folder');
  return abs;
}
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function walk(root) {
  const files = new Map(); // rel -> abs
  const skipped = [];
  const stack = [root];
  while (stack.length && files.size < MAX_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      const rel = relOf(root, abs);
      if (st.size > MAX_FILE_BYTES) { skipped.push(rel); continue; }
      files.set(rel, abs);
    }
  }
  return { files, skipped };
}

async function serve(folders, stdio = false, quiet = false) {
  const acc = stdio ? { token: 'stdio' } : readAccount();
  if (!acc?.token) { out(t('notLinked')); return 1; }
  if (!stdio) {
    const pidFile = path.join(HOME, 'agent.pid');
    try { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(pidFile, String(process.pid)); } catch { /* */ }
    process.on('exit', () => { try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.rmSync(pidFile); } catch { /* */ } });
  }
  const roots = folders.map((f) => fs.realpathSync(path.resolve(f)));
  // the snapshot base for an Oqool Cloud copy: the first folder, or the home folder on the whole computer
  const root = roots[0] || os.homedir();
  let closing = false;
  const ops = createOps({ roots, home: HOME, onExit: () => { closing = true; ops.stopAll(); try { ws?.close(); } catch { /* */ } process.exit(0); } });
  const inside = (_root, rel) => ops.resolve(rel);
  const known = new Map(); // rel -> sha1 of what the cloud copy has
  const running = new Map(); // exec id -> child
  let ws = null;
  let backoff = 1000;

  const send = stdio
    ? (to, msg) => process.stdout.write(JSON.stringify(msg) + '\n')
    : (to, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'peer', to, msg })); };

  /** Files that differ from what the cloud copy has (after a command ran). */
  function changes() {
    const { files } = walk(root);
    const list = [];
    for (const [rel, abs] of files) {
      let buf; try { buf = fs.readFileSync(abs); } catch { continue; }
      const h = sha(buf);
      if (known.get(rel) !== h) { known.set(rel, h); list.push({ path: rel, b64: buf.toString('base64') }); }
    }
    for (const rel of [...known.keys()]) if (!files.has(rel)) { known.delete(rel); list.push({ path: rel, deleted: true }); }
    return list;
  }

  function kill(child) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch { /* ended */ } }
  }

  function onMessage(from, m) {
    if (!m || typeof m !== 'object') return;
    const t0 = Date.now();
    // one coloured line per operation on the terminal (not in the background log, not in the test mode)
    const show = !quiet && !stdio && m.op !== 'info';
    const reply = (x) => { if (show) out(ui.finished(m, x, Date.now() - t0)); send(from, { id: m.id, ...x }); };
    try {
      if (m.op === 'info') return reply({ ok: true, root, roots: ops.allowed(), platform: process.platform, arch: process.arch, shell: process.platform === 'win32' ? 'cmd' : 'bash', version: VERSION, ops: OPS });
      if (ops.has(m.op)) { ops.handle({ ...m, version: VERSION }).then((r) => reply(r)); return; }
      if (m.op === 'snapshot') {
        known.clear();
        const { files, skipped } = walk(root);
        let n = 0;
        for (const [rel, abs] of files) {
          let buf; try { buf = fs.readFileSync(abs); } catch { continue; }
          known.set(rel, sha(buf));
          send(from, { id: m.id, op: 'file', path: rel, b64: buf.toString('base64') });
          n++;
        }
        return reply({ op: 'done', ok: true, files: n, skipped });
      }
      if (m.op === 'write') {
        const abs = inside(root, m.path);
        const buf = Buffer.from(String(m.b64 || ''), 'base64');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (m.append) fs.appendFileSync(abs, buf); else fs.writeFileSync(abs, buf);
        if (!m.append) known.set(relOf(root, abs), sha(buf));
        ops.record('write', ops.logArgs(m), true, 0);
        return reply({ ok: true });
      }
      if (m.op === 'delete') {
        const abs = inside(root, m.path);
        try { fs.rmSync(abs, { force: true }); } catch { /* gone */ }
        ops.record('delete', ops.logArgs(m), true, 0);
        known.delete(relOf(root, abs));
        return reply({ ok: true });
      }
      if (m.op === 'exec') {
        const cwd = inside(root, m.cwd || '.');
        try { ops.checkCmd(m.cmd); } catch (e) { ops.record('exec', ops.logArgs(m), false, 0, e.message); return reply({ op: 'exit', code: null, error: e.message, changed: [] }); }
        ops.record('exec', ops.logArgs(m), true, 0);
        if (show) out(ui.started(m));
        const child = process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', `"${String(m.cmd)}"`], { cwd, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
          : spawn('bash', ['-lc', String(m.cmd)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        running.set(m.id, child);
        const pending = { stdout: '', stderr: '' };
        let flushTimer = null;
        const flush = () => {
          flushTimer = null;
          for (const s of ['stdout', 'stderr']) if (pending[s]) { send(from, { id: m.id, op: 'out', stream: s, data: pending[s] }); pending[s] = ''; }
        };
        const onData = (s) => (buf) => { pending[s] += buf.toString('utf8'); if (pending[s].length > 64 * 1024) flush(); else if (!flushTimer) flushTimer = setTimeout(flush, 100); };
        child.stdout.on('data', onData('stdout'));
        child.stderr.on('data', onData('stderr'));
        let timer = null;
        if (m.timeout_ms > 0) timer = setTimeout(() => kill(child), m.timeout_ms);
        let ended = false;
        child.on('error', (e) => { if (ended) return; ended = true; flush(); running.delete(m.id); reply({ op: 'exit', code: null, error: String(e.message || e), changed: [] }); });
        child.on('close', (code, signal) => {
          if (ended) return; ended = true;
          if (timer) clearTimeout(timer);
          flush();
          running.delete(m.id);
          // the changed files only matter to a cloud copy that took a snapshot (Oqool Cloud); an MCP call never wants them,
          // and in a big folder they would make the reply too large to arrive · في مجلد كبير يصير الرد أكبر من أن يصل
          reply({ op: 'exit', code, signal, changed: m.sync === false || known.size === 0 ? [] : changes() });
        });
        return;
      }
      if (m.op === 'kill') { const c = running.get(m.ref); if (c) kill(c); return reply({ ok: true }); }
      return reply({ ok: false, error: 'unknown_op' });
    } catch (e) {
      return reply({ ok: false, error: String(e?.message || e) });
    }
  }

  if (stdio) {
    // test mode: one JSON operation per line in, every reply as one JSON line out (no relay)
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onMessage('stdio', JSON.parse(l)); } catch (e) { send('stdio', { ok: false, error: 'bad_json' }); } } } });
    process.stdin.on('end', () => { setTimeout(() => { ops.stopAll(); process.exit(0); }, 1500); });
    return new Promise(() => {});
  }

  let firstOpen = true;
  let lastIn = Date.now();
  let beat = null;
  /** The socket went silent: drop it (its own close event is ignored) and connect again. */
  const stale = (s) => {
    if (s !== ws || closing) return;
    s.__stale = true;
    try { s.close(); } catch { /* already gone */ }
    out(quiet ? 'heartbeat lost, reconnecting' : ui.status.lost());
    setTimeout(connect, 1000);
  };
  if (!quiet) out(ui.banner({ version: VERSION, account: acc.name, scope: ops.whole() ? t('wholeMachine') : ops.allowed().join(', '), connector: `${acc.relay || RELAY}/mcp` }));
  const connect = () => {
    if (!quiet) out(ui.status.connecting());
    const sock = new WebSocket(`${acc.relay.replace(/^http/, 'ws')}/ws/agent?token=${encodeURIComponent(acc.token)}`);
    ws = sock;
    ws.addEventListener('open', () => {
      backoff = 1000;
      ws.send(JSON.stringify({ t: 'hello', cwd: root, version: VERSION, platform: process.platform }));
      if (!quiet) {
        out(ui.status.online(ops.whole() ? t('wholeMachine') : ops.allowed().join(', ')));
      } else out('online');
      firstOpen = false;
      // heartbeat: a connection can die without a close event (sleep, network change); no message for 90 s = reconnect
      lastIn = Date.now();
      clearInterval(beat);
      beat = setInterval(() => {
        if (Date.now() - lastIn > 90_000) { clearInterval(beat); stale(sock); return; }
        try { sock.send('{"t":"ping"}'); } catch { /* close follows */ }
      }, 30_000);
    });
    ws.addEventListener('message', (ev) => {
      lastIn = Date.now();
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'peer') onMessage(m.from, m.msg);
    });
    ws.addEventListener('close', (ev) => {
      if (closing || sock.__stale || sock !== ws) return;
      clearInterval(beat);
      if (ev.code === 4001) { out(t('revoked')); process.exit(2); }
      // another Oqool Agent on this computer connected with the same link (the newest wins): this one steps aside
      // instead of taking the connection back every second (exit 2 = the background service does not restart it)
      if (ev.code === 4000) { out(t('replaced')); ops.stopAll(); process.exit(2); }
      out(quiet ? 'disconnected, retrying' : ui.status.lost());
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
    ws.addEventListener('error', () => { /* close follows */ });
  };
  connect();
  // updates itself while it runs: a check every 10 minutes; a new version waits until no command or process is running,
  // then the same window continues with it · يحدّث نفسه وهو شغّال، وينتظر حتى لا يكون أمر قيد التنفيذ
  if (!stdio && BIN === 'oqool-agent' && process.env.OQOOL_AGENT_NO_UPDATE !== '1') {
    const tick = async () => {
      if (!(await selfUpdate())) return setTimeout(tick, UPDATE_EVERY);
      const swap = () => {
        if (running.size || ops.busy()) return setTimeout(swap, 5000);
        closing = true; ops.stopAll(); try { ws?.close(); } catch { /* */ }
        // «setup» continues as a plain run (setup would stop the agent that started it)
        const argv = process.argv.slice(2);
        restartSelf(argv[0] === 'setup' ? [] : argv);
      };
      swap();
    };
    setTimeout(tick, UPDATE_EVERY);
  }
  process.on('SIGINT', () => { closing = true; for (const c of running.values()) kill(c); ops.stopAll(); try { ws?.close(); } catch { /* closed */ } process.exit(0); });
  return new Promise(() => { /* serve until Ctrl+C */ });
}

// the start-with-computer entry of older versions, and an agent they left running in the background
function removeAutostart() { try { uninstallService({ keepRunning: true }); } catch { /* */ } }
function retireBackground() {
  try { uninstallService(); } catch { /* */ }
  try {
    const pid = Number(fs.readFileSync(path.join(HOME, 'agent.pid'), 'utf8'));
    if (pid && pid !== process.pid) process.kill(pid);
  } catch { /* none running */ }
}

const FRESH = process.env.OQOOL_AGENT_FRESH === '1';
delete process.env.OQOOL_AGENT_FRESH;
const cmd = process.argv[2];
if (cmd === '--version' || cmd === '-v' || cmd === 'version') out(VERSION);
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') out(t('help'));
else if (cmd === 'update') { await selfUpdate(true); }
else if (!['status', 'uninstall', 'logout'].includes(cmd) && !FRESH && (await selfUpdate())) await restartSelf();
else if (cmd === 'login') process.exit(await login());
else if (cmd === 'setup') {
  // link (once), then run here in this window — nothing starts by itself, closing the window disconnects
  // اربط مرة، ثم اشتغل في هذه النافذة — لا شيء يبدأ وحده، وغلق النافذة يقطع الاتصال
  if (!readAccount()?.token && (await login()) !== 0) process.exit(1);
  retireBackground();
  out(`${t('setupNext')} ${RELAY}/mcp`);
  out(t('keepOpen'));
  await serve([]);
}
else if (cmd === 'status') {
  const acc = readAccount();
  const st = serviceStatus(HOME);
  out(`Oqool Agent ${VERSION}\nlinked: ${acc?.token ? `yes (${acc.name})` : 'no'}\nrunning: ${st.running ? `yes (pid ${st.pid})` : 'no'}${st.installed ? '\nleft from an older version: a start-with-computer entry (remove: ' + BIN + ' uninstall)' : ''}\nconnector: ${RELAY}/mcp`);
}
else if (cmd === 'uninstall') { retireBackground(); out(t('uninstalled')); }
else if (cmd === '--service') {
  // started by an older version's start-with-computer entry: remove that entry and stop (nothing runs hidden)
  // أُطلق من مدخل تشغيل تلقائي قديم: احذف المدخل وتوقّف (لا شيء يعمل مخفياً)
  LOG_FILE = path.join(HOME, 'agent.log');
  out(`start ${VERSION} pid ${process.pid} (${process.platform}) — the start-with-computer entry is removed; run oqool-agent in a window`);
  removeAutostart();
  process.exit(2);
}
else if (cmd === 'logout') { try { fs.rmSync(ACCOUNT, { force: true }); } catch { /* none */ } out(t('loggedOut')); }
else if (cmd === '--stdio') await serve(process.argv.slice(3), true);
else await serve(process.argv.slice(2).filter((a) => !a.startsWith('-')));
