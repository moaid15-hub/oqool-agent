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

// the name at start, big · الاسم كبيراً عند البدء: OQOOL in block letters, teal → blue
const WORD = [
  ' ██████   ██████   ██████   ██████  ██     ',
  '██    ██ ██    ██ ██    ██ ██    ██ ██     ',
  '██    ██ ██ ▄▄ ██ ██    ██ ██    ██ ██     ',
  ' ██████   ██████   ██████   ██████  ██████ ',
  '             ▀▀                            ',
];
export function banner(version) {
  const from = [45, 212, 191], to = [96, 165, 250];
  const rows = WORD.map((row) => {
    if (!on()) return row;
    let o = '';
    for (let i = 0; i < row.length; i++) {
      const k = i / (row.length - 1);
      const [r, g, b] = from.map((v, j) => Math.round(v + (to[j] - v) * k));
      o += row[i] === ' ' ? ' ' : `\x1b[1;38;2;${r};${g};${b}m${row[i]}`;
    }
    return o + '\x1b[0m';
  });
  return ['', ...rows.map((r) => '  ' + r), `  ${c.blue('Agent')} ${c.dim(version)}`, ''].join('\n');
}

// one glyph per kind of work (Desktop Commander uses ✓ and a green dot; ours are diamonds by colour)
const KIND = {
  read: ['read', c.blue], read_many: ['read', c.blue], list: ['list', c.blue], stat: ['info', c.blue], snapshot: ['sync', c.blue],
  'search.start': ['search', c.blue], 'search.more': ['search', c.blue], 'search.stop': ['search', c.gray], 'search.list': ['search', c.gray],
  write: ['write', c.amber], edit: ['edit', c.amber], mkdir: ['mkdir', c.amber], move: ['move', c.amber], delete: ['delete', c.amber],
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
