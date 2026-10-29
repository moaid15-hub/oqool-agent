# Oqool Agent

Connects AI models — Oqool Cloud, Claude, ChatGPT, any MCP client — to your computer. The model thinks in the cloud; files, commands and processes run here. One program, no Node, nothing else to install.

## Install

One line in a terminal. Pick the one for your terminal:

**Linux / macOS** (Terminal):

```sh
curl -fsSL https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.sh | sh
```

**Windows — Command Prompt (CMD)** (the usual black window, `C:\Users\…>`):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.ps1 | iex"
```

**Windows — PowerShell** (blue window, `PS C:\Users\…>`):

```powershell
irm https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.ps1 | iex
```

`irm` is a PowerShell command: in CMD it says *"irm" is not recognized* — use the CMD line instead.

The installer opens your browser to link this computer to your Oqool account (one click), then keeps the agent running in the background and starts it with your computer.

## Connect a model

Add the connector in Claude or ChatGPT (custom connector):

```
https://oqool-relay-cloud.moaid15.workers.dev/mcp
```

Sign in with your Oqool account and allow. That is all.

## Commands

| | |
|---|---|
| `oqool-agent setup` | link this computer and run in the background (the installer does this) |
| `oqool-agent status` | linked? running? |
| `oqool-agent` | run in this terminal until Ctrl+C |
| `oqool-agent [folders…]` | run limited to those folders |
| `oqool-agent uninstall` | stop the background agent and remove it from startup |
| `oqool-agent logout` | forget the link |
| `oqool-agent update` | update now (it also updates itself on every start) |

## What it can do

The whole computer by default, like Desktop Commander: read (windows of lines, images, several files), write, append, exact edits, list, file info, create, move, delete; background search; commands; live processes (REPL, ssh, servers) you can read from and type into; system processes; settings; a local log.

Limit it any time: allowed folders (`roots`) and your own block list of commands (`blockedCommands`) — set from the model with `set_config_value` or in `~/.oqool-agent/config.json`.

Outbound connection only — no open port, no keys on this computer.
