const DEFAULT_FILES = ['index.html', 'style.css', 'script.js'];
const SUPPORTED_FILES = DEFAULT_FILES;
const BINARY_PREFIX = '\u0000BINARY:';

function toLines(text) {
  if (text === '') return [];
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function diffArrays(oldItems, newItems, keyFn = value => value) {
  const a = Array.from(oldItems);
  const b = Array.from(newItems);
  if (!a.length && !b.length) return [];
  if (!a.length) return b.map(text => ({ type: 'add', text }));
  if (!b.length) return a.map(text => ({ type: 'delete', text }));

  const aKeys = a.map(keyFn);
  const bKeys = b.map(keyFn);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const left = v.has(k - 1) ? v.get(k - 1) : Number.NEGATIVE_INFINITY;
      const right = v.has(k + 1) ? v.get(k + 1) : Number.NEGATIVE_INFINITY;
      let x;

      if (k === -d || (k !== d && left < right)) {
        x = right === Number.NEGATIVE_INFINITY ? 0 : right;
      } else {
        x = (left === Number.NEGATIVE_INFINITY ? 0 : left) + 1;
      }

      let y = x - k;
      while (x < n && y < m && aKeys[x] === bKeys[y]) {
        x++;
        y++;
      }

      v.set(k, x);
      if (x >= n && y >= m) return backtrackArrayDiff(trace, a, b, d);
    }
  }
  return [];
}

function backtrackArrayDiff(trace, a, b, finalD) {
  let x = a.length;
  let y = b.length;
  const ops = [];

  for (let d = finalD; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const left = v.has(k - 1) ? v.get(k - 1) : Number.NEGATIVE_INFINITY;
    const right = v.has(k + 1) ? v.get(k + 1) : Number.NEGATIVE_INFINITY;
    const prevK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
    const prevXRaw = v.get(prevK);
    const prevX = prevXRaw === undefined ? 0 : prevXRaw;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: b[y - 1], oldText: a[x - 1] });
      x--;
      y--;
    }

    if (d === 0) break;
    if (x === prevX) {
      ops.push({ type: 'add', text: b[y - 1] });
      y--;
    } else {
      ops.push({ type: 'delete', text: a[x - 1] });
      x--;
    }
  }

  return ops.reverse();
}

function diffLines(oldText, newText, options = {}) {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const keyFn = options.ignoreWhitespace ? normalizeWhitespace : value => value;
  return diffArrays(oldLines, newLines, keyFn);
}

function tokenizeWords(text) {
  return String(text).match(/\s+|[\p{L}\p{N}_$]+|[^\s]/gu) || [];
}

function coalesceOps(ops) {
  const out = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    const oldText = op.oldText === undefined ? undefined : String(op.oldText);
    if (prev && prev.type === op.type && (op.type !== 'equal' || (prev.oldText !== undefined) === (oldText !== undefined))) {
      prev.text += String(op.text);
      if (oldText !== undefined) prev.oldText += oldText;
    } else {
      out.push({ type: op.type, text: String(op.text), ...(oldText !== undefined ? { oldText } : {}) });
    }
  }
  return out;
}

function diffWords(oldText, newText, options = {}) {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);
  const keyFn = options.ignoreWhitespace
    ? token => (/^\s+$/.test(token) ? ' ' : token)
    : token => token;
  return coalesceOps(diffArrays(oldTokens, newTokens, keyFn));
}

function summarizeDiff(ops) {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === 'add') additions++;
    if (op.type === 'delete') deletions++;
  }
  return { additions, deletions, changed: additions + deletions };
}

function buildAlignedRows(ops) {
  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  let changeIndex = 0;

  while (index < ops.length) {
    const op = ops[index];
    if (op.type === 'equal') {
      rows.push({
        kind: 'equal',
        old: { type: 'equal', text: op.oldText === undefined ? op.text : op.oldText, lineNumber: oldLine++ },
        new: { type: 'equal', text: op.text, lineNumber: newLine++ }
      });
      index++;
      continue;
    }

    const deletes = [];
    const adds = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'delete') deletes.push(ops[index]);
      if (ops[index].type === 'add') adds.push(ops[index]);
      index++;
    }

    const count = Math.max(deletes.length, adds.length);
    for (let i = 0; i < count; i++) {
      const deleted = deletes[i] || null;
      const added = adds[i] || null;
      const kind = deleted && added ? 'modify' : deleted ? 'delete' : 'add';
      rows.push({
        kind,
        changeIndex: changeIndex++,
        old: deleted ? { type: 'delete', text: deleted.text, lineNumber: oldLine++ } : null,
        new: added ? { type: 'add', text: added.text, lineNumber: newLine++ } : null
      });
    }
  }
  return rows;
}

function collapseAlignedRows(rows, options = {}) {
  const onlyChanged = Boolean(options.onlyChanged);
  const collapse = options.collapse !== false;
  const context = Number.isInteger(options.context) ? Math.max(0, options.context) : 3;

  if (onlyChanged) {
    return rows
      .map((row, index) => ({ type: 'row', row, index }))
      .filter(entry => entry.row.kind !== 'equal');
  }
  if (!collapse) return rows.map((row, index) => ({ type: 'row', row, index }));

  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'equal') return;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    for (let i = start; i <= end; i++) keep[i] = true;
  });

  if (!keep.some(Boolean)) return rows.map((row, index) => ({ type: 'row', row, index }));

  const entries = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      entries.push({ type: 'row', row: rows[i], index: i });
      i++;
      continue;
    }
    const start = i;
    while (i < rows.length && !keep[i]) i++;
    entries.push({ type: 'collapse', start, end: i - 1, count: i - start });
  }
  return entries;
}

