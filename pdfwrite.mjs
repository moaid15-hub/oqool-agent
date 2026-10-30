// Oqool Agent — writing PDF files: markdown (with HTML, CSS, SVG, images) printed by the browser already on this computer
// (Edge, Chrome, Chromium, Brave), so Arabic, right-to-left and every font just work; pages added or removed with pdf-lib.
// كتابة PDF: الماركداون يطبعه المتصفح الموجود على الحاسبة (فتعمل العربية والاتجاه والخطوط)، وحذف/إدراج الصفحات بـ pdf-lib.
// Copyright (c) 2026 Oqool. All rights reserved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { PDFDocument } from 'pdf-lib';

function findBrowser() {
  if (process.env.OQOOL_AGENT_BROWSER && fs.existsSync(process.env.OQOOL_AGENT_BROWSER)) return process.env.OQOOL_AGENT_BROWSER;
  const list = [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) list.push(
      path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(r, 'Chromium', 'Application', 'chrome.exe'),
      path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    for (const a of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser']) {
      list.push(path.join('/Applications', a), path.join(os.homedir(), 'Applications', a));
    }
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const r = spawnSync('which', [n], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) list.push(r.stdout.trim());
    }
  }
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR = /[A-Za-z]/g;

/** Markdown (HTML allowed) → a full HTML page; the direction follows the text (Arabic → right to left). */
export function markdownToHtml(md, base) {
  const text = String(md ?? '');
  const rtl = (text.match(RTL) || []).length > (text.match(LTR) || []).length;
  // local images: an absolute path or one relative to the output folder becomes a file:// address
  const fixSrc = (src) => {
    if (/^(https?:|data:|file:)/i.test(src)) return src;
    const abs = path.isAbsolute(src) || /^[A-Za-z]:[\\/]/.test(src) ? src : path.join(base, src);
    return pathToFileURL(abs).href;
  };
  let body = marked.parse(text, { gfm: true, breaks: false, async: false });
  body = body.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (_, a, src, c) => a + fixSrc(src) + c);
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Segoe UI", "Noto Sans Arabic", "Noto Sans", Tahoma, Arial, sans-serif; font-size: 11.5pt; line-height: 1.65; color: #1a1a1a; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.1em 0 .45em; } h1 { font-size: 22pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
p, ul, ol, table, pre, blockquote { margin: 0 0 .8em; }
code { font-family: Consolas, "DejaVu Sans Mono", Menlo, monospace; font-size: .92em; background: #f2f2f2; padding: 1px 4px; border-radius: 3px; }
pre { background: #f5f5f5; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; direction: ltr; text-align: left; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: start; } th { background: #f0f0f0; }
blockquote { border-inline-start: 3px solid #ccc; padding-inline-start: 12px; color: #555; }
img, svg { max-width: 100%; }
</style></head><body>${body}</body></html>`;
}

/** Prints an HTML page to a PDF file with the browser in the background (its own empty profile, never the user's). */
export function printHtml(html, outFile, { timeoutMs = 60000 } = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('no_browser: writing a PDF needs Edge, Chrome, Chromium or Brave on this computer');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oqa-pdf-'));
  const page = path.join(work, 'page.html');
  const tmpOut = path.join(work, 'out.pdf');
  fs.writeFileSync(page, html);
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${path.join(work, 'profile')}`, '--allow-file-access-from-files', '--no-pdf-header-footer', '--print-to-pdf-no-header',
    `--print-to-pdf=${tmpOut}`, pathToFileURL(page).href];
  return new Promise((res, rej) => {
    const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); cleanup(); rej(e); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) throw new Error('pdf_not_written');
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.copyFileSync(tmpOut, outFile);
        res({ browser: path.basename(browser) });
      } catch (e) { rej(e); } finally { cleanup(); }
    });
    function cleanup() { setTimeout(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ } }, 500); }
  });
}

/**
 * write_pdf: content = markdown → a new PDF at out; content = [{type:'delete', pageIndexes}, {type:'insert', pageIndex, markdown | sourcePdfPath}]
 * → the PDF at src changed and saved at out (the original stays as it is).
 */
export async function writePdf({ src, out, content, resolve }) {
  if (typeof content === 'string') {
    const target = out || src;
    const r = await printHtml(markdownToHtml(content, path.dirname(target)), target);
    const pages = (await PDFDocument.load(fs.readFileSync(target))).getPageCount();
    return { path: target, pages, size: fs.statSync(target).size, made_with: r.browser };
  }
  if (!Array.isArray(content)) throw new Error('bad_content: a markdown string or a list of operations');
  if (!out || path.resolve(out) === path.resolve(src)) throw new Error('output_path_required: a changed PDF is saved under a new name');
  const doc = await PDFDocument.load(fs.readFileSync(src));
  const done = [];
  for (const op of content) {
    if (op?.type === 'delete') {
      const idx = [...new Set((op.pageIndexes || []).map(Number))].filter((i) => i >= 0 && i < doc.getPageCount()).sort((a, b) => b - a);
      for (const i of idx) doc.removePage(i);
      done.push(`deleted ${idx.length} page(s)`);
    } else if (op?.type === 'insert') {
      let from;
      if (op.sourcePdfPath) from = await PDFDocument.load(fs.readFileSync(resolve(op.sourcePdfPath)));
      else if (op.markdown != null) {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oqa-ins-')), 'ins.pdf');
        await printHtml(markdownToHtml(op.markdown, path.dirname(out)), tmp);
        from = await PDFDocument.load(fs.readFileSync(tmp));
        try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* */ }
      } else throw new Error('insert needs markdown or sourcePdfPath');
      const pages = await doc.copyPages(from, from.getPageIndices());
      let at = Math.max(0, Math.min(Number(op.pageIndex) || 0, doc.getPageCount()));
      for (const p of pages) doc.insertPage(at++, p);
      done.push(`inserted ${pages.length} page(s) at ${Number(op.pageIndex) || 0}`);
    } else throw new Error(`unknown operation: ${op?.type}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await doc.save());
  return { path: out, original: src, pages: doc.getPageCount(), size: fs.statSync(out).size, done };
}
