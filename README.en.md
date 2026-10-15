<div align="center">

# proto-tool

**Sticky notes for any HTML prototype — burned right into the file.**

Send it to someone. They double-click. The notes are there.

`zero dependencies` · `fully offline` · `self-contained file` · `cross-platform`

[![CI](https://github.com/KUNER66/proto-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/KUNER66/proto-tool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[English](./README.en.md) · [中文](./README.md)

</div>

---

## What is this

You've built an HTML prototype and want to leave a few remarks on it —

*"copy still TBD here"*, *"this interaction contradicts the spec"*, *"turnaround time needs sign-off from the crew team"* —

Axure has annotations. Figma has comments. But **the moment you export to HTML, they're gone.**
Online annotation tools (like Hypothes.is) need a network, an account, and a server —
hand the file to someone else and your notes don't travel with it.

**proto-tool takes a different route: it writes the notes into the HTML file itself.**

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  Open any    │     │  Drop sticky notes   │     │  Notes get       │
│  HTML file   │ ──▶ │  right on the page   │ ──▶ │  burned into it  │
└──────────────┘     └──────────────────────┘     └──────────────────┘
                                                           │
                                                           ▼
                                    Send to a colleague → double-click → notes are there
```

The recipient **doesn't install anything**. Double-click the file and every note
shows up in place.

---

## Demo

> Screenshot slot: `docs/screenshot-main.png` — the tool with a note pinned.
>
> Record a 10-second GIF and put it here: open prototype → pin three notes → save →
> open in another browser → notes still there. One GIF beats a thousand words.

<!--
![UI](docs/screenshot-main.png)
![Demo](docs/demo.gif)
-->

---

## Quick start

### Option 1: Double-click (for non-developers)

1. Install [Node.js](https://nodejs.org) 18+ (one time only)
2. Download this repo, double-click **`start.bat`** (Windows) or run **`./start.sh`** (macOS / Linux)
3. Browser opens automatically → click **Open prototype** → pick your HTML file
4. Click **`+ Note`** → click anywhere on the page → type. Saves automatically.

### Option 2: Command line

```bash
git clone https://github.com/KUNER66/proto-tool.git
cd proto-tool
npm start          # starts the server and opens the browser
```

CLI flags:

| Flag | Description |
|---|---|
| `-p, --port <port>` | Listening port (default `7317`; `PORT` env var also works) |
| `-o, --open` | Open the browser on start |
| `-h, --help` | Show help |
| `-v, --version` | Print version |

```bash
proto-tool --open                    # after installing globally
node server/index.js --port 7320       # or pass it directly
PORT=7320 npm start                  # via env var (macOS / Linux)
set PORT=7320 && start.bat           # via env var (Windows)
```

### Option 3: Just try it

Two sample prototypes live in `examples/` — open either one with the tool.

---

## Desktop client

Prefer not to install Node or touch a terminal? The desktop build packages everything into a single exe.

> **Status**: code complete, installer not built yet.

### Building the desktop app

Three prerequisites, installed once:

| Dependency | Why | Get it |
|---|---|---|
| **Node.js 18+** | installs the Tauri CLI | [nodejs.org](https://nodejs.org) |
| **Rust** | compiles the desktop shell | [rustup.rs](https://rustup.rs), toolchain `stable-x86_64-pc-windows-msvc` |
| **Microsoft C++ Build Tools** | Tauri's Windows backend compiles a small amount of C/C++ | Visual Studio Build Tools, tick "Desktop development with C++" |

Windows 10 21H2 / 11 ship the WebView2 runtime, so nothing extra is needed.

```bash
git clone https://github.com/KUNER66/proto-tool.git
cd proto-tool
npm install
npm run desktop:build
```

Installers land here - pick either:

```
src-tauri/target/release/bundle/nsis/proto-tool_0.2.0_x64-setup.exe
src-tauri/target/release/bundle/msi/proto-tool_0.2.0_x64_en-US.msi
```

Dev mode (see changes without packaging):

```bash
npm run desktop
```

### Why the desktop and CLI builds inject identically

The Rust side **only touches files** - listing directories, reading, atomic writes, reading the runtime.

Stripping old markers, building the data block and inserting the runtime is **all done by `src/lib/injector.js`**, shared with the Node server. A second implementation in Rust would drift, and you would end up with the same file saving differently depending on which tool opened it.

The UI works the same way: `src/index.html` has a `host` adapter - `fetch('/api/*')` over HTTP, Tauri `invoke` on desktop - and **both expose identical data shapes**, so no business logic changed.

> macOS / Linux can be built too, but need their own native dependencies (Xcode CLT / webkit2gtk) and the matching entries in `bundle.targets`. The repo currently configures Windows `nsis` / `msi` only.

---

## Usage

| Action | Description |
|---|---|
| **`+ Note`** | Enter pin mode, click anywhere to place a sticky note |
| **Drag a note** | Move it around; it re-anchors to whatever element it lands on |
| **Click the text** | Edit in place. Emptying an existing note deletes it |
| **Type dropdown** | Switch between "Spec note" (yellow) / "Internal TODO" (purple) |
| **`Internal TODO`** | Toggle visibility. **Collapsed while editing, all shown when shared** |
| **`List`** | Review all notes, jump to one, change type, mark done, delete |
| **`Export text`** | Copy all notes as plain text — handy for spec docs or meeting minutes |

Toolbar: `Open prototype` (Ctrl+O) · `Reload` · `Clear notes`

---

## Two note kinds

| Kind | Color | Purpose |
|---|---|---|
| **Spec note** | Yellow | Formal remarks for reviewers |
| **Internal TODO** | Purple | Your own task list |

TODOs collapse while editing (keeps the page clean), but **both kinds are shown to
whoever you share the file with — nothing is dropped.**

---

## Key features

### Notes live inside the file, not somewhere else

Note data and the rendering runtime are both injected into the target HTML,
wrapped in comment markers:

```html
<!-- AN:NOTES:BEGIN --><script id="an-data" type="application/json">{...}</script><!-- AN:NOTES:END -->
<!-- AN:RUNTIME:BEGIN --><script id="an-runtime">...</script><!-- AN:RUNTIME:END -->
```

The recipient double-clicks the file; the runtime reads the data block and renders
the notes. **Zero network requests.**

### Saving repeatedly never bloats the file

Injection is **idempotent**: each save locates the previous injection by id, strips
it entirely, then inserts a fresh one. After a hundred saves the file still holds
exactly one data block and one runtime — stable size.

> Guarded by a unit test: `test/injector.test.js` asserts that after N injections,
> stripping yields output byte-identical to the original.

### Notes follow the page, not the screen

A sticky note isn't pinned to raw screen coordinates — it remembers **which element**
it overlaps and its offset relative to that element. Switch tabs, toggle elements,
resize the window: notes recompute. If the anchor disappears, the note hides;
when it returns, so does the note.

### Editor credentials never leak to the recipient

When the tool opens a prototype in an iframe, it temporarily injects a line that
puts the runtime into editable mode. **That line exists only in the copy rendered
for the tool itself — it's excluded when writing to disk.**

So the file on your disk is editable, while the very same file you send out is a
**read-only view**. The recipient sees a small "Notes N" badge in the corner, can
browse the list, and cannot accidentally modify your file.

> Also test-guarded: asserts the on-disk file contains no `window.__AN_EDIT__ = {...}` assignment.

---

## Project layout

```
proto-tool/
├── start.bat                   Windows launcher (double-click)
├── start.sh                    macOS / Linux launcher
├── package.json
├── lib/
│   └── injector.js             ★ Injection core: strip / build / read-write (pure string ops)
├── src/
│   ├── server.js               Local server: static assets + file browser + disk writes
│   ├── index.html              Tool UI
│   └── runtime/
│       └── annotator.js        ★ Runtime injected into target HTML
├── test/
│   ├── injector.test.js        Unit tests for injection logic
│   └── server.e2e.js           End-to-end tests for the local server
├── examples/                   Sample prototypes
└── docs/                       Docs and screenshots
```

`src/lib/injector.js` is a **pure module** — no dependency on `fs`, `http`, or any
environment. The server, a future desktop client, a CLI, and the test suite can all
share the same injection semantics, so there's no risk of the two implementations
drifting apart.

---

## Why a local server

Browser security forbids a web page from writing to files on disk. So a small local
program sits in the middle:

```
Tool UI (browser)  ──HTTP──▶  Local server (Node)  ──write──▶  your HTML file
```

The server binds to `127.0.0.1` only. **Nothing leaves your machine.**

### Why an in-page file browser instead of a native dialog

The first attempt used the OS file dialog. Two blockers made it unusable:

1. The dialog runs in a separate process and **can't steal foreground focus** from
   the browser — it opens behind other windows and users think nothing happened.
2. GUI programs **don't write to the console pipe**, so Node always read back an
   empty string → the front end never received a selection.

A self-drawn in-page browser keeps the window inside the page and passes paths over
HTTP. Both problems disappear.

---

## Development

```bash
npm test           # unit tests for injection logic (26 cases)
npm run test:e2e   # end-to-end tests for the local server (run npm run serve first)
npm run test:all   # both
```

Requires Node 18+. **No third-party dependencies.**

---

## Known limitations

- **Single-file HTML only.** If your prototype is HTML + external CSS/JS, injection
  still works, but you must ship the asset folder alongside it.
- **Modifies the original file.** Notes are written into the HTML you select. Use
  version control for important prototypes. A built-in "Clear notes" action restores
  a clean file.
- **No real-time collaboration.** It's built for one-way annotation ("I'll mark this up
  for you"), not live co-editing.

---

## Roadmap

- [x] v0.1 · Node local server + browser UI
- [~] v0.2 · Tauri desktop client (~5 MB installer, no Node required) - code complete, build pending
- [ ] v0.3 · Export notes as Markdown / spec-document format
- [ ] v0.4 · Multi-file prototype support

---

## License

[MIT](LICENSE) — use it, change it, ship it.
