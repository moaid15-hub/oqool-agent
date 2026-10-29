// Oqool Agent — runs by itself in the background · يعمل وحده بالخلفية (the install line links the machine and keeps
// the agent running, like Desktop Commander's launcher). One user-level service per system, no administrator rights:
//   Linux  systemd --user unit (fallback: XDG autostart)   macOS  LaunchAgent   Windows  HKCU Run key (hidden window)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const LABEL = 'net.oqool.agent';

/** Opens a link in the user's browser; false when there is no desktop to open it on. */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', url.replace(/&/g, '^&')], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch { return false; }
}

const unitPath = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'oqool-agent.service');
const desktopPath = () => path.join(os.homedir(), '.config', 'autostart', 'oqool-agent.desktop');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });

const psEncoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Installs and starts the background service. `parts` = how to start the agent: [program] or [node, script]. */
export function installService(parts, home) {
  const [exe, ...extra] = parts;
  const envHome = process.env.OQOOL_AGENT_HOME ? home : null;
  const quoted = parts.map((p) => JSON.stringify(p)).join(' ');
  if (process.platform === 'linux') {
    const unit = `[Unit]\nDescription=Oqool Agent\nAfter=network-online.target\n\n[Service]\nExecStart=${quoted} --service\nRestart=always\nRestartSec=5\nRestartPreventExitStatus=2\n${envHome ? `Environment=OQOOL_AGENT_HOME=${envHome}\n` : ''}\n[Install]\nWantedBy=default.target\n`;
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), unit);
    const r1 = run('systemctl', ['--user', 'daemon-reload']);
    const r2 = run('systemctl', ['--user', 'enable', '--now', 'oqool-agent.service']);
    if (r1.status === 0 && r2.status === 0) {
      run('loginctl', ['enable-linger', os.userInfo().username]); // keeps it running without an open session, when allowed
      return { kind: 'systemd', file: unitPath() };
    }
    // no user systemd (containers, some distros): start now and autostart with the desktop session
    fs.mkdirSync(path.dirname(desktopPath()), { recursive: true });
    fs.writeFileSync(desktopPath(), `[Desktop Entry]\nType=Application\nName=Oqool Agent\nExec=${quoted} --service\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
    spawn(exe, [...extra, '--service'], { stdio: 'ignore', detached: true, env: process.env }).unref();
    return { kind: 'autostart', file: desktopPath() };
  }
  if (process.platform === 'darwin') {
    const logs = path.join(home, 'agent.log');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${parts.map((p) => `<string>${p}</string>`).join('')}<string>--service</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${logs}</string>\n<key>StandardErrorPath</key><string>${logs}</string>\n${envHome ? `<key>EnvironmentVariables</key><dict><key>OQOOL_AGENT_HOME</key><string>${envHome}</string></dict>\n` : ''}</dict></plist>\n`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    run('launchctl', ['unload', plistPath()]);
    fs.writeFileSync(plistPath(), plist);
    run('launchctl', ['load', '-w', plistPath()]);
    return { kind: 'launchd', file: plistPath() };
  }
  if (process.platform === 'win32') {
    // a hidden start through PowerShell, at every sign-in; started now as well
    const q1 = (x) => x.replace(/'/g, "''");
    const argList = [...extra.map((a) => `"${a}"`), '--service'].join(' ');
    const ps = `Start-Process -WindowStyle Hidden -FilePath '${q1(exe)}' -ArgumentList '${q1(argList)}'`;
    // encoded, so no quoting of paths can break the start line · مُرمَّز كي لا تكسره علامات التنصيص في المسارات
    const value = `powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand ${psEncoded(ps)}`;
    run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OqoolAgent', '/t', 'REG_SZ', '/d', value, '/f']);
    // start it now OUTSIDE this window: a child of setup dies when setup's console closes. WMI creates the process
    // under its own service, so it outlives this window · يُشغَّل عبر WMI كي لا يموت مع نافذة الإعداد.
    // SW_HIDE (ShowWindow=0): no console window at all — Windows 11 otherwise hands the new console to a visible
    // Terminal window, and closing it ends the agent · بلا نافذة إطلاقاً، فإغلاق نافذة لا يوقفه
    const line = [exe, ...extra].map((p) => `"${p}"`).join(' ') + ' --service';
    const wmi = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${q1(line)}'; ProcessStartupInformation=$si}; exit $r.ReturnValue`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(wmi)]);
    if (r.status !== 0) spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', psEncoded(ps)], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    return { kind: 'windows-run', file: 'HKCU\\…\\Run\\OqoolAgent' };
  }
  return { kind: 'none' };
}

export function uninstallService({ keepRunning = false } = {}) {
  if (process.platform === 'linux') {
    run('systemctl', ['--user', 'disable', ...(keepRunning ? [] : ['--now']), 'oqool-agent.service']);
    for (const f of [unitPath(), desktopPath()]) try { fs.rmSync(f, { force: true }); } catch { /* */ }
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (process.platform === 'darwin') {
    if (!keepRunning) run('launchctl', ['unload', '-w', plistPath()]);
    try { fs.rmSync(plistPath(), { force: true }); } catch { /* */ }
  } else if (process.platform === 'win32') {
    run('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OqoolAgent', '/f']);
  }
}

/** Is the background agent installed / running? (best effort, per system) */
export function serviceStatus(home) {
  let installed = false, running = null;
  if (process.platform === 'linux') {
    installed = fs.existsSync(unitPath()) || fs.existsSync(desktopPath());
    const r = run('systemctl', ['--user', 'is-active', 'oqool-agent.service']);
    if (r.status === 0 || /inactive|failed|activating/.test(r.stdout || '')) running = (r.stdout || '').trim() === 'active';
  } else if (process.platform === 'darwin') {
    installed = fs.existsSync(plistPath());
    const r = run('launchctl', ['list', LABEL]);
    running = r.status === 0 && /"PID"\s*=\s*\d+/.test(r.stdout || '');
  } else if (process.platform === 'win32') {
    installed = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OqoolAgent']).status === 0;
  }
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(home, 'agent.pid'), 'utf8')) || null; if (pid) process.kill(pid, 0); } catch { pid = null; }
  if (running === null) running = !!pid;
  return { installed, running, pid };
}
