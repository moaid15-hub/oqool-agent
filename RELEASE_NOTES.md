## Oqool Agent 0.4.1

- `read_file` now reads **PDF** files as text, page by page (`offset` / `length` count pages).
- `read_file` now reads **Excel** (.xlsx / .xlsm) sheets as CSV: choose `sheet` (name or index) and `range` (e.g. `A1:D20`).
- `read_multiple_files` reads PDF and Excel too.
- Pinned dependencies (`unpdf`, `fflate`), bundled into every build; nothing extra to install.

Install / update: see the README. Running agents update themselves.
