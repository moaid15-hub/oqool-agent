## Oqool Agent 0.7.0

- **Screen, mouse and keyboard** — three new tools: `screen_capture`, `mouse_control` (move, click, double, right, scroll), `keyboard_control` (type text, press combinations like `ctrl+s`).
- **Every use needs your answer in the agent window**: `y` this once, `a` while the window stays open, `n`. No answer in 90 s = no. Nothing moves before you answer. Switch it off for good with `control = never` in the settings.
- Windows works out of the box (PowerShell). macOS uses System Events (allow Accessibility once; `cliclick` for mouse moves). Linux needs `xdotool` or `ydotool`/`wtype` and a screenshot tool.
- 33 tools now.
