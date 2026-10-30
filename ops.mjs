// Oqool Agent — the operations beyond the first six · العمليات بعد الست الأولى.
// Each one answers what a Desktop Commander tool answers, with nothing repeated that the agent already had:
//   read · read_many · list · stat · mkdir · move · edit · write(append)        ← read_file … edit_block
//   search.start · search.more · search.stop · search.list                      ← start_search … list_searches
//   session.start · session.read · session.input · session.list · session.stop ← start_process … list_sessions
//   ps · ps.kill                                                                ← list_processes, kill_process
//   config.get · config.set                                                     ← get_config, set_config_value
//   log · stats                                                                 ← get_recent_tool_calls, get_usage_stats
//   shutdown                                                                    ← shutdown
// Every path must sit inside one of the allowed folders (roots). Every command (exec and session.start) is checked
// against the user's own block list (blockedCommands) — empty unless the user fills it · قائمة منع يملؤها المستخدم، فارغة افتراضياً.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { readPdf, readXlsx } from './docs.mjs';
import { writePdf } from './pdfwrite.mjs';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.oqool', '.oqool-agent', '__pycache__', '.venv', 'venv', 'target']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 50 * 1024 * 1024;
const DEFAULT_READ_LINES = 1000;
const SESSION_BUFFER_CHARS = 2_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);

// ───────────────────────── config: allowed folders + block list ─────────────────────────
export function loadConfig(home) {
  const file = path.join(home, 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* none yet */ }
  return {
    file,
    roots: Array.isArray(c.roots) ? c.roots.map(String) : [],
    blockedCommands: Array.isArray(c.blockedCommands) ? c.blockedCommands.map(String) : [],
    defaultShell: typeof c.defaultShell === 'string' ? c.defaultShell : '',
  };
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(cfg.file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfg.file, JSON.stringify({ roots: cfg.roots, blockedCommands: cfg.blockedCommands, defaultShell: cfg.defaultShell }, null, 2), { mode: 0o600 });
}

/** The first blocked command found in a shell line, or null. An entry with a space ("git push --force") matches as a
 *  prefix of a segment; a single word matches the program name of any segment (after `sudo`/env assignments). */
