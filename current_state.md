# Codebase State Assessment (Feb 2026)

## Codebase Stats
- ~30 files, ~14,000 lines in `src/js/`
- 324 tests passing
- Vendored libs: highlight.js, minisearch, markdown-it, KaTeX, markdown-it-texmath

---

## Recently Completed

### Markdown + LaTeX Rendering (current branch)
- Replaced hand-rolled `formatContent()` (only code blocks + links) with **markdown-it** + **KaTeX** + **markdown-it-texmath**
- Full markdown support: bold, italic, headers, tables, lists, blockquotes, inline code, horizontal rules, links
- LaTeX math: `$...$`, `$$...$$`, `\(...\)`, `\[...\]` rendered via KaTeX
- Code blocks: syntax highlighting via highlight.js integrated into markdown-it's `highlight` option (no post-processing pass)
- **Streaming**: `StreamWriter` now re-renders full accumulated text as markdown on each animation frame — formatting appears live during streaming, not just at the end
- Security: `html: false`, images disabled, links forced to `target="_blank"`
- Fallback: if markdown-it fails to load, falls back to legacy formatter; `md.render()` wrapped in try/catch
- Dark-theme CSS for all markdown elements (tables, blockquotes, headers, lists, etc.)
- Vendored: `vendor/markdown-it/`, `vendor/katex/` (JS + CSS + fonts), `vendor/markdown-it-texmath/`
- Files modified: `ui_utils.js`, `StreamWriter.js`, `chat_ui.js`, `layout.css`, `sidepanel.html`, `history.html`
- Removed: `highlightCodeBlocks()` function and all calls to it (highlighting now happens during markdown parsing)

### Live History Updates (commit 4328afe)
- Serialized queue for history updates, stable message-id targeting, correct append index

### Thinking Block Cleanup (commit 5f4b4a2)
- Strip empty thinking blocks from UI via CSS `:empty` + whitespace normalization

### Opus 4.6 Thinking Fixes (commits e70ce3a, 10e9dd3, 743f305)
- Fixed adaptive thinking for Opus 4.6: effort in `output_config`, default to high
- Added OpenAI reasoning summaries
- Fixed scroll disengage, stop button swap, stale render buffers

### State Management Flatten (commit 1cc6b32)
- Flattened state management, deduplicated TabState, unified proxies

### Performance + Dead Code (commit 8c6c5d5)
- Performance improvements, dead code cleanup, provider simplification

### UX Flow Cleanup (commit 2af0a38)
- Autoscroll: centralized, 150px grace threshold, reset on new chat
- Regeneration: latest-only enforcement, completed arena whole-message regen
- Continue-from: council block-level continue, consolidated logic paths
- Structural: `initApiCall` split into `runCouncilFlow`/`runArenaFlow`/`runNormalFlow`

### New Models (commit 061e28e)
- Claude Opus 4.6 with adaptive thinking (`thinking: { type: "adaptive", effort }`)
- GPT 5.3 Codex (drop-in)
- Effort level mapping: minimal→low, xhigh→max
- Opus 4.6 uses reasoning level cycling UI (not toggle)

### Council Refactor (commit f9f01d7)
- Migrated council responses from `{ messages: [[...parts]] }` to `{ parts: [...parts] }` (flat)
- Thought content sanitized in `getMessagesForAPI`
- Collector prompt rewritten with full conversation history

---

## Performance Issues (by impact)

### P0: Streaming Response Performance
Partially addressed by markdown rendering rewrite. Remaining:

1. **Layout thrashing per token** (`StreamWriter.js`, `chat_ui.js`)
   - Scroll checks still read `scrollHeight`/`clientHeight`/`scrollTop` then write — forces reflow per frame
   - Mitigated: now batched to rAF (one reflow per frame, not per token)

2. **Character-level queue splitting** (`StreamWriter.js` arena mode)
   - `content.split("")` + `splice(0, charCount).join('')` is O(n) per frame
   - Fix: chunk-based queue with read offset instead of char array

### P1: `buildChat()` blocks UI on chat load
- Synchronous rendering of entire conversation
- `formatContent` (now markdown-it) + highlight on every message, all synchronous
- Fix: DocumentFragment batching, async/deferred rendering

### P2: `updateTextfieldHeight` double reflow
- Sets height to `auto` (invalidates layout), reads `scrollHeight` (forces reflow)
- Called on every input event
- Fix: single reflow read, debounce during batch updates

### P3: Redundant provider resolution
- `resolveProvider()` iterates all providers/models, called 3+ times per API call
- Fix: memoize or resolve once at call site

---

## Complexity Issues (by impact)

### C1: God Files
- `history.js` (~2,100 lines) — 4 unrelated classes
- `chat_ui.js` (~2,200 lines) — 3 classes
- `chat_storage.js` (~1,400 lines) — CRUD + blob management + media + search + import/export
- Fix: split into focused modules

### C2: OpenAI-Compatible Provider Duplication
- `LLMProviders.js` (~1,000 lines) — DeepSeek, Grok, Kimi, LlamaCpp all parse identically
- Fix: `OpenAICompatibleProvider` base class

### C3: Duplicate `normaliseForSearch`
- `ChatStorage.normaliseForSearch` and `ChatSearch.normaliseForSearch` — identical logic
- Fix: shared utility function

---

## Backwards Compatibility Code

- `migrations.js:46-172` — v1 to v3 message format migration
- `chat_storage.js` — `runPendingMigration()` blob scan on startup
- Import flow v3 migration for old archives
- `ArenaRatingManager.js` — `matches_count` to `count` field rename fallback
