// Oqool Agent — the terminal face · واجهة الطرفية: the wordmark at start, then one coloured line per operation.
// Colours only on a real terminal (and never with NO_COLOR); the background service writes plain lines to its log.
const on = () => process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const rgb = (r, g, b) => (s) => (on() ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s);
const brgb = (r, g, b) => (s) => (on() ? `\x1b[1;38;2;${r};${g};${b}m${s}\x1b[0m` : s); // bold
const sgr = (code) => (s) => (on() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: sgr('2'), bold: sgr('1'),
  teal: rgb(45, 212, 191), violet: rgb(167, 139, 250), amber: rgb(251, 191, 36),
  blue: rgb(96, 165, 250), rose: rgb(251, 113, 133), gray: rgb(148, 163, 184), green: rgb(74, 222, 128), run: brgb(34, 230, 110),
};

// the identity card at start, the same face as Oqool in the terminal · بطاقة الهوية عند البدء، بنفس وجه عقول في الطرفية:
// "ANSI Shadow" letters in a teal → blue → violet gradient, inside a rounded frame, then the facts and the keys
const WORD = [
  ' ██████╗  ██████╗  ██████╗  ██████╗ ██╗     ',
  '██╔═══██╗██╔═══██╗██╔═══██╗██╔═══██╗██║     ',
  '██║   ██║██║   ██║██║   ██║██║   ██║██║     ',
  '██║   ██║██║▄▄ ██║██║   ██║██║   ██║██║     ',
  '╚██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝███████╗',
  ' ╚═════╝  ╚══▀▀═╝  ╚═════╝  ╚═════╝ ╚══════╝',
];
const STOPS = [[0x5f, 0xd7, 0xd7], [0x8e, 0xac, 0xff], [0xa3, 0x9b, 0xff]];
const gradientAt = (k) => {
  const seg = k < 0.5 ? 0 : 1; const u = seg === 0 ? k / 0.5 : (k - 0.5) / 0.5;
  return STOPS[seg].map((v, i) => Math.round(v + (STOPS[seg + 1][i] - v) * u));
};
const frame = rgb(0xa8, 0xa8, 0xa8);
const soft = rgb(0xa8, 0xa8, 0xa8);
const accent = rgb(0x5f, 0xd7, 0xd7);
const visible = (x) => Array.from(x.replace(/\x1b\[[0-9;]*m/g, '')).length;

/** info: { version, account, scope, connector } */
export function banner(info) {
  const i = typeof info === 'string' ? { version: info } : info;
  const cols = Math.max(48, Math.min(process.stdout.columns || 80, 72));
  const W = cols - 6; // │ + 2 spaces + content + 2 spaces + │
  const wordW = Array.from(WORD[0]).length;
  const word = WORD.map((row) => {
    const ch = Array.from(row);
    if (!on()) return row;
    let o = '';
    for (let x = 0; x < ch.length; x++) { const [r, g, b] = gradientAt(x / (wordW - 1)); o += ch[x] === ' ' ? ' ' : `\x1b[38;2;${r};${g};${b}m${ch[x]}`; }
    return o + '\x1b[0m';
  });
  const pad = (x) => x + ' '.repeat(Math.max(0, W - visible(x)));
  const line = (x = '') => `${frame('│')}  ${pad(x)}  ${frame('│')}`;
  const ver = soft(`v${i.version}`);
  const out = [frame('╭' + '─'.repeat(cols - 2) + '╮'), line()];
  word.forEach((w, r) => {
    const last = r === word.length - 1;
    out.push(line(last ? w + ' '.repeat(Math.max(1, W - wordW - visible(ver))) + ver : w));
  });
  out.push(line(), line(soft('Your computer, for AI models  ·  no open port  ·  yours to stop')), line(), line(soft('─'.repeat(W))), line());
  const row = (k, v) => line(`${soft(k.padEnd(12))}${v ?? ''}`);
  if (i.account) out.push(row('account', i.account));
  out.push(row('computer', i.scope || 'the whole computer'));
  if (i.connector) out.push(row('connector', i.connector));
  out.push(line(), line(`${accent('Ctrl+C')}${soft(' stop   ')}${accent('close window')}${soft(' disconnect')}`), line());
  out.push(frame('╰' + '─'.repeat(cols - 2) + '╯'));
  return '\n' + out.join('\n') + '\n';
}

// one glyph per kind of work (Desktop Commander uses ✓ and a green dot; ours are diamonds by colour)
const KIND = {
  read: ['read', c.blue], read_many: ['read', c.blue], list: ['list', c.blue], stat: ['info', c.blue], snapshot: ['sync', c.blue],
  'search.start': ['search', c.blue], 'search.more': ['search', c.blue], 'search.stop': ['search', c.gray], 'search.list': ['search', c.gray],
  write: ['write', c.amber], 'pdf.write': ['pdf', c.amber], edit: ['edit', c.amber], mkdir: ['mkdir', c.amber], move: ['move', c.amber], delete: ['delete', c.amber],
  exec: ['run', c.run], kill: ['stop', c.run], 'session.start': ['start', c.run], 'session.input': ['type', c.run],
  'session.read': ['output', c.run], 'session.list': ['sessions', c.gray], 'session.stop': ['stop', c.run],
  ps: ['processes', c.gray], 'ps.kill': ['kill', c.rose], 'config.get': ['settings', c.gray], 'config.set': ['settings', c.amber],
  log: ['log', c.gray], stats: ['stats', c.gray], shutdown: ['shutdown', c.rose], info: ['hello', c.gray],
};
const time = () => new Date().toTimeString().slice(0, 8);
const what = (m) => String(m.cmd ?? m.path ?? m.pattern ?? (m.from ? `${m.from} → ${m.to}` : '') ?? (m.paths ? m.paths.join(', ') : '') ?? m.key ?? m.session_id ?? m.pid ?? '').replace(/\s+/g, ' ').slice(0, 90);
const ms = (n) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

/** «▸ run  npm test» when a command starts (long work shows that it began). */
export function started(m) {
  const [label, col] = KIND[m.op] || [m.op, c.gray];
  return `${c.dim(time())} ${col('▸')} ${col(label.padEnd(9))} ${what(m)}`;
}
/** «◆ read  src/main.js  4ms» when it is done; «✕ … reason» when it failed. */
export function finished(m, r, took) {
  const [label, col] = KIND[m.op] || [m.op, c.gray];
  const failed = r && (r.ok === false || r.error || (r.op === 'exit' && r.code !== 0 && r.code !== undefined));
  const tail = r?.op === 'exit' ? `exit ${r.code ?? r.signal ?? '?'}` : '';
  const glyph = failed ? c.rose('✕') : col('◆');
  const note = failed && (r.error || '') ? c.rose(String(r.error).slice(0, 80)) : '';
  return `${c.dim(time())} ${glyph} ${col(label.padEnd(9))} ${what(m)}  ${c.dim([tail, ms(took)].filter(Boolean).join(' · '))}${note ? '  ' + note : ''}`;
}
export const status = {
  connecting: () => `${c.dim(time())} ${c.amber('◌')} ${c.gray('connecting to Oqool…')}`,
  online: (scope) => `${c.dim(time())} ${c.teal('◉')} ${c.bold('online')} ${c.gray('—')} ${scope}`,
  lost: () => `${c.dim(time())} ${c.amber('◌')} ${c.gray('connection lost, reconnecting…')}`,
};