function orderedFileNames(oldFiles, newFiles) {
  const names = new Set([...Object.keys(oldFiles || {}), ...Object.keys(newFiles || {})]);
  return Array.from(names).sort((a, b) => {
    const ai = DEFAULT_FILES.indexOf(a);
    const bi = DEFAULT_FILES.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function buildComparison(oldFiles = {}, newFiles = {}, options = {}) {
  const files = {};
  const total = {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    changed: 0,
    logicalChanged: 0,
    modified: 0,
    percentage: 0
  };
  let percentageBase = 0;

  for (const name of orderedFileNames(oldFiles, newFiles)) {
    const oldExists = Object.prototype.hasOwnProperty.call(oldFiles, name);
    const newExists = Object.prototype.hasOwnProperty.call(newFiles, name);
    const oldText = oldExists ? String(oldFiles[name] ?? '') : '';
    const newText = newExists ? String(newFiles[name] ?? '') : '';
    const ops = diffLines(oldText, newText, options);
    const baseSummary = summarizeDiff(ops);
    const rows = buildAlignedRows(ops);
    const logicalChanged = rows.filter(row => row.kind !== 'equal').length;
    const modified = rows.filter(row => row.kind === 'modify').length;
    const oldLineCount = toLines(oldText).length;
    const newLineCount = toLines(newText).length;
    const denominator = Math.max(oldLineCount, newLineCount, 1);
    const percentage = roundOne(Math.min(100, (logicalChanged / denominator) * 100));

    let status = 'unchanged';
    if (!oldExists && newExists) status = 'added';
    else if (oldExists && !newExists) status = 'deleted';
    else if (baseSummary.changed > 0) status = 'modified';

    const changed = status !== 'unchanged';
    const summary = {
      ...baseSummary,
      logicalChanged,
      modified,
      percentage,
      oldLineCount,
      newLineCount
    };

    files[name] = {
      name,
      oldText,
      newText,
      oldExists,
      newExists,
      ops,
      rows,
      summary,
      status,
      changed,
      binary: oldText.startsWith(BINARY_PREFIX) || newText.startsWith(BINARY_PREFIX)
    };

    if (changed) total.filesChanged++;
    total.additions += baseSummary.additions;
    total.deletions += baseSummary.deletions;
    total.changed += baseSummary.changed;
    total.logicalChanged += logicalChanged;
    total.modified += modified;
    percentageBase += denominator;
  }

  total.percentage = roundOne(Math.min(100, percentageBase ? (total.logicalChanged / percentageBase) * 100 : 0));
  return { files, fileNames: orderedFileNames(oldFiles, newFiles), total, options: { ...options } };
}

function stripCommonRoot(paths) {
  const clean = paths.map(path => String(path).replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!clean.length) return [];
  const firstParts = clean[0].split('/');
  if (firstParts.length < 2) return clean;
  const root = firstParts[0];
  if (!clean.every(path => path.includes('/') && path.split('/')[0] === root)) return clean;
  return clean.map(path => path.split('/').slice(1).join('/'));
}

function detectFolderName(records) {
  const paths = Array.from(records || [])
    .map(record => sanitizeRelativePath(record?.path || record?.file?.webkitRelativePath || ''))
    .filter(Boolean);
  if (!paths.length || !paths.every(path => path.includes('/'))) return null;
  const root = paths[0].split('/')[0];
  if (!root || !paths.every(path => path.split('/')[0] === root)) return null;
  return root;
}

function isBinaryPlaceholder(text) {
  return String(text).startsWith(BINARY_PREFIX);
}

function generatePatch(oldFiles = {}, newFiles = {}) {
  const chunks = [];
  for (const name of orderedFileNames(oldFiles, newFiles)) {
    const oldExists = Object.prototype.hasOwnProperty.call(oldFiles, name);
    const newExists = Object.prototype.hasOwnProperty.call(newFiles, name);
    const oldText = oldExists ? String(oldFiles[name] ?? '') : '';
    const newText = newExists ? String(newFiles[name] ?? '') : '';
    if (oldExists && newExists && oldText === newText) continue;

    chunks.push(`diff --git a/${name} b/${name}`);
    chunks.push(oldExists ? `--- a/${name}` : '--- /dev/null');
    chunks.push(newExists ? `+++ b/${name}` : '+++ /dev/null');

    if (isBinaryPlaceholder(oldText) || isBinaryPlaceholder(newText)) {
      chunks.push(`Binary files ${oldExists ? `a/${name}` : '/dev/null'} and ${newExists ? `b/${name}` : '/dev/null'} differ`);
      chunks.push('');
      continue;
    }

    const oldCount = toLines(oldText).length;
    const newCount = toLines(newText).length;
    const oldStart = oldCount ? 1 : 0;
    const newStart = newCount ? 1 : 0;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of diffLines(oldText, newText)) {
      if (op.type === 'equal') chunks.push(` ${op.oldText === undefined ? op.text : op.oldText}`);
      else if (op.type === 'delete') chunks.push(`-${op.text}`);
      else chunks.push(`+${op.text}`);
    }
    chunks.push('');
  }
  return chunks.join('\n');
}


const TEXT_EXTENSIONS = new Set([
  'html','htm','css','js','mjs','cjs','jsx','ts','tsx','json','md','txt','svg','xml','yml','yaml',
  'py','java','c','cc','cpp','h','hpp','cs','go','rs','rb','php','sh','bash','zsh','ps1','toml','ini','cfg',
  'env','sql','vue','svelte','astro','properties','gradle','kt','kts','dart','lua','r','tex','csv','gitignore'
]);
const TEXT_BASENAMES = new Set(['readme','license','licence','makefile','dockerfile','procfile','gemfile','rakefile']);
const BINARY_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','mp3','wav','ogg','mp4','mov','avi','pdf','zip','gz','7z','rar','woff','woff2','ttf','otf','exe','dll','so','dylib','class','jar']);

function sanitizeRelativePath(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) return '';
  return parts.join('/');
}

function fnv1aBytes(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isLikelyTextBytes(bytes, path = '') {
  const clean = sanitizeRelativePath(path);
  const base = clean.split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(base)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (!sample.length) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  }
  return controls / sample.length < 0.02;
}

function bytesToSnapshotValue(bytes, path) {
  if (isLikelyTextBytes(bytes, path)) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return `${BINARY_PREFIX}${bytes.length}:${fnv1aBytes(bytes)}`;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress DEFLATE ZIP entries. Try a modern Chrome, Edge, Firefox or Safari browser.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function findEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function readZipSnapshot(input) {
  const arrayBuffer = input instanceof ArrayBuffer
    ? input
    : ArrayBuffer.isView(input)
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : await input.arrayBuffer();
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('Invalid ZIP: central directory was not found.');

  const totalEntries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (totalEntries > 2000) throw new Error('ZIP has too many entries to compare safely in the browser.');

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries = [];
  let offset = centralOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry.');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const decodedName = decoder.decode(rawName).replace(/\\/g, '/');
    const isDirectory = decodedName.endsWith('/');
    const path = sanitizeRelativePath(decodedName);
    offset += 46 + nameLength + extraLength + commentLength;

    if (!path || isDirectory || path.startsWith('__MACOSX/')) continue;
    if (flags & 0x1) throw new Error(`Encrypted ZIP entry is not supported: ${path}`);
    if (uncompressedSize > 50 * 1024 * 1024) throw new Error(`ZIP entry is too large: ${path}`);
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header: ${path}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let raw;
    if (method === 0) raw = new Uint8Array(compressed);
    else if (method === 8) raw = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method}: ${path}`);
    entries.push({ path, value: bytesToSnapshotValue(raw, path) });
  }

  const stripped = stripCommonRoot(entries.map(entry => entry.path));
  const snapshot = {};
  entries.forEach((entry, index) => {
    const path = sanitizeRelativePath(stripped[index]);
    if (path) snapshot[path] = entry.value;
  });
  return snapshot;
}

function recordsFromFileList(fileList) {
  return Array.from(fileList || []).map(file => ({
    file,
    path: sanitizeRelativePath(file.webkitRelativePath || file.name)
  }));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkLegacyEntry(entry) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const path = sanitizeRelativePath(entry.fullPath || file.webkitRelativePath || file.name);
    return path ? [{ file, path }] : [];
  }
  if (!entry.isDirectory) return [];

  const reader = entry.createReader();
  const childEntries = [];
  while (true) {
    const batch = await readDirectoryEntries(reader);
    if (!batch.length) break;
    childEntries.push(...batch);
  }

  const nested = [];
  for (const child of childEntries) nested.push(...await walkLegacyEntry(child));
  return nested;
}

async function walkFileSystemHandle(handle, parentPath = '') {
  if (!handle) return [];
  const path = sanitizeRelativePath(parentPath ? `${parentPath}/${handle.name}` : handle.name);

  if (handle.kind === 'file') {
    const file = await handle.getFile();
    return path ? [{ file, path }] : [];
  }
  if (handle.kind !== 'directory') return [];

  const records = [];
  if (typeof handle.values === 'function') {
    for await (const child of handle.values()) {
      records.push(...await walkFileSystemHandle(child, path));
    }
  } else if (typeof handle.entries === 'function') {
    for await (const [, child] of handle.entries()) {
      records.push(...await walkFileSystemHandle(child, path));
    }
  }
  return records;
}

async function collectDroppedRecords(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []).filter(item => !item.kind || item.kind === 'file');
  if (!items.length) return recordsFromFileList(dataTransfer?.files || []);

  // Call the modern handle API immediately while the drop event's data store is still readable.
  const handlePromises = items.map(item => {
    if (typeof item.getAsFileSystemHandle !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(item.getAsFileSystemHandle()).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  });

  // The legacy entry API is synchronous at the point of access, so capture entries immediately too.
  const legacyEntries = items.map(item => {
    if (typeof item.webkitGetAsEntry !== 'function') return null;
    try {
      return item.webkitGetAsEntry();
    } catch {
      return null;
    }
  });

  const handles = await Promise.all(handlePromises);
  const records = [];

  for (let index = 0; index < items.length; index++) {
    const handle = handles[index];
    if (handle) {
      records.push(...await walkFileSystemHandle(handle));
      continue;
    }

    const entry = legacyEntries[index];
    if (entry) {
      records.push(...await walkLegacyEntry(entry));
      continue;
    }

    if (typeof items[index].getAsFile === 'function') {
      const file = items[index].getAsFile();
      if (file) records.push({ file, path: sanitizeRelativePath(file.webkitRelativePath || file.name) });
    }
  }

  // Some browsers expose an items list that cannot be read as handles/entries. Fall back to files.
  return records.length ? records : recordsFromFileList(dataTransfer?.files || []);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_FILES,
    SUPPORTED_FILES,
    BINARY_PREFIX,
    toLines,
    normalizeWhitespace,
    diffLines,
    diffWords,
    summarizeDiff,
    buildAlignedRows,
    collapseAlignedRows,
    orderedFileNames,
    buildComparison,
    stripCommonRoot,
    detectFolderName,
    generatePatch,
    isBinaryPlaceholder,
    sanitizeRelativePath,
    fnv1aBytes,
    isLikelyTextBytes,
    bytesToSnapshotValue,
    readZipSnapshot,
    recordsFromFileList,
    walkLegacyEntry,
    walkFileSystemHandle,
    collectDroppedRecords
  };
}

if (typeof document !== 'undefined') {
  const makeDefaultSnapshot = () => Object.fromEntries(DEFAULT_FILES.map(name => [name, '']));
  const appState = {
    old: makeDefaultSnapshot(),
    new: makeDefaultSnapshot(),
    activeFile: { old: 'index.html', new: 'index.html' },
    sourceTitle: { old: 'Commit 1', new: 'Commit 2' },
    resultFile: 'index.html',
    view: 'unified',
    comparison: null,
    previewMode: false,
    ignoreWhitespace: false,
    collapseUnchanged: true,
    onlyChanges: false,
    expandedBlocks: new Set(),
    changeCursor: -1,
    searchCursor: -1,
    searchMatches: []
  };

  const editors = {
    old: document.getElementById('old-editor'),
    new: document.getElementById('new-editor')
  };
  const gutters = {
    old: document.getElementById('old-gutter'),
    new: document.getElementById('new-gutter')
  };
  const sourceTitles = {
    old: document.getElementById('old-source-title'),
    new: document.getElementById('new-source-title')
  };
  const editModes = {
    old: document.getElementById('old-edit-mode'),
    new: document.getElementById('new-edit-mode')
  };
  const alignedPreviews = {
    old: document.getElementById('old-aligned-preview'),
    new: document.getElementById('new-aligned-preview')
  };
  const minimaps = {
    old: document.getElementById('old-minimap'),
    new: document.getElementById('new-minimap')
  };
  const statusMessage = document.getElementById('status-message');
  const resultsPlaceholder = document.getElementById('results-placeholder');
  const resultsContent = document.getElementById('results-content');
  const diffOutput = document.getElementById('diff-output');
  const searchInput = document.getElementById('diff-search');

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setStatus(message, type = '') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message${type ? ` ${type}` : ''}`;
  }

  function defaultSourceTitle(side) {
    return side === 'old' ? 'Commit 1' : 'Commit 2';
  }

  function setSourceTitle(side, title) {
    appState.sourceTitle[side] = title || defaultSourceTitle(side);
    sourceTitles[side].textContent = appState.sourceTitle[side];
  }

  function sideNames(side) {
    return orderedFileNames(appState[side], {});
  }

  function ensureActiveFile(side) {
    const names = sideNames(side);
    if (!names.length) {
      appState[side] = makeDefaultSnapshot();
      appState.activeFile[side] = 'index.html';
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(appState[side], appState.activeFile[side])) {
      appState.activeFile[side] = names[0];
    }
  }

  function updateGutter(side) {
    const lineCount = Math.max(1, editors[side].value.split('\n').length);
    gutters[side].innerHTML = Array.from({ length: lineCount }, (_, index) =>
      `<div class="line-gutter-row">${index + 1}</div>`
    ).join('');
    gutters[side].scrollTop = editors[side].scrollTop;
  }

  function renderInputTabs(side) {
    const host = document.getElementById(`${side}-file-tabs`);
    const names = appState.previewMode && appState.comparison ? appState.comparison.fileNames : sideNames(side);
    host.innerHTML = '';

    for (const name of names) {
      const button = document.createElement('button');
      const isActive = appState.previewMode
        ? appState.resultFile === name
        : appState.activeFile[side] === name;
      const hasContent = Object.prototype.hasOwnProperty.call(appState[side], name) && appState[side][name] !== '';
      const file = appState.comparison?.files[name];
      button.className = `file-tab${isActive ? ' active' : ''}${hasContent ? ' has-content' : ''}`;
      button.dataset.side = side;
      button.dataset.file = name;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      const status = appState.previewMode && file ? `<span class="tab-status">${file.status}</span>` : '';
      button.innerHTML = `${escapeHtml(name)} <span class="dirty-dot" aria-hidden="true"></span>${status}`;
      button.addEventListener('click', () => {
        if (appState.previewMode && appState.comparison) {
          selectResultFile(name);
          return;
        }
        saveEditor(side);
        appState.activeFile[side] = name;
        syncEditor(side);
      });
      host.appendChild(button);
    }
  }

  function syncEditor(side) {
    ensureActiveFile(side);
    const name = appState.activeFile[side];
    const value = appState[side][name] ?? '';
    editors[side].value = isBinaryPlaceholder(value) ? '' : value;
    editors[side].disabled = isBinaryPlaceholder(value);
    editors[side].placeholder = isBinaryPlaceholder(value)
      ? 'Binary file — text editing is unavailable.'
      : 'Paste code here, or drop files, a folder, or a ZIP onto this panel...';
    updateGutter(side);
    renderInputTabs(side);
  }

  function saveEditor(side) {
    if (appState.previewMode || editors[side].disabled) return;
    appState[side][appState.activeFile[side]] = editors[side].value;
    updateGutter(side);
    renderInputTabs(side);
  }

  function markComparisonStale() {
    if (!appState.comparison || appState.previewMode) return;
    setStatus('Code changed. Compare again to refresh the diff.', 'warning');
  }

  function setSnapshot(side, snapshot, replace) {
    appState[side] = replace ? { ...snapshot } : { ...appState[side], ...snapshot };
    if (!Object.keys(appState[side]).length) appState[side] = makeDefaultSnapshot();
    const names = sideNames(side);
    if (!Object.prototype.hasOwnProperty.call(appState[side], appState.activeFile[side])) {
      appState.activeFile[side] = names[0] || 'index.html';
    }
    syncEditor(side);
  }

  async function fileToSnapshotValue(file, path) {
    if (file.size > 100 * 1024 * 1024) throw new Error(`File is too large for browser comparison: ${path}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bytesToSnapshotValue(bytes, path);
  }

  async function loadFileRecords(side, records, options = {}) {
    const replace = Boolean(options.replace);
    const stripRoot = Boolean(options.stripRoot);
    if (!records.length) {
      setStatus('No files were found.', 'warning');
      return;
    }

    const zipRecords = records.filter(record => record.file.name.toLowerCase().endsWith('.zip'));
    const ordinary = records.filter(record => !record.file.name.toLowerCase().endsWith('.zip'));
    const snapshot = {};

    try {
      for (const record of zipRecords) Object.assign(snapshot, await readZipSnapshot(record.file));

      const rawPaths = ordinary.map(record => sanitizeRelativePath(record.path || record.file.webkitRelativePath || record.file.name));
      const paths = stripRoot ? stripCommonRoot(rawPaths) : rawPaths;
      for (let i = 0; i < ordinary.length; i++) {
        const path = sanitizeRelativePath(paths[i]);
        if (!path) continue;
        snapshot[path] = await fileToSnapshotValue(ordinary[i].file, path);
      }

      const shouldReplace = replace || (records.length === 1 && zipRecords.length === 1);
      if (appState.previewMode) exitAlignedPreview();
      setSnapshot(side, snapshot, shouldReplace);
      setSourceTitle(side, stripRoot ? detectFolderName(records) : null);
      appState.comparison = null;
      resultsPlaceholder.classList.remove('hidden');
      resultsContent.classList.add('hidden');
      const count = Object.keys(snapshot).length;
      setStatus(`Loaded ${count} file${count === 1 ? '' : 's'} into ${appState.sourceTitle[side]}.`, 'success');
    } catch (error) {
      setStatus(error.message || 'Could not load that snapshot.', 'error');
    }
  }


  function clearSide(side) {
    if (appState.previewMode) exitAlignedPreview();
    appState[side] = makeDefaultSnapshot();
    appState.activeFile[side] = 'index.html';
    appState.comparison = null;
    setSourceTitle(side, null);
    syncEditor(side);
    resultsPlaceholder.classList.remove('hidden');
    resultsContent.classList.add('hidden');
    setStatus(`${appState.sourceTitle[side]} cleared.`);
  }

  function swapCommits() {
    const hadComparison = Boolean(appState.comparison);
    if (appState.previewMode) exitAlignedPreview();
    saveEditor('old');
    saveEditor('new');
    [appState.old, appState.new] = [appState.new, appState.old];
    [appState.activeFile.old, appState.activeFile.new] = [appState.activeFile.new, appState.activeFile.old];
    [appState.sourceTitle.old, appState.sourceTitle.new] = [appState.sourceTitle.new, appState.sourceTitle.old];
    sourceTitles.old.textContent = appState.sourceTitle.old;
    sourceTitles.new.textContent = appState.sourceTitle.new;
    syncEditor('old');
    syncEditor('new');
    if (hadComparison) renderComparison();
    else setStatus('Commits swapped.', 'success');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderSearchMarkedText(text, term, extraClass = '') {
    const raw = String(text);
    if (!term) return extraClass ? `<span class="${extraClass}">${escapeHtml(raw)}</span>` : escapeHtml(raw);
    const regex = new RegExp(escapeRegExp(term), 'gi');
    let cursor = 0;
    let html = '';
    let match;
    while ((match = regex.exec(raw)) !== null) {
      const before = raw.slice(cursor, match.index);
      const found = raw.slice(match.index, match.index + match[0].length);
      html += extraClass ? `<span class="${extraClass}">${escapeHtml(before)}</span>` : escapeHtml(before);
      html += `<mark class="search-hit${extraClass ? ` ${extraClass}` : ''}">${escapeHtml(found)}</mark>`;
      cursor = match.index + match[0].length;
      if (!match[0].length) regex.lastIndex++;
    }
    const tail = raw.slice(cursor);
    html += extraClass ? `<span class="${extraClass}">${escapeHtml(tail)}</span>` : escapeHtml(tail);
    return html;
  }

  function renderWordLevel(row, side) {
    const term = searchInput.value.trim();
    if (row.kind !== 'modify' || !row.old || !row.new) {
      const cell = row[side];
      return cell ? renderSearchMarkedText(cell.text, term) : ' ';
    }
    const ops = diffWords(row.old.text, row.new.text, { ignoreWhitespace: appState.ignoreWhitespace });
    const pieces = [];
    for (const op of ops) {
      if (side === 'old' && op.type === 'add') continue;
      if (side === 'new' && op.type === 'delete') continue;
      const text = side === 'old' && op.type === 'equal' && op.oldText !== undefined ? op.oldText : op.text;
      const className = op.type === 'delete' ? 'word-delete' : op.type === 'add' ? 'word-add' : '';
      pieces.push(renderSearchMarkedText(text, term, className));
    }
    return pieces.join('') || ' ';
  }

  function currentFile() {
    return appState.comparison?.files[appState.resultFile] || null;
  }

  function changedRowIndexes(file = currentFile()) {
    if (!file) return [];
    return file.rows.map((row, index) => row.kind === 'equal' ? -1 : index).filter(index => index >= 0);
  }

  function activeRowIndex() {
    const file = currentFile();
    if (!file) return -1;
    const changes = changedRowIndexes(file);
    const changeRow = appState.changeCursor >= 0 ? changes[appState.changeCursor] : -1;
    const searchRow = appState.searchCursor >= 0 ? appState.searchMatches[appState.searchCursor]?.rowIndex ?? -1 : -1;
    return searchRow >= 0 ? searchRow : changeRow;
  }

  function renderAlignedPanel(side, file) {
    const host = alignedPreviews[side];
    if (file.binary) {
      host.innerHTML = '<div class="binary-change"><strong>Binary file</strong>Content preview is unavailable, but the file status is still compared.</div>';
      return;
    }
    if (!file.rows.length) {
      host.innerHTML = '<div class="aligned-line spacer"><span class="aligned-number"></span><span class="aligned-marker"></span><code> </code></div>';
      return;
    }

    const selected = activeRowIndex();
    host.innerHTML = file.rows.map((row, rowIndex) => {
      const cell = row[side];
      const selectedClass = rowIndex === selected ? ' active-change' : '';
      if (!cell) {
        return `<div class="aligned-line spacer${selectedClass}" data-row-index="${rowIndex}"><span class="aligned-number"></span><span class="aligned-marker"></span><code> </code></div>`;
      }
      const marker = cell.type === 'add' ? '+' : cell.type === 'delete' ? '-' : '';
      const kindClass = row.kind === 'modify' ? ` ${cell.type} modify` : ` ${cell.type}`;
      return `<div class="aligned-line${kindClass}${selectedClass}" data-row-index="${rowIndex}"><span class="aligned-number">${cell.lineNumber}</span><span class="aligned-marker">${marker}</span><code>${renderWordLevel(row, side)}</code></div>`;
    }).join('');
  }

  function renderMinimap(file) {
    for (const side of ['old', 'new']) {
      const host = minimaps[side];
      if (file.binary || !file.rows.length) {
        host.innerHTML = '';
        continue;
      }
      const denominator = Math.max(1, file.rows.length - 1);
      host.innerHTML = file.rows.map((row, index) => {
        if (row.kind === 'equal') return '';
        const top = (index / denominator) * 100;
        return `<button class="minimap-mark ${row.kind}" data-row-index="${index}" style="top:${top}%" title="Jump to ${row.kind} change"></button>`;
      }).join('');
    }
  }

  function renderAlignedPanels() {
    const file = currentFile();
    if (!file || !appState.previewMode) return;
    const oldTop = alignedPreviews.old.scrollTop;
    const newTop = alignedPreviews.new.scrollTop;
    renderAlignedPanel('old', file);
    renderAlignedPanel('new', file);
    renderMinimap(file);
    alignedPreviews.old.scrollTop = oldTop;
    alignedPreviews.new.scrollTop = newTop;
  }

  function refreshSearchMatches(reset = false) {
    const file = currentFile();
    const term = searchInput.value.trim().toLowerCase();
    appState.searchMatches = [];
    if (file && term && !file.binary) {
      file.rows.forEach((row, rowIndex) => {
        for (const side of ['old', 'new']) {
          const text = row[side]?.text || '';
          const lower = text.toLowerCase();
          let pos = 0;
          while ((pos = lower.indexOf(term, pos)) !== -1) {
            appState.searchMatches.push({ rowIndex, side, position: pos });
            pos += Math.max(1, term.length);
          }
        }
      });
    }
    if (reset || appState.searchCursor >= appState.searchMatches.length) appState.searchCursor = -1;
    updateSearchStatus();
  }

  function updateSearchStatus() {
    const count = appState.searchMatches.length;
    const label = appState.searchCursor >= 0 && count
      ? `${appState.searchCursor + 1}/${count} matches`
      : `${count} match${count === 1 ? '' : 'es'}`;
    document.getElementById('search-position').textContent = label;
  }

  function updateChangeStatus() {
    const changes = changedRowIndexes();
    document.getElementById('change-position').textContent = changes.length
      ? (appState.changeCursor >= 0 ? `${appState.changeCursor + 1}/${changes.length} changes` : `${changes.length} changes`)
      : 'No changes';
  }

  function scrollAlignedToRow(rowIndex) {
    if (rowIndex < 0) return;
    const target = alignedPreviews.old.querySelector(`[data-row-index="${rowIndex}"]`)
      || alignedPreviews.new.querySelector(`[data-row-index="${rowIndex}"]`);
    if (!target) return;
    const top = Math.max(0, target.offsetTop - alignedPreviews.old.clientHeight * 0.42);
    alignedPreviews.old.scrollTop = top;
    alignedPreviews.new.scrollTop = top;
  }

  function jumpToChange(direction) {
    if (!appState.previewMode && appState.comparison) showAlignedPreview(appState.resultFile);
    const changes = changedRowIndexes();
    if (!changes.length) return;
    appState.searchCursor = -1;
    appState.changeCursor = (appState.changeCursor + direction + changes.length) % changes.length;
    refreshSearchMatches(false);
    renderAlignedPanels();
    updateChangeStatus();
    scrollAlignedToRow(changes[appState.changeCursor]);
  }

  function jumpToSearch(direction) {
    if (!appState.previewMode && appState.comparison) showAlignedPreview(appState.resultFile);
    refreshSearchMatches(false);
    const count = appState.searchMatches.length;
    if (!count) return;
    appState.changeCursor = -1;
    appState.searchCursor = (appState.searchCursor + direction + count) % count;
    renderAlignedPanels();
    updateSearchStatus();
    updateChangeStatus();
    scrollAlignedToRow(appState.searchMatches[appState.searchCursor].rowIndex);
  }

  function showAlignedPreview(fileName) {
    if (!appState.comparison?.files[fileName]) return;
    appState.previewMode = true;
    appState.resultFile = fileName;
    appState.activeFile.old = fileName;
    appState.activeFile.new = fileName;
    appState.changeCursor = -1;
    appState.searchCursor = -1;
    refreshSearchMatches(true);

    for (const side of ['old', 'new']) {
      editModes[side].classList.add('hidden');
      alignedPreviews[side].classList.remove('hidden');
      minimaps[side].classList.remove('hidden');
      document.querySelector(`.edit-preview-button[data-side="${side}"]`).classList.remove('hidden');
      renderInputTabs(side);
    }
    renderAlignedPanels();
    updateChangeStatus();
    alignedPreviews.old.scrollTop = 0;
    alignedPreviews.new.scrollTop = 0;
  }

  function exitAlignedPreview(focusSide = '') {
    if (!appState.previewMode) return;
    appState.previewMode = false;
    for (const side of ['old', 'new']) {
      alignedPreviews[side].classList.add('hidden');
      minimaps[side].classList.add('hidden');
      editModes[side].classList.remove('hidden');
      document.querySelector(`.edit-preview-button[data-side="${side}"]`).classList.add('hidden');
      ensureActiveFile(side);
      syncEditor(side);
    }
    if (focusSide) editors[focusSide].focus();
  }

  function statusBadge(status) {
    return `<span class="status-badge ${status}">${status}</span>`;
  }

  function renderFileSummary() {
    const host = document.getElementById('file-summary-list');
    const comparison = appState.comparison;
    if (!comparison) return;
    host.innerHTML = comparison.fileNames.map(name => {
      const file = comparison.files[name];
      return `<button class="file-summary-row${name === appState.resultFile ? ' active' : ''}" data-file="${escapeHtml(name)}">
        ${statusBadge(file.status)}
        <span class="file-summary-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="add-text">+${file.summary.additions}</span>
        <span class="delete-text">-${file.summary.deletions}</span>
        <span class="file-percent">${file.summary.percentage}%</span>
      </button>`;
    }).join('');
    document.getElementById('file-summary-caption').textContent = `${comparison.fileNames.length} file${comparison.fileNames.length === 1 ? '' : 's'} compared`;
  }

  function renderResultTabs() {
    const host = document.getElementById('result-tabs');
    host.innerHTML = '';
    for (const name of appState.comparison.fileNames) {
      const file = appState.comparison.files[name];
      const button = document.createElement('button');
      button.className = `result-tab${appState.resultFile === name ? ' active' : ''}`;
      button.dataset.file = name;
      button.innerHTML = `${escapeHtml(name)} <span class="mini-stat add-text">+${file.summary.additions}</span><span class="mini-stat delete-text">-${file.summary.deletions}</span>`;
      button.addEventListener('click', () => selectResultFile(name));
      host.appendChild(button);
    }
  }

  function displayEntries(file) {
    const base = collapseAlignedRows(file.rows, {
      collapse: appState.collapseUnchanged,
      onlyChanged: appState.onlyChanges,
      context: 3
    });
    const out = [];
    for (const entry of base) {
      if (entry.type !== 'collapse') {
        out.push(entry);
        continue;
      }
      const key = `${file.name}:${entry.start}:${entry.end}`;
      if (appState.expandedBlocks.has(key)) {
        for (let index = entry.start; index <= entry.end; index++) {
          out.push({ type: 'row', row: file.rows[index], index });
        }
      } else {
        out.push({ ...entry, key });
      }
    }
    return out;
  }

  function unifiedCode(row, side) {
    if (row.kind === 'modify') return renderWordLevel(row, side);
    const cell = row[side];
    return cell ? renderSearchMarkedText(cell.text, searchInput.value.trim()) : ' ';
  }

  function unifiedRowHtml(row, rowIndex) {
    if (row.kind === 'equal') {
      return `<tr class="diff-row equal" data-row-index="${rowIndex}"><td class="line-number">${row.old?.lineNumber ?? ''}</td><td class="line-number">${row.new?.lineNumber ?? ''}</td><td class="line-marker"> </td><td class="line-code">${unifiedCode(row, 'new')}</td></tr>`;
    }
    if (row.kind === 'modify') {
      return `<tr class="diff-row modify-old" data-row-index="${rowIndex}"><td class="line-number">${row.old.lineNumber}</td><td class="line-number"></td><td class="line-marker">-</td><td class="line-code">${unifiedCode(row, 'old')}</td></tr>
      <tr class="diff-row modify-new" data-row-index="${rowIndex}"><td class="line-number"></td><td class="line-number">${row.new.lineNumber}</td><td class="line-marker">+</td><td class="line-code">${unifiedCode(row, 'new')}</td></tr>`;
    }
    if (row.kind === 'delete') {
      return `<tr class="diff-row delete" data-row-index="${rowIndex}"><td class="line-number">${row.old.lineNumber}</td><td class="line-number"></td><td class="line-marker">-</td><td class="line-code">${unifiedCode(row, 'old')}</td></tr>`;
    }
    return `<tr class="diff-row add" data-row-index="${rowIndex}"><td class="line-number"></td><td class="line-number">${row.new.lineNumber}</td><td class="line-marker">+</td><td class="line-code">${unifiedCode(row, 'new')}</td></tr>`;
  }

  function renderUnified(file) {
    if (file.binary) return `<div class="binary-change"><strong>${escapeHtml(file.name)}</strong>Binary file ${file.status}. Raw contents are not displayed.</div>`;
    if (!file.changed) return '<div class="no-change">No changes in this file.</div>';
    const entries = displayEntries(file);
    if (!entries.length) return '<div class="no-change">No changed lines match the current filters.</div>';
    const body = entries.map(entry => {
      if (entry.type === 'collapse') {
        return `<tr class="collapse-row"><td colspan="4"><button class="expand-block" data-collapse-key="${escapeHtml(entry.key)}">⋯ ${entry.count} unchanged line${entry.count === 1 ? '' : 's'} — click to expand</button></td></tr>`;
      }
      return unifiedRowHtml(entry.row, entry.index);
    }).join('');
    return `<table class="diff-table" aria-label="Unified line diff"><tbody>${body}</tbody></table>`;
  }

  function splitCells(row, side) {
    const cell = row[side];
    if (!cell) return `<td class="empty-cell split-number"></td><td class="empty-cell split-marker"></td><td class="empty-cell split-code${side === 'new' ? ' split-divider' : ''}"></td>`;
    const changeClass = cell.type === 'delete' ? ' delete-cell' : cell.type === 'add' ? ' add-cell' : '';
    const modifyClass = row.kind === 'modify' ? ' modify-cell' : '';
    const marker = cell.type === 'delete' ? '-' : cell.type === 'add' ? '+' : ' ';
    const code = row.kind === 'modify' ? renderWordLevel(row, side) : renderSearchMarkedText(cell.text, searchInput.value.trim());
    return `<td class="split-number${changeClass}${modifyClass}">${cell.lineNumber}</td><td class="split-marker${changeClass}${modifyClass}">${marker}</td><td class="split-code${side === 'new' ? ' split-divider' : ''}${changeClass}${modifyClass}">${code || ' '}</td>`;
  }

  function renderSplit(file) {
    if (file.binary) return `<div class="binary-change"><strong>${escapeHtml(file.name)}</strong>Binary file ${file.status}. Raw contents are not displayed.</div>`;
    if (!file.changed) return '<div class="no-change">No changes in this file.</div>';
    const entries = displayEntries(file);
    if (!entries.length) return '<div class="no-change">No changed lines match the current filters.</div>';
    const body = entries.map(entry => {
      if (entry.type === 'collapse') {
        return `<tr class="collapse-row"><td colspan="6"><button class="expand-block" data-collapse-key="${escapeHtml(entry.key)}">⋯ ${entry.count} unchanged line${entry.count === 1 ? '' : 's'} — click to expand</button></td></tr>`;
      }
      return `<tr class="diff-row" data-row-index="${entry.index}">${splitCells(entry.row, 'old')}${splitCells(entry.row, 'new')}</tr>`;
    }).join('');
    return `<table class="diff-table split-table" aria-label="Split line diff"><tbody>${body}</tbody></table>`;
  }

  function renderCurrentDiff() {
    const file = currentFile();
    if (!file) return;
    document.getElementById('diff-filename').textContent = file.name;
    const statusHost = document.getElementById('diff-file-status');
    statusHost.textContent = file.status;
    statusHost.className = `status-badge ${file.status}`;
    document.getElementById('file-additions').textContent = `+${file.summary.additions}`;
    document.getElementById('file-deletions').textContent = `-${file.summary.deletions}`;
    document.getElementById('file-percentage').textContent = `${file.summary.percentage}% changed`;
    diffOutput.innerHTML = appState.view === 'split' ? renderSplit(file) : renderUnified(file);
  }

  function selectResultFile(name) {
    if (!appState.comparison?.files[name]) return;
    appState.resultFile = name;
    appState.expandedBlocks.clear();
    appState.changeCursor = -1;
    appState.searchCursor = -1;
    refreshSearchMatches(true);
    renderResultTabs();
    renderFileSummary();
    renderCurrentDiff();
    if (appState.previewMode) showAlignedPreview(name);
  }

  function renderComparison() {
    if (!appState.previewMode) {
      saveEditor('old');
      saveEditor('new');
    }
    appState.ignoreWhitespace = document.getElementById('ignore-whitespace').checked;
    appState.comparison = buildComparison(appState.old, appState.new, { ignoreWhitespace: appState.ignoreWhitespace });
    const firstChanged = appState.comparison.fileNames.find(name => appState.comparison.files[name].changed);
    appState.resultFile = firstChanged || appState.comparison.fileNames[0] || 'index.html';
    appState.expandedBlocks.clear();
    appState.changeCursor = -1;
    appState.searchCursor = -1;

    const total = appState.comparison.total;
    document.getElementById('files-changed').textContent = total.filesChanged;
    document.getElementById('total-additions').textContent = `+${total.additions}`;
    document.getElementById('total-deletions').textContent = `-${total.deletions}`;
    document.getElementById('total-logical-changed').textContent = total.logicalChanged;
    document.getElementById('total-modified').textContent = total.modified;
    document.getElementById('total-percentage').textContent = `${total.percentage}%`;

    resultsPlaceholder.classList.add('hidden');
    resultsContent.classList.remove('hidden');
    renderResultTabs();
    renderFileSummary();
    refreshSearchMatches(true);
    renderCurrentDiff();
    showAlignedPreview(appState.resultFile);
    const whitespaceNote = appState.ignoreWhitespace ? ' Whitespace-only edits are ignored.' : '';
    setStatus(total.filesChanged
      ? `Comparison complete: ${total.filesChanged} file${total.filesChanged === 1 ? '' : 's'} changed.${whitespaceNote}`
      : `Comparison complete: no differences found.${whitespaceNote}`, 'success');
  }

  async function copyPatch() {
    const patch = generatePatch(appState.old, appState.new);
    if (!patch) {
      setStatus('There is no patch to copy.', 'warning');
      return;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(patch);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = patch;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setStatus('Patch copied to clipboard.', 'success');
    } catch {
      setStatus('Could not access the clipboard. Use Download .diff instead.', 'error');
    }
  }

  function downloadPatch() {
    const patch = generatePatch(appState.old, appState.new);
    if (!patch) {
      setStatus('There is no patch to download.', 'warning');
      return;
    }
    const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'commit-1-to-commit-2.diff';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus('Diff file created.', 'success');
  }

  Object.entries(editors).forEach(([side, editor]) => {
    editor.addEventListener('input', () => {
      saveEditor(side);
      markComparisonStale();
    });
    editor.addEventListener('scroll', () => {
      gutters[side].scrollTop = editor.scrollTop;
    });
    editor.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
        editor.selectionStart = editor.selectionEnd = start + 2;
        saveEditor(side);
        markComparisonStale();
      }
    });
  });

  document.querySelectorAll('.file-button').forEach(button => {
    button.addEventListener('click', () => document.querySelector(`.file-input[data-side="${button.dataset.side}"]`).click());
  });

  document.querySelectorAll('.folder-button').forEach(button => {
    button.addEventListener('click', () => document.querySelector(`.folder-input[data-side="${button.dataset.side}"]`).click());
  });

  document.querySelectorAll('.file-input').forEach(input => {
    input.addEventListener('change', async () => {
      await loadFileRecords(input.dataset.side, recordsFromFileList(input.files), { replace: false, stripRoot: false });
      input.value = '';
    });
  });

  document.querySelectorAll('.folder-input').forEach(input => {
    input.addEventListener('change', async () => {
      await loadFileRecords(input.dataset.side, recordsFromFileList(input.files), { replace: true, stripRoot: true });
      input.value = '';
    });
  });

  document.querySelectorAll('.clear-button').forEach(button => button.addEventListener('click', () => clearSide(button.dataset.side)));
  document.querySelectorAll('.edit-preview-button').forEach(button => button.addEventListener('click', () => exitAlignedPreview(button.dataset.side)));

  document.querySelectorAll('[data-drop-side]').forEach(card => {
    const side = card.dataset.dropSide;
    let dragDepth = 0;

    card.addEventListener('dragenter', event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth++;
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      card.classList.add('dragging');
    });

    card.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      card.classList.add('dragging');
    });

    card.addEventListener('dragleave', event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) card.classList.remove('dragging');
    });

    card.addEventListener('drop', async event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      card.classList.remove('dragging');
      setStatus(`Reading dropped files for ${side === 'old' ? 'Commit 1' : 'Commit 2'}...`);
      try {
        const records = await collectDroppedRecords(event.dataTransfer);
        const hasNestedPaths = records.some(record => sanitizeRelativePath(record.path).includes('/'));
        await loadFileRecords(side, records, { replace: hasNestedPaths, stripRoot: hasNestedPaths });
      } catch (error) {
        setStatus(error.message || 'Could not read dropped files or folder.', 'error');
      }
    });
  });

  document.querySelectorAll('.view-button').forEach(button => {
    button.addEventListener('click', () => {
      appState.view = button.dataset.view;
      document.querySelectorAll('.view-button').forEach(item => item.classList.toggle('active', item === button));
      renderCurrentDiff();
    });
  });

  document.getElementById('file-summary-list').addEventListener('click', event => {
    const row = event.target.closest('.file-summary-row');
    if (row) selectResultFile(row.dataset.file);
  });

  diffOutput.addEventListener('click', event => {
    const button = event.target.closest('[data-collapse-key]');
    if (!button) return;
    appState.expandedBlocks.add(button.dataset.collapseKey);
    renderCurrentDiff();
  });

  for (const side of ['old', 'new']) {
    minimaps[side].addEventListener('click', event => {
      const mark = event.target.closest('[data-row-index]');
      if (!mark) return;
      const rowIndex = Number(mark.dataset.rowIndex);
      const changes = changedRowIndexes();
      appState.changeCursor = changes.indexOf(rowIndex);
      appState.searchCursor = -1;
      renderAlignedPanels();
      updateChangeStatus();
      scrollAlignedToRow(rowIndex);
    });
  }

  document.getElementById('previous-change').addEventListener('click', () => jumpToChange(-1));
  document.getElementById('next-change').addEventListener('click', () => jumpToChange(1));
  document.getElementById('previous-search').addEventListener('click', () => jumpToSearch(-1));
  document.getElementById('next-search').addEventListener('click', () => jumpToSearch(1));

  searchInput.addEventListener('input', () => {
    appState.searchCursor = -1;
    refreshSearchMatches(true);
    renderAlignedPanels();
    renderCurrentDiff();
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToSearch(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Escape') {
      searchInput.value = '';
      appState.searchCursor = -1;
      refreshSearchMatches(true);
      renderAlignedPanels();
      renderCurrentDiff();
    }
  });

  document.getElementById('collapse-unchanged').addEventListener('change', event => {
    appState.collapseUnchanged = event.target.checked;
    appState.expandedBlocks.clear();
    renderCurrentDiff();
  });
  document.getElementById('only-changes').addEventListener('change', event => {
    appState.onlyChanges = event.target.checked;
    appState.expandedBlocks.clear();
    renderCurrentDiff();
  });
  document.getElementById('ignore-whitespace').addEventListener('change', () => {
    if (appState.comparison) renderComparison();
  });

  document.getElementById('swap-button').addEventListener('click', swapCommits);
  document.getElementById('compare-button').addEventListener('click', renderComparison);
  document.getElementById('copy-patch').addEventListener('click', copyPatch);
  document.getElementById('download-patch').addEventListener('click', downloadPatch);

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      renderComparison();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && appState.comparison) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.altKey && event.key === 'ArrowDown' && appState.comparison) {
      event.preventDefault();
      jumpToChange(1);
    }
    if (event.altKey && event.key === 'ArrowUp' && appState.comparison) {
      event.preventDefault();
      jumpToChange(-1);
    }
  });

  let syncingPreviewScroll = false;
  Object.entries(alignedPreviews).forEach(([side, preview]) => {
    preview.addEventListener('scroll', () => {
      if (syncingPreviewScroll) return;
      syncingPreviewScroll = true;
      const otherSide = side === 'old' ? 'new' : 'old';
      alignedPreviews[otherSide].scrollTop = preview.scrollTop;
      syncingPreviewScroll = false;
    });
  });

  syncEditor('old');
  syncEditor('new');
}
