// Every operation through the real program (`agent.mjs --stdio`, or a built binary via AGENT_BIN): one JSON op per
// line in, the reply out. Runs in a temporary folder with its own agent home. node test/ops.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oqa-test-')));
const root = path.join(tmp, 'proj'); const other = path.join(tmp, 'other'); const outside = path.join(tmp, 'outside');
for (const d of [root, other, outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/main.js'), 'function add(a, b) {\n  return a - b;\n}\n// TODO fix\n');
fs.writeFileSync(path.join(root, 'src/deep/x.py'), 'print("TODO here")\n');
fs.writeFileSync(path.join(root, 'img.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');

// AGENT_BIN = a compiled program; AGENT_SCRIPT = the Node script (oqool-agent.mjs) built for Windows
const bin = process.env.AGENT_BIN;
const script = process.env.AGENT_SCRIPT;
const env = { ...process.env, OQOOL_AGENT_HOME: path.join(tmp, 'home'), OQOOL_AGENT_NO_UPDATE: '1' };
const child = bin
  ? spawn(bin, ['--stdio', root], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(process.execPath, [script || path.join(here, '..', 'agent.mjs'), '--stdio', root], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiting = new Map(); let seq = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.op === 'out' || m.op === 'file') continue; const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const op = (o) => new Promise((res) => { const id = ++seq; waiting.set(id, res); child.stdin.write(JSON.stringify({ id, ...o }) + '\n'); });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };

const info = await op({ op: 'info' });
check('info lists 29 ops', info.ops?.length === 29, JSON.stringify(info.ops?.length));
let r = await op({ op: 'read', path: 'a.txt', offset: 1, length: 2 });
check('read window', r.ok && r.text === 'two\nthree' && r.total_lines === 6, JSON.stringify(r));
r = await op({ op: 'read', path: 'a.txt', offset: -3 });
check('read tail', r.ok && r.text.startsWith('four'), JSON.stringify(r));
r = await op({ op: 'read', path: 'img.png' });
check('read image', r.ok && r.kind === 'image' && r.mime === 'image/png', JSON.stringify(r).slice(0, 120));
r = await op({ op: 'read_many', paths: ['a.txt', 'src/main.js', 'missing.txt'] });
check('read_many', r.ok && r.files.length === 3 && !!r.files[2].error, JSON.stringify(r).slice(0, 200));
r = await op({ op: 'read', path: path.join(outside, 'secret.txt') });
check('outside refused', !r.ok && /outside_allowed_folders/.test(r.error), JSON.stringify(r));
r = await op({ op: 'read', path: '../outside/secret.txt' });
check('.. escape refused', !r.ok && /outside_allowed_folders/.test(r.error), JSON.stringify(r));
r = await op({ op: 'list', path: '.', depth: 3 });
check('list depth', r.ok && r.items.some((x) => x.path === 'src/deep/x.py'), JSON.stringify(r).slice(0, 200));
r = await op({ op: 'stat', path: 'a.txt' });
check('stat', r.ok && r.type === 'file' && r.lines === 6 && r.size === 24, JSON.stringify(r));
r = await op({ op: 'mkdir', path: 'new/deeper' });
check('mkdir', r.ok && fs.statSync(path.join(root, 'new/deeper')).isDirectory(), JSON.stringify(r));
r = await op({ op: 'move', from: 'a.txt', to: 'new/b.txt' });
check('move', r.ok && fs.existsSync(path.join(root, 'new/b.txt')) && !fs.existsSync(path.join(root, 'a.txt')), JSON.stringify(r));
r = await op({ op: 'edit', path: 'src/main.js', old: 'return a - b;', new: 'return a + b;' });
check('edit', r.ok && fs.readFileSync(path.join(root, 'src/main.js'), 'utf8').includes('a + b'), JSON.stringify(r));
r = await op({ op: 'edit', path: 'src/main.js', old: 'not there', new: 'x' });
check('edit miss explains', !r.ok && /found 0/.test(r.error), JSON.stringify(r));
await op({ op: 'write', path: 'log.txt', b64: Buffer.from('a\n').toString('base64') });
r = await op({ op: 'write', path: 'log.txt', b64: Buffer.from('b\n').toString('base64'), append: true });
check('write append', r.ok && fs.readFileSync(path.join(root, 'log.txt'), 'utf8') === 'a\nb\n', JSON.stringify(r));
r = await op({ op: 'search.start', path: '.', pattern: 'TODO', kind: 'content', wait_ms: 500 });
check('search content', r.ok && r.done && r.total === 2, JSON.stringify(r).slice(0, 300));
const sid = r.search_id;
r = await op({ op: 'search.more', search_id: sid, offset: 1, length: 5 });
check('search page', r.ok && r.results.length === 1, JSON.stringify(r).slice(0, 200));
r = await op({ op: 'search.list' });
check('search list', r.ok && r.searches.length === 1, JSON.stringify(r).slice(0, 200));
r = await op({ op: 'search.stop', search_id: sid });
check('search stop', r.ok && r.stopped, JSON.stringify(r));
r = await op({ op: 'search.start', path: '.', pattern: '\\.py$', kind: 'files', wait_ms: 300 });
check('search files', r.ok && r.total === 1 && r.results[0].path === 'src/deep/x.py', JSON.stringify(r).slice(0, 200));
// sessions: a live python REPL
r = await op({ op: 'session.start', cmd: 'python3 -i -q', timeout_ms: 2500 });
const pid = r.session_id;
check('session start', r.ok && r.running, JSON.stringify(r));
await op({ op: 'session.input', session_id: pid, input: 'x = 21*2', timeout_ms: 1500 });
r = await op({ op: 'session.input', session_id: pid, input: 'print(x)', timeout_ms: 2000 });
check('session input → 42', r.ok && /42/.test(r.output), JSON.stringify(r));
r = await op({ op: 'session.list' });
check('session list', r.ok && r.sessions.some((s) => s.session_id === pid && s.running), JSON.stringify(r).slice(0, 200));
r = await op({ op: 'session.stop', session_id: pid });
check('session stop', r.ok && r.stopped, JSON.stringify(r));
r = await op({ op: 'session.start', cmd: 'for i in 1 2 3; do echo line$i; sleep 0.3; done', timeout_ms: 300 });
const p2 = r.session_id;
await sleep(1500);
r = await op({ op: 'session.read', session_id: p2, timeout_ms: 500 });
check('session read later', r.ok && /line3/.test(r.output) && !r.running && r.exit_code === 0, JSON.stringify(r));
r = await op({ op: 'session.read', session_id: p2, offset: 0, length: 2 });
check('session read window', r.ok && r.output.startsWith('line1'), JSON.stringify(r));
// processes
r = await op({ op: 'ps' });
check('ps', r.ok && r.processes.length > 5 && r.processes.every((p) => p.pid > 0), String(r.processes?.length));
const sleeper = spawn('sleep', ['30']);
const gone = new Promise((res) => sleeper.on('exit', (code, sig) => res(sig)));
r = await op({ op: 'ps.kill', pid: sleeper.pid });
check('ps.kill', r.ok && (await Promise.race([gone, sleep(2000).then(() => 'timeout')])) === 'SIGTERM', JSON.stringify(r));
// config + block list
r = await op({ op: 'config.get' });
check('config.get', r.ok && r.roots.length === 1 && Array.isArray(r.blockedCommands) && r.blockedCommands.length === 0, JSON.stringify(r));
r = await op({ op: 'config.set', key: 'blockedCommands', value: ['rm', 'git push --force', 'shutdown'] });
check('config.set blocked', r.ok && r.value.length === 3, JSON.stringify(r));
r = await op({ op: 'exec', cmd: 'echo hi && rm -rf new' });
check('exec blocked rm', r.op === 'exit' && /blocked_command: rm/.test(r.error || '') && fs.existsSync(path.join(root, 'new')), JSON.stringify(r));
r = await op({ op: 'exec', cmd: 'sudo /bin/rm x' });
check('exec blocked sudo /bin/rm', /blocked_command: rm/.test(r.error || ''), JSON.stringify(r));
r = await op({ op: 'exec', cmd: 'git push --force origin main' });
check('exec blocked git push --force', /blocked_command: git push --force/.test(r.error || ''), JSON.stringify(r));
r = await op({ op: 'session.start', cmd: 'FOO=1 shutdown -h now' });
check('session blocked', !r.ok && /blocked_command: shutdown/.test(r.error), JSON.stringify(r));
r = await op({ op: 'exec', cmd: 'echo allowed; echo done' });
check('exec allowed', r.op === 'exit' && r.code === 0 && !r.error, JSON.stringify(r).slice(0, 200));
await op({ op: 'config.set', key: 'roots', value: [other] });
r = await op({ op: 'write', path: path.join(other, 'w.txt'), b64: Buffer.from('ok').toString('base64') });
check('second root via config', r.ok && fs.existsSync(path.join(other, 'w.txt')), JSON.stringify(r));
r = await op({ op: 'config.set', key: 'nope', value: 1 });
check('config unknown key', !r.ok, JSON.stringify(r));
// log + stats
r = await op({ op: 'log', limit: 100 });
check('log', r.ok && r.calls.length > 20 && r.calls.some((c) => c.op === 'exec' && c.ok === false), String(r.calls?.length));
r = await op({ op: 'stats' });
check('stats', r.ok && r.by_op.read?.calls >= 4, JSON.stringify(r).slice(0, 200));
r = await op({ op: 'nope' });
check('unknown op', !r.ok && r.error === 'unknown_op', JSON.stringify(r));
r = await op({ op: 'shutdown' });
check('shutdown', r.ok && r.stopping, JSON.stringify(r));
const exited = await new Promise((res) => { const t = setTimeout(() => res(false), 3000); child.on('exit', () => { clearTimeout(t); res(true); }); });
check('process exited after shutdown', exited);
// the whole computer (no folder) and a filesystem root as the folder · الحاسبة كلها، والجذر «/» كمجلد
const env2 = { ...env, OQOOL_AGENT_HOME: path.join(tmp, 'home2') }; // a fresh home: the settings above narrowed the first one
for (const args of [[], ['/']]) {
  const c = bin ? spawn(bin, ['--stdio', ...args], { env: env2, stdio: ['pipe', 'pipe', 'inherit'] }) : spawn(process.execPath, [script || path.join(here, '..', 'agent.mjs'), '--stdio', ...args], { env: env2, stdio: ['pipe', 'pipe', 'inherit'] });
  const outp = await new Promise((res) => { let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => res(o)); c.stdin.end(JSON.stringify({ id: 1, op: 'read', path: path.join(outside, 'secret.txt') }) + '\n'); });
  const m = JSON.parse(outp.trim().split('\n')[0] || '{}');
  check(`whole computer ${args.length ? 'as /' : 'by default'}`, m.ok && m.text === 'no', outp.slice(0, 160));
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
