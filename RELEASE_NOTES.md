Oqool Agent 0.4.0

- Windows: the agent runs as one script with the signed Node.js, so Smart App Control lets it run. The installer uses Node 22+ when present, otherwise downloads the official Node into the agent folder (no administrator rights).
- The background start line on Windows is encoded (paths with spaces or quotes cannot break it).
