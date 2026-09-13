# Commit Diff Viewer

A fully local browser tool for comparing two code snapshots with a GitHub-style diff.

## Run it

Open `index.html` directly in a modern browser. No server, build step, login, or internet connection is required.

For GitHub Pages, upload these files to a repository and enable Pages:

- `index.html`
- `style.css`
- `script.js`

## Loading snapshots

Each side can be filled in several ways:

- paste code directly into a file tab
- choose individual files
- choose an entire folder
- drag and drop files or a folder
- choose or drop a ZIP snapshot

The manual editor starts with `index.html`, `style.css`, and `script.js`. Folder and ZIP snapshots can add other text files automatically. A shared top-level folder in a ZIP/folder is stripped so snapshots with different root folder names still match by relative path.

Binary files are fingerprinted locally. They appear as added, deleted, modified, or unchanged, but their bytes are not displayed as code.

## Diff features

- synchronized Commit 1 / Commit 2 aligned panels
- real line numbers on both sides
- green added lines and red deleted lines
- word-level highlighting inside paired modified lines
- modification pairing between old and new lines
- Unified and Split result views
- per-file additions, deletions, status, and changed percentage
- total changed files, additions, deletions, logical changed rows, modified rows, and changed percentage
- collapse unchanged code with click-to-expand ranges
- Only changes mode
- Ignore whitespace mode
- Previous / Next change navigation
- change minimaps on both commit panels
- search across both commits for the current file
- `Ctrl+F` / `Cmd+F` focuses the built-in search
- `Enter` / `Shift+Enter` moves through search matches
- `Alt+Down` / `Alt+Up` moves through code changes
- `Ctrl+Enter` / `Cmd+Enter` compares the snapshots
- Copy patch
- Download `.diff`

Patch export is always whitespace-sensitive so exported patches do not silently omit real source edits when Ignore whitespace is enabled for viewing.

## ZIP support

ZIP files are read in the browser. Stored and DEFLATE-compressed entries are supported. Encrypted ZIP entries, ZIP64-only metadata, and unsupported compression methods are reported with an error instead of uploading anything elsewhere.

## Privacy

There are no remote scripts, external fonts, analytics, APIs, or backend requests. Snapshot contents stay in the browser on the current device.

- Drag/drop single files, multiple files, folders, multiple folders, or ZIP snapshots directly onto either commit panel.