export function blockedIn(cmd, blocked) {
  if (!blocked?.length) return null;
  const list = blocked.map((b) => b.trim().toLowerCase()).filter(Boolean);
  for (let seg of String(cmd).split(/;|&&|\|\||\||\n|`|\$\(/)) {
    seg = seg.trim().replace(/^\(+/, '').trim();
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(seg)) seg = seg.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    seg = seg.replace(/^(sudo|doas|exec|nohup|time|command)\s+(-\S+\s+)*/i, '');
    const low = seg.toLowerCase();
    const prog = path.basename(low.split(/\s+/)[0] || '').replace(/\.(exe|cmd|bat|com)$/, '');
    for (const b of list) {
      if (b.includes(' ') ? low.startsWith(b) : prog === b) return b;
    }
  }
  return null;
}

// ───────────────────────── the operations ─────────────────────────
export function createOps({ roots, home, onExit, logLine }) {
  const cfg = loadConfig(home);
  // the folders given on the command line come first; the config adds more
  const allowed = () => [...new Set([...roots, ...cfg.roots].map((r) => { try { return fs.realpathSync(path.resolve(expandHome(r))); } catch { return null; } }).filter(Boolean))];
  // no folder anywhere = the whole machine · بلا مجلدات = الحاسبة كلها،
  // as Desktop Commander does; the user narrows it with config roots and blocks commands with blockedCommands
  const whole = () => allowed().length === 0;
  // a folder that is a drive or filesystem root («/», «C:\\») contains everything under it
  const under = (abs, r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep);

  /** An absolute path; inside one of the allowed folders when the user set any (relative paths start at the first
   *  folder, or at the user's home folder on the whole machine). */
  function resolve(p) {
    const list = allowed();
    const raw = expandHome(String(p ?? '.'));
    let abs = path.resolve(list[0] || os.homedir(), raw);
    try { abs = fs.realpathSync(abs); } catch { try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* new path */ } }
    if (list.length && !list.some((r) => under(abs, r))) throw new Error(`outside_allowed_folders: ${abs}`);
    return abs;
  }
  const checkCmd = (cmd) => { const b = blockedIn(cmd, cfg.blockedCommands); if (b) throw new Error(`blocked_command: ${b}`); };

  // ── log + stats (~/.oqool-agent/log.jsonl) ──
  const logFile = path.join(home, 'log.jsonl');
  const stats = { started: Date.now(), byOp: {} };
  function record(op, args, ok, ms, error) {
    const s = (stats.byOp[op] ||= { calls: 0, failed: 0, ms: 0 });
    s.calls++; s.ms += ms; if (!ok) s.failed++;
    const line = { t: new Date().toISOString(), op, ok, ms, ...(args ? { args } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}) };
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.appendFileSync(logFile, JSON.stringify(line) + '\n', { mode: 0o600 });
      if (fs.statSync(logFile).size > 2_000_000) {
        const keep = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-2000);
        fs.writeFileSync(logFile, keep.join('\n') + '\n');
      }
    } catch { /* the log never stops the work */ }
    logLine?.(line);
  }

  // ── files ──
  async function readOne(p, offset = 0, length = DEFAULT_READ_LINES, opts = {}) {
    const abs = resolve(p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error('is_a_directory');
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.pdf' || ext === '.xlsx' || ext === '.xlsm') {
      if (st.size > MAX_DOC_BYTES) throw new Error(`file_too_large: ${st.size} bytes (max ${MAX_DOC_BYTES})`);
      const buf = fs.readFileSync(abs);
      // for a PDF, offset/length count pages (length 0 = all)
      const r = ext === '.pdf'
        ? await readPdf(buf, { offset, length: opts.pages ? length : 0 })
        : readXlsx(buf, { sheet: opts.sheet, range: opts.range });
      return { path: abs, size: st.size, ...r };
    }
    if (IMAGE_MIME[ext]) {
      if (st.size > MAX_IMAGE_BYTES) throw new Error('image_too_large');
      return { path: abs, kind: 'image', mime: IMAGE_MIME[ext], b64: fs.readFileSync(abs).toString('base64'), size: st.size };
    }
    if (st.size > MAX_READ_BYTES) {
      // big text: stream only the asked lines would need a reader; keep it simple and honest
      throw new Error(`file_too_large: ${st.size} bytes (max ${MAX_READ_BYTES})`);
    }
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return { path: abs, kind: 'binary', size: st.size };
    const lines = buf.toString('utf8').split('\n');
    const total = lines.length;
    // a negative offset reads the end, like `tail` (as DC does)
    const from = offset < 0 ? Math.max(0, total + Number(offset)) : Math.min(Number(offset) || 0, total);
    const n = Math.max(0, Number(length) || DEFAULT_READ_LINES);
    const slice = lines.slice(from, from + n);
    return { path: abs, kind: 'text', text: slice.join('\n'), from, to: from + slice.length, total_lines: total, size: st.size };
  }

  function list(p, depth = 2) {
    const base = resolve(p);
    const items = [];
    const walk = (dir, d) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { items.push({ path: path.relative(base, dir) || '.', error: String(e.code || e.message) }); return; }
      ents.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of ents) {
        if (items.length >= 5000) return;
        const abs = path.join(dir, e.name);
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (e.isDirectory()) {
          items.push({ path: rel + '/', type: 'dir' });
          if (d > 1 && !SKIP_DIRS.has(e.name)) walk(abs, d - 1);
        } else {
          let size = null; try { size = fs.statSync(abs).size; } catch { /* gone */ }
          items.push({ path: rel, type: e.isSymbolicLink() ? 'link' : 'file', size });
        }
      }
    };
    walk(base, Math.max(1, Math.min(Number(depth) || 2, 10)));
    return { base, items, truncated: items.length >= 5000 };
  }

  function stat(p) {
    const abs = resolve(p);
    const st = fs.statSync(abs);
    const info = { path: abs, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, created: st.birthtime.toISOString(), modified: st.mtime.toISOString(), accessed: st.atime.toISOString(), mode: (st.mode & 0o777).toString(8) };
    if (st.isFile() && st.size <= MAX_READ_BYTES) {
      const buf = fs.readFileSync(abs);
      if (!buf.subarray(0, 8192).includes(0)) { info.lines = buf.toString('utf8').split('\n').length; info.text = true; } else info.text = false;
    }
    return info;
  }

  function edit(p, oldStr, newStr, count = 1) {
    const abs = resolve(p);
    const text = fs.readFileSync(abs, 'utf8');
    if (!oldStr) throw new Error('old_string_empty');
    const found = text.split(oldStr).length - 1;
    const want = Number(count) || 1;
    if (found !== want) {
      // say where the closest text is, so the caller can fix its old_string (DC does the same with a fuzzy hint)
      const first = oldStr.split('\n')[0].trim();
      const near = first ? text.split('\n').findIndex((l) => l.includes(first.slice(0, 40))) : -1;
      throw new Error(`expected ${want} occurrence(s), found ${found}${near >= 0 ? `; first line of old_string looks like line ${near + 1}` : ''}`);
    }
    fs.writeFileSync(abs, text.split(oldStr).join(String(newStr ?? '')));
    return { path: abs, replaced: found };
  }

  // ── search: runs in the background, read page by page ──
  const searches = new Map();
  let searchSeq = 0;
  function searchStart(m) {
    const base = resolve(m.path || '.');
    const id = `s${++searchSeq}`;
    const kind = m.kind === 'files' ? 'files' : 'content';
    const max = Math.min(Number(m.max_results) || 500, 10000);
    const flags = m.ignore_case === false ? '' : 'i';
    const re = new RegExp(m.literal ? String(m.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(m.pattern), flags);
    const fileRe = m.file_pattern ? new RegExp('^' + String(m.file_pattern).split(/[,|]/).map((g) => g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('$|^') + '$', 'i') : null;
    const ctx = Math.min(Number(m.context_lines) || 0, 10);
    const s = { id, base, pattern: String(m.pattern), kind, results: [], done: false, stopped: false, started: Date.now(), files: 0 };
    searches.set(id, s);
    const stack = [base];
    const step = () => {
      const until = Date.now() + 30;
      while (stack.length && !s.stopped && s.results.length < max && Date.now() < until) {
        const dir = stack.pop();
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (!m.include_hidden && e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory() || kind === 'files') continue; }
          const abs = path.join(dir, e.name);
          const rel = path.relative(base, abs).split(path.sep).join('/');
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); if (kind === 'files' && re.test(e.name)) s.results.push({ path: rel + '/' }); continue; }
          if (!e.isFile()) continue;
          if (fileRe && !fileRe.test(e.name)) continue;
          if (kind === 'files') { if (re.test(e.name)) s.results.push({ path: rel }); continue; }
          s.files++;
          let buf; try { const st = fs.statSync(abs); if (st.size > 2_000_000) continue; buf = fs.readFileSync(abs); } catch { continue; }
          if (buf.subarray(0, 8192).includes(0)) continue;
          const lines = buf.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && s.results.length < max; i++) {
            if (re.test(lines[i])) s.results.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400), ...(ctx ? { before: lines.slice(Math.max(0, i - ctx), i), after: lines.slice(i + 1, i + 1 + ctx) } : {}) });
          }
        }
      }
      if (!stack.length || s.stopped || s.results.length >= max) { s.done = true; s.ended = Date.now(); } else setImmediate(step);
    };
    setImmediate(step);
    return s;
  }
  const searchView = (s, offset = 0, length = 100) => ({ search_id: s.id, done: s.done, total: s.results.length, offset, results: s.results.slice(offset, offset + length), ...(s.done ? { ms: (s.ended || Date.now()) - s.started } : {}) });

  // ── long-lived sessions (REPL, ssh, dev servers) ──
  const sessions = new Map();
  let sessionSeq = 0;
  function shellFor(cmd) {
    if (process.platform === 'win32') {
      const sh = cfg.defaultShell || 'cmd.exe';
      return /powershell|pwsh/i.test(sh) ? [sh, ['-NoLogo', '-NoProfile', '-Command', cmd]] : [sh, ['/d', '/s', '/c', `"${cmd}"`]];
    }
    return [cfg.defaultShell || 'bash', ['-lc', cmd]];
  }
  /** Waits until output has been quiet for `idle` ms after something arrived, the process ended, or `timeout`. */
  async function settle(s, from, timeout = 3000, idle = 600) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (s.exited) return;
      if (s.out.length > from && Date.now() - s.lastOut >= idle) return;
      await sleep(50);
    }
  }
  async function sessionStart(m) {
    checkCmd(m.cmd);
    const cwd = resolve(m.cwd || '.');
    const [bin, args] = shellFor(String(m.cmd));
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: process.platform === 'win32' && !/powershell|pwsh/i.test(bin) });
    const id = `p${++sessionSeq}`;
    const s = { id, pid: child.pid, cmd: String(m.cmd), cwd, child, out: '', read: 0, started: Date.now(), lastOut: 0, exited: false, code: null };
    const add = (b) => { s.out += b.toString('utf8'); s.lastOut = Date.now(); if (s.out.length > SESSION_BUFFER_CHARS) { const cut = s.out.length - SESSION_BUFFER_CHARS; s.out = s.out.slice(cut); s.read = Math.max(0, s.read - cut); } };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', (e) => { add(Buffer.from(`\n[error] ${e.message}\n`)); s.exited = true; });
    child.on('close', (code, signal) => { s.exited = true; s.code = code; s.signal = signal; s.ended = Date.now(); });
    sessions.set(id, s);
    await settle(s, 0, Number(m.timeout_ms) || 3000);
    const text = s.out.slice(0); s.read = s.out.length;
    return { session_id: id, pid: s.pid, running: !s.exited, exit_code: s.exited ? s.code : null, output: text };
  }
  async function sessionRead(m) {
    const s = sessions.get(m.session_id); if (!s) throw new Error('no_such_session');
    if (m.offset !== undefined) {
      // explicit window over the whole kept output, in lines (negative = from the end), like DC's paged read
      const lines = s.out.split('\n'); const total = lines.length;
      const from = m.offset < 0 ? Math.max(0, total + Number(m.offset)) : Math.min(Number(m.offset), total);
      const n = Number(m.length) || 1000;
      return { session_id: s.id, running: !s.exited, exit_code: s.exited ? s.code : null, from, total_lines: total, output: lines.slice(from, from + n).join('\n') };
    }
    const start = s.read;
    await settle(s, start, Number(m.timeout_ms) || 1000, 300);
    const text = s.out.slice(start); s.read = s.out.length;
    return { session_id: s.id, running: !s.exited, exit_code: s.exited ? s.code : null, output: text };
  }
  async function sessionInput(m) {
    const s = sessions.get(m.session_id); if (!s) throw new Error('no_such_session');
    if (s.exited) throw new Error('session_ended');
    const start = s.out.length;
    s.child.stdin.write(String(m.input ?? '') + (m.newline === false ? '' : '\n'));
    await settle(s, start, Number(m.timeout_ms) || 3000, 400);
    const text = s.out.slice(start); s.read = s.out.length;
    return { session_id: s.id, running: !s.exited, exit_code: s.exited ? s.code : null, output: text };
  }
  function killTree(pid) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
      return true;
    } catch { return false; }
  }

  // ── system processes ──
  function ps() {
    return new Promise((res, rej) => {
      if (process.platform === 'win32') {
        execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 << 20 }, (e, stdout) => {
          if (e) return rej(e);
          const rows = stdout.trim().split(/\r?\n/).map((l) => l.replace(/^"|"$/g, '').split('","')).map((c) => ({ name: c[0], pid: Number(c[1]), mem_kb: Number(String(c[4] || '').replace(/[^\d]/g, '')) || null }));
          res(rows.slice(0, 1000));
        });
      } else {
        const args = process.platform === 'darwin' ? ['-axo', 'pid=,ppid=,pcpu=,pmem=,comm='] : ['-eo', 'pid=,ppid=,pcpu=,pmem=,comm=', '--sort=-pcpu'];
        execFile('ps', args, { maxBuffer: 8 << 20 }, (e, stdout) => {
          if (e) return rej(e);
          const rows = stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, cpu, mem, ...name]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), mem: Number(mem), name: name.join(' ') }));
          if (process.platform === 'darwin') rows.sort((a, b) => b.cpu - a.cpu);
          res(rows.slice(0, 1000));
        });
      }
    });
  }

  // ── the dispatcher: returns the reply object, or throws ──
  async function run(m) {
    switch (m.op) {
      case 'read': return readOne(m.path, m.offset, m.length, { sheet: m.sheet, range: m.range, pages: m.length != null });
      case 'read_many': return { files: await Promise.all((m.paths || []).slice(0, 50).map(async (p) => { try { return await readOne(p, 0, m.length || DEFAULT_READ_LINES); } catch (e) { return { path: p, error: String(e.message || e) }; } })) };
      case 'pdf.write': return writePdf({ src: resolve(m.path), out: m.output_path ? resolve(m.output_path) : null, content: m.content, resolve });
      case 'list': return list(m.path || '.', m.depth);
      case 'stat': return stat(m.path);
      case 'mkdir': { const abs = resolve(m.path); fs.mkdirSync(abs, { recursive: true }); return { path: abs }; }
      case 'move': { const from = resolve(m.from); const to = resolve(m.to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); return { from, to }; }
      case 'edit': return edit(m.path, m.old, m.new, m.count);
      case 'search.start': { const s = searchStart(m); await sleep(Math.min(Number(m.wait_ms) || 300, 5000)); return searchView(s, 0, Number(m.length) || 100); }
      case 'search.more': { const s = searches.get(m.search_id); if (!s) throw new Error('no_such_search'); if (!s.done && m.wait_ms) await sleep(Math.min(Number(m.wait_ms), 5000)); return searchView(s, Number(m.offset) || 0, Number(m.length) || 100); }
      case 'search.stop': { const s = searches.get(m.search_id); if (!s) throw new Error('no_such_search'); s.stopped = true; searches.delete(m.search_id); return { search_id: m.search_id, stopped: true, total: s.results.length }; }
      case 'search.list': return { searches: [...searches.values()].map((s) => ({ search_id: s.id, pattern: s.pattern, kind: s.kind, base: s.base, done: s.done, results: s.results.length, ms: (s.ended || Date.now()) - s.started })) };
      case 'session.start': return sessionStart(m);
      case 'session.read': return sessionRead(m);
      case 'session.input': return sessionInput(m);
      case 'session.list': return { sessions: [...sessions.values()].map((s) => ({ session_id: s.id, pid: s.pid, cmd: s.cmd.slice(0, 200), cwd: s.cwd, running: !s.exited, exit_code: s.exited ? s.code : null, seconds: Math.round(((s.ended || Date.now()) - s.started) / 1000), unread: s.out.length - s.read })) };
      case 'session.stop': { const s = sessions.get(m.session_id); if (!s) throw new Error('no_such_session'); const ok = s.exited || killTree(s.pid); await sleep(200); return { session_id: s.id, stopped: ok, output: s.out.slice(s.read) }; }
      case 'ps': return { processes: await ps() };
      case 'ps.kill': { const pid = Number(m.pid); if (!pid || pid === process.pid) throw new Error('bad_pid'); process.kill(pid, m.signal || 'SIGTERM'); return { pid, sent: m.signal || 'SIGTERM' }; }
      case 'config.get': return { roots: whole() ? ['(whole machine)'] : allowed(), whole_machine: whole(), configured_roots: cfg.roots, blockedCommands: cfg.blockedCommands, defaultShell: cfg.defaultShell || (process.platform === 'win32' ? 'cmd.exe' : 'bash'), file: cfg.file, platform: process.platform, version: m.version };
      case 'config.set': {
        const k = String(m.key);
        let v = m.value;
        if (typeof v === 'string' && /^\s*\[/.test(v)) { try { v = JSON.parse(v); } catch { /* keep the string */ } }
        if (k === 'roots' || k === 'allowedDirectories') {
          const arr = (Array.isArray(v) ? v : [v]).map((x) => path.resolve(expandHome(String(x))));
          for (const d of arr) if (!fs.statSync(d).isDirectory()) throw new Error(`not_a_directory: ${d}`);
          cfg.roots = arr;
        } else if (k === 'blockedCommands') cfg.blockedCommands = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
        else if (k === 'defaultShell') cfg.defaultShell = String(v || '');
        else throw new Error(`unknown_key: ${k} (roots, blockedCommands, defaultShell)`);
        saveConfig(cfg);
        return { key: k, value: k === 'roots' || k === 'allowedDirectories' ? cfg.roots : cfg[k] };
      }
      case 'log': {
        let lines = []; try { lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
        let rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (m.op_filter) rows = rows.filter((r) => r.op === m.op_filter);
        if (m.since) rows = rows.filter((r) => r.t >= m.since);
        return { calls: rows.slice(-Math.min(Number(m.limit) || 50, 1000)) };
      }
      case 'stats': return { since: new Date(stats.started).toISOString(), uptime_s: Math.round((Date.now() - stats.started) / 1000), by_op: stats.byOp, sessions: sessions.size, searches: searches.size };
      case 'shutdown': setTimeout(() => onExit?.(), 300); return { stopping: true };
      default: return undefined;
    }
  }

  /** Short arguments for the log: paths and commands, never file contents. */
  const logArgs = (m) => { const a = {}; for (const k of ['path', 'from', 'to', 'cmd', 'pattern', 'session_id', 'search_id', 'pid', 'key']) if (m[k] !== undefined) a[k] = String(m[k]).slice(0, 200); return Object.keys(a).length ? a : undefined; };

  return {
    resolve, checkCmd, record, logArgs, allowed, whole, killTree,
    has: (op) => /^(read|read_many|list|stat|mkdir|move|edit|search\.(start|more|stop|list)|session\.(start|read|input|list|stop)|pdf\.write|ps|ps\.kill|config\.(get|set)|log|stats|shutdown)$/.test(op),
    async handle(m) {
      const t0 = Date.now();
      try {
        const r = await run(m);
        record(m.op, logArgs(m), true, Date.now() - t0);
        return { ok: true, ...r };
      } catch (e) {
        record(m.op, logArgs(m), false, Date.now() - t0, e?.message || e);
        return { ok: false, error: String(e?.message || e) };
      }
    },
    stopAll() { for (const s of sessions.values()) if (!s.exited) killTree(s.pid); },
    busy() { return [...sessions.values()].some((s) => !s.exited) || searches.size > 0 && [...searches.values()].some((x) => !x.done); },
  };
}
