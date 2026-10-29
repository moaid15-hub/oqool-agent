// Oqool Agent — document readers (PDF text, Excel sheets).
// قارئات المستندات: نص PDF وأوراق Excel.
// Copyright (c) 2026 Oqool. All rights reserved.

import { unzipSync, strFromU8 } from 'fflate';

const MAX_CELLS = 200000;

// ── PDF: text per page ──
export async function readPdf(buf, { offset = 0, length = 0 } = {}) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  const first = Math.min(Math.max(0, Number(offset) || 0), totalPages);
  const count = Number(length) > 0 ? Number(length) : totalPages;
  const pages = text.slice(first, first + count);
  const body = pages.map((t, i) => `--- page ${first + i + 1} ---\n${String(t).trim()}`).join('\n\n');
  return { kind: 'pdf', text: body, total_pages: totalPages, from_page: first + 1, to_page: first + pages.length };
}

// ── XLSX: a small, dependency-light reader ──
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? unxml(m[1]) : null; };
const texts = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

export function colNum(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
export function colName(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
function parseRef(ref) { const m = /^([A-Z]+)(\d+)$/i.exec(ref || ''); return m ? { c: colNum(m[1]), r: Number(m[2]) } : null; }
function parseRange(range) {
  if (!range) return null;
  const [a, b] = String(range).split(':');
  const s = parseRef(a); const e = parseRef(b || a);
  if (!s || !e) throw new Error('bad_range');
  return { r1: Math.min(s.r, e.r), r2: Math.max(s.r, e.r), c1: Math.min(s.c, e.c), c2: Math.max(s.c, e.c) };
}

function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export function readXlsx(buf, { sheet, range } = {}) {
  let files;
  try { files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith('xl/') && f.name.endsWith('.xml') || f.name.endsWith('.rels') }); }
  catch { throw new Error('not_a_valid_xlsx'); }
  const get = (n) => (files[n] ? strFromU8(files[n]) : null);
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('not_a_valid_xlsx');
  const rels = {};
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) rels[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    let t = rels[attr(m[0], 'r:id')] || '';
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    return { name: attr(m[0], 'name'), file: t };
  });
  if (!sheets.length) throw new Error('no_sheets');
  const shared = [...(get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));

  let pick = sheets[0];
  if (sheet != null && sheet !== '') {
    pick = /^\d+$/.test(String(sheet)) ? sheets[Number(sheet)] : sheets.find((s) => s.name === String(sheet));
    if (!pick) throw new Error(`no_such_sheet: ${sheet} (have: ${sheets.map((s) => s.name).join(', ')})`);
  }
  const xml = get(pick.file);
  if (!xml) throw new Error('sheet_missing');
  const want = parseRange(range);

  const rows = new Map();
  let maxC = 0; let maxR = 0; let cells = 0; let truncated = false;
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(attr(rm[1], 'r'));
    if (want && (r < want.r1 || r > want.r2)) continue;
    let col = 0;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = parseRef(attr(cm[1], 'r'));
      col = ref ? ref.c : col + 1;
      if (want && (col < want.c1 || col > want.c2)) continue;
      const inner = cm[2] || '';
      const t = attr(cm[1], 't');
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = null;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = texts(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) val = unxml(v);
      if (val == null || val === '') continue;
      if (++cells > MAX_CELLS) { truncated = true; break; }
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r).set(col, val);
      if (col > maxC) maxC = col; if (r > maxR) maxR = r;
    }
    if (truncated) break;
  }
  const r1 = want ? want.r1 : Math.min(...rows.keys(), maxR || 1);
  const c1 = want ? want.c1 : 1;
  const r2 = want ? Math.min(want.r2, maxR || want.r1) : maxR;
  const c2 = want ? Math.min(want.c2, maxC || want.c1) : maxC;
  const lines = [];
  for (let r = r1; r <= r2 && rows.size; r++) {
    const row = rows.get(r);
    const vals = [];
    for (let c = c1; c <= c2; c++) vals.push(csvCell(row?.get(c)));
    lines.push(vals.join(','));
  }
  const used = rows.size ? `${colName(c1)}${r1}:${colName(c2)}${r2}` : null;
  return { kind: 'xlsx', sheet: pick.name, sheets: sheets.map((s) => s.name), range: used, text: lines.join('\n'), rows: lines.length, truncated };
}
