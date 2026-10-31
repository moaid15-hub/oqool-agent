// Oqool Agent — the screen, mouse and keyboard of this computer. Every use is gated by the user's consent in the
// agent window (agent.mjs asks); this file only does the work, with what the system already has:
//   Windows: PowerShell (user32 + System.Windows.Forms + System.Drawing) — nothing to install.
//   macOS:   screencapture + osascript (System Events; needs Accessibility permission once) + cliclick when present.
//   Linux:   xdotool / ydotool, gnome-screenshot / grim / spectacle / import / scrot — whichever is installed.
// الشاشة والفأرة ولوحة المفاتيح — كل استعمال مشروط بموافقة المستخدم في نافذة الـAgent.
// Copyright (c) 2026 Oqool. All rights reserved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 30000, windowsHide: true, ...opts }, (e, stdout, stderr) => (e ? rej(new Error((stderr || e.message || '').toString().trim().slice(0, 300) || 'failed')) : res(stdout)));
});
const has = (name) => { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }); return r.status === 0; };
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);

const BUTTON = { left: 'left', right: 'right', middle: 'middle' };
const btn = (b) => BUTTON[String(b || 'left').toLowerCase()] || 'left';

// ── screenshot: PNG as base64 (scaled down when the screen is huge: the model needs a picture, not every pixel) ──
export async function screenshot({ maxWidth = 1600 } = {}) {
  const file = path.join(os.tmpdir(), `oqa-shot-${process.pid}-${Date.now()}.png`);
  try {
    if (process.platform === 'win32') {
      await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
$w = $bmp.Width; $h = $bmp.Height; $max = ${maxWidth}
if ($w -gt $max) { $nh = [int]($h * $max / $w); $small = New-Object System.Drawing.Bitmap $bmp, $max, $nh; $bmp.Dispose(); $bmp = $small }
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Write-Output "$w $h"`);
    } else if (process.platform === 'darwin') {
      await run('screencapture', ['-x', '-t', 'png', file]);
    } else {
      if (has('gnome-screenshot')) await run('gnome-screenshot', ['-f', file]);
      else if (has('grim')) await run('grim', [file]);
      else if (has('spectacle')) await run('spectacle', ['-b', '-n', '-o', file]);
      else if (has('import')) await run('import', ['-window', 'root', file]);
      else if (has('scrot')) await run('scrot', [file]);
      else throw new Error('no screenshot tool: install gnome-screenshot, grim, spectacle or scrot');
    }
    const buf = fs.readFileSync(file);
    return { kind: 'image', mime: 'image/png', b64: buf.toString('base64'), size: buf.length };
  } finally { try { fs.rmSync(file, { force: true }); } catch { /* */ } }
}

// ── mouse ──
export async function mouse({ action = 'click', x, y, button, clicks, amount }) {
  const X = Number(x), Y = Number(y);
  const hasXY = Number.isFinite(X) && Number.isFinite(Y);
  const b = btn(button);
  const n = action === 'double' ? 2 : Math.max(1, Math.min(3, Number(clicks) || 1));
  if (process.platform === 'win32') {
    const flags = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] }[b];
    const move = hasXY ? `[M]::SetCursorPos(${Math.round(X)}, ${Math.round(Y)}) | Out-Null; Start-Sleep -Milliseconds 40` : '';
    let act = '';
    if (action === 'move') act = '';
    else if (action === 'scroll') act = `[M]::mouse_event(0x0800, 0, 0, ${Math.round((Number(amount) || 3) * 120)}, 0)`;
    else act = Array.from({ length: n }, () => `[M]::mouse_event(${flags[0]}, 0, 0, 0, 0); [M]::mouse_event(${flags[1]}, 0, 0, 0, 0)`).join('; Start-Sleep -Milliseconds 80; ');
    await ps(`Add-Type -Name M -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);'
$M = [W.M]
${move}
${act}`);
  } else if (process.platform === 'darwin') {
    if (has('cliclick')) {
      const p = hasXY ? `${Math.round(X)},${Math.round(Y)}` : '.';
      const c = action === 'move' ? `m:${p}` : action === 'scroll' ? null : action === 'double' ? `dc:${p}` : b === 'right' ? `rc:${p}` : `c:${p}`;
      if (c) await run('cliclick', [c]); else throw new Error('scroll needs cliclick 5+ or is unsupported here');
    } else {
      if (action === 'move') throw new Error('moving the mouse on macOS needs cliclick (brew install cliclick)');
      if (action === 'scroll') throw new Error('scrolling on macOS needs cliclick');
      if (!hasXY) throw new Error('x and y are needed');
      const kind = action === 'double' ? 'double click' : b === 'right' ? 'right click' : 'click';
      await run('osascript', ['-e', `tell application "System Events" to ${kind} at {${Math.round(X)}, ${Math.round(Y)}}`]);
    }
  } else {
    const tool = has('xdotool') ? 'xdotool' : has('ydotool') ? 'ydotool' : null;
    if (!tool) throw new Error('no mouse tool: install xdotool (X11/XWayland) or ydotool (Wayland)');
    const code = { left: 1, middle: 2, right: 3 }[b];
    if (tool === 'xdotool') {
      if (hasXY) await run('xdotool', ['mousemove', String(Math.round(X)), String(Math.round(Y))]);
      if (action === 'scroll') await run('xdotool', ['click', '--repeat', String(Math.abs(Number(amount) || 3)), (Number(amount) || 3) > 0 ? '4' : '5']);
      else if (action !== 'move') await run('xdotool', ['click', '--repeat', String(n), String(code)]);
    } else {
      if (hasXY) await run('ydotool', ['mousemove', '--absolute', '-x', String(Math.round(X)), '-y', String(Math.round(Y))]);
      if (action === 'scroll') await run('ydotool', ['mousemove', '-w', '-x', '0', '-y', String(-(Number(amount) || 3))]);
      else if (action !== 'move') for (let i = 0; i < n; i++) await run('ydotool', ['click', { 1: '0xC0', 2: '0xC2', 3: '0xC1' }[code]]);
    }
  }
  return { ok: true, action, x: hasXY ? Math.round(X) : null, y: hasXY ? Math.round(Y) : null, button: b, clicks: action === 'move' || action === 'scroll' ? 0 : n };
}

// ── keyboard: typed text, or a key combination like "ctrl+s", "enter", "alt+tab" ──
const WIN_KEY = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BS}', delete: '{DEL}', del: '{DEL}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', insert: '{INS}', f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}' };
const MAC_CODE = { enter: 36, return: 36, tab: 48, esc: 53, escape: 53, backspace: 51, delete: 117, del: 117, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121, space: 49, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const X_KEY = { esc: 'Escape', escape: 'Escape', enter: 'Return', return: 'Return', backspace: 'BackSpace', del: 'Delete', delete: 'Delete', pageup: 'Prior', pagedown: 'Next', ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super', win: 'super', super: 'super', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', space: 'space' };
const sendKeysEscape = (s) => s.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);

export async function keyboard({ action = 'type', text, keys }) {
  if (action === 'type') {
    const s = String(text ?? '');
    if (!s) throw new Error('text is empty');
    if (process.platform === 'win32') {
      await ps(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${sendKeysEscape(s).replace(/'/g, "''")}')`);
    } else if (process.platform === 'darwin') {
      await run('osascript', ['-e', `tell application "System Events" to keystroke "${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]);
    } else if (has('xdotool')) await run('xdotool', ['type', '--delay', '12', '--', s]);
    else if (has('wtype')) await run('wtype', ['--', s]);
    else if (has('ydotool')) await run('ydotool', ['type', '--', s]);
    else throw new Error('no keyboard tool: install xdotool (X11/XWayland), wtype or ydotool (Wayland)');
    return { ok: true, action, typed: s.length };
  }
  // a combination
  const parts = String(keys || '').toLowerCase().split('+').map((k) => k.trim()).filter(Boolean);
  if (!parts.length) throw new Error('keys is empty');
  const mods = parts.filter((k) => ['ctrl', 'control', 'alt', 'shift', 'cmd', 'command', 'win', 'super', 'meta', 'option'].includes(k));
  const main = parts.filter((k) => !mods.includes(k));
  if (main.length !== 1) throw new Error('one main key with modifiers, e.g. ctrl+s');
  const k = main[0];
  if (process.platform === 'win32') {
    const m = mods.map((x) => ({ ctrl: '^', control: '^', alt: '%', shift: '+', win: '', super: '', cmd: '', command: '', meta: '', option: '%' }[x])).join('');
    const key = WIN_KEY[k] || (k.length === 1 ? sendKeysEscape(k) : null);
    if (!key) throw new Error(`unknown key: ${k}`);
    if (mods.some((x) => ['win', 'super', 'cmd', 'command', 'meta'].includes(x))) throw new Error('the Windows key is not supported in a combination');
    await ps(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${(m + key).replace(/'/g, "''")}')`);
  } else if (process.platform === 'darwin') {
    const using = mods.map((x) => ({ ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down', cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down', super: 'command down' }[x])).join(', ');
    const target = MAC_CODE[k] != null ? `key code ${MAC_CODE[k]}` : k.length === 1 ? `keystroke "${k}"` : null;
    if (!target) throw new Error(`unknown key: ${k}`);
    await run('osascript', ['-e', `tell application "System Events" to ${target}${using ? ` using {${using}}` : ''}`]);
  } else {
    if (!has('xdotool')) throw new Error('key combinations on Linux need xdotool');
    const combo = [...mods, k].map((x) => X_KEY[x] || x).join('+');
    await run('xdotool', ['key', '--clearmodifiers', combo]);
  }
  return { ok: true, action: 'press', keys: parts.join('+') };
}
