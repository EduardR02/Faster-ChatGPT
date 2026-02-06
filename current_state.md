# Codebase State Assessment (Feb 2026)

## Codebase Stats
- 27 files, ~13,238 lines in `src/js/`
- 293 tests passing

---

## Performance Issues (by impact)

### P0: Streaming Response Performance
Three compounding issues in `StreamWriter.js`:

1. **Layout thrashing per token** (`StreamWriter.js:124`, `chat_ui.js:1203-1218`)
   - `scrollIntoView()` called on every SSE event in `StreamWriterSimple`
   - Reads `scrollHeight`/`clientHeight`/`scrollTop` then writes `scrollTop` — forces browser reflow per token
   - Fix: batch scroll calls to rAF, check `shouldScroll` before any DOM read

2. **Character-level queue splitting** (`StreamWriter.js:214,264`)
   - `content.split("")` explodes every chunk into individual character strings
   - `splice(0, charCount).join('')` removes from front of array — O(n) per frame
   - Over ~8000 chars: 8000+ allocations + O(n) splices
   - Fix: chunk-based queue with read offset instead of char array + front-splice

3. **No DOM write batching** (`StreamWriter.js:122-124`)
   - `StreamWriterSimple.processContent()` appends text + triggers scroll on every token
   - Fix: accumulate content, flush on rAF

### P1: `buildChat()` blocks UI on chat load
- `chat_ui.js:146-222` — synchronous rendering of entire conversation
- `formatContent` (regex-heavy HTML) + `hljs.highlightElement` on every code block, all synchronous
- No `DocumentFragment`, no yielding to event loop
- Impact: 200-500ms+ freeze on conversations with 10+ code blocks
- Fix: DocumentFragment batching, async/deferred syntax highlighting

### P2: `updateTextfieldHeight` double reflow
- `ui_utils.js:97-108` — sets height to `auto` (invalidates layout), reads `scrollHeight` (forces reflow), reads again
- Called on every input event + multiple places during settings changes
- Fix: single reflow read, debounce during batch updates

### P3: Redundant provider resolution
- `api_manager.js:41-64` — `resolveProvider()` iterates all providers/models, called 3+ times per API call for same model
- Fix: memoize or resolve once at call site

### P4: Redundant `chrome.storage.local.get` on startup
- 3-4 parallel `chrome.storage.local.get` calls reading overlapping data (separate `SettingsManager` instances in `SidepanelStateManager`, `ApiManager`, `RenameManager`)
- Fix: single shared settings load, or single `SettingsManager` instance

### P5: Image hashing on main thread
- `chat_storage.js:136-142` — `TextEncoder.encode()` on large base64 strings (1-5MB) is synchronous
- Fix: offload to worker, or hash in chunks

---

## Dead Code (zero-risk removals)

### Dead Files
- `src/js/PromptStorage.js` (78 lines) — never imported anywhere. Prompt storage uses `chrome.storage.local`.

### Dead Exports in `storage_utils.js`
- `getStoredModels()` (line 81) — never imported
- `addModelToStorage()` (line 92) — never imported, settings uses `SettingsStateManager.addModel()`
- `removeModelFromStorage()` (line 105) — never imported

### Dead Method
- `ChatStorage.tokenizeForMiniSearch` (`chat_storage.js:655`) — identical copy exists in `history.js:1178`, this one never called

### Dead State Manager Methods (~170 lines)
- `ArenaStateManager` methods (lines 354-426) — shadowed by `TabState` via Proxy delegation
- `SidepanelStateManager` toggle/cycling methods (lines 561-699) — same, all shadowed by `TabState`
- The Proxy in `sidepanel.js:160-185` and `tab_manager.js:128-157` always hits `TabState` first, making these unreachable

### Dead CSS (~60 lines)
- `.thinking-mode { }` — empty rule (`layout.css:1518`)
- `.pill-button.is-danger` + `.is-active` — never applied (`layout.css:1718-1726`)
- `.reindex-busy/success/failure/prompt` — never toggled in JS (`layout.css:1450-1467`)
- `.history-title` — not in any HTML or JS (`layout.css:754-759`)
- `.media-panel[data-state="migrating"]` — `migrating` never set as state (`layout.css:1742,1759,1798,1814`)
- `content:` on `.media-status-title` div — only works on `::before`/`::after` pseudo-elements (`layout.css:1810-1824`)
- `.clearfix` — no floats exist, layout is flexbox (`layout.css:1620-1622`)

### Dead HTML
- `<div class="clearfix">` in `popup.html:17` and `settings.html:158` — vestigial

### Dead API Manager Defaults
- Constructor fallback getters (`api_manager.js:31-36`) — `callApi` always spreads direct values from caller

---

## Complexity Issues (by impact)

### C0: State Manager Duplication and Dead Inheritance
- `TabState` (249 lines) was copy-pasted from `SidepanelStateManager`
- Both have identical: thinking state, toggles, cycling, arena/council management
- The Proxy makes `SidepanelStateManager`'s versions unreachable (dead code above)
- `ArenaStateManager` exists as unnecessary inheritance middle layer
- `HistoryStateManager` inherits arena/council infrastructure it never uses
- Fix: extract shared state logic into composable mixin, flatten inheritance, delete shadowed methods

### C1: God Files
- `history.js` (2,132 lines) — 4 unrelated classes: `PopupMenu`, `MediaTab`, `ChatSearch`, page init
- `chat_ui.js` (2,212 lines) — 3 classes: `ChatUI`, `SidepanelChatUI`, `HistoryChatUI`
- `chat_storage.js` (1,361 lines) — CRUD + blob management + media indexing + thumbnails + search docs + import/export + image repair
- Fix: split into focused modules

### C2: OpenAI-Compatible Provider Duplication
- `LLMProviders.js` (1,007 lines) — DeepSeek, Grok, Kimi, LlamaCpp all parse `choices[0].delta.content` and `choices[0].delta.reasoning_content` identically
- Each has near-identical `formatMessages`, `handleStream`, `handleResponse`
- Fix: `OpenAICompatibleProvider` base class, providers override only what differs

### C3: Duplicate Proxy Implementations
- `sidepanel.js:160` and `tab_manager.js:128` — two slightly different Proxy implementations for state delegation
- Fix: single `createStateProxy` factory

### C4: Over-engineered `rename_manager.js`
- 3-level class hierarchy (176 lines) for what is essentially one function with a config flag
- Fix: collapse to single class or function

### C5: Duplicate `normaliseForSearch`
- `ChatStorage.normaliseForSearch` (`chat_storage.js:646`) and `ChatSearch.normaliseForSearch` (`history.js:1577`)
- Identical logic, both actively used
- Fix: shared utility function

---

## Backwards Compatibility Code (policy decisions needed)

- `migrations.js:46-172` — v1 to v3 message format migration. Still runs for users upgrading from very old versions.
- `chat_storage.js:250-319` — `runPendingMigration()` blob scan on every startup. Could skip with completion flag.
- `chat_storage.js:1179-1299` — import flow v3 migration for old archives.
- `ArenaRatingManager.js:142` — `matches_count` to `count` field rename fallback.

---

## Recently Completed (this session)

### Council Refactor (commit f9f01d7)
- Migrated council responses from `{ messages: [[...parts]] }` to `{ parts: [...parts] }` (flat)
- Thought content sanitized in `getMessagesForAPI`
- Collector prompt rewritten with full conversation history
- State key fix: `council_collector` to `council_collector_prompt`
- `stripEphemeral` fixed for council thoughtSignature stripping
- Removed dead `ThinkingChat.addCouncilMessage`
- Null guards on `sanitizePart`, council contents init `[]` not `[[]]`

### New Models (commit 061e28e)
- Added Claude Opus 4.6 with adaptive thinking (`thinking: { type: "adaptive", effort }`)
- Added GPT 5.3 Codex (drop-in)
- Effort level mapping: minimal to low, xhigh to max
- Opus 4.6 uses reasoning level cycling UI (not toggle)

### UX Flow Cleanup (commit 2af0a38)
- Autoscroll: centralized, 150px grace threshold, reset on new chat
- Regeneration: latest-only enforcement, completed arena whole-message regen, council regen on reconstruct
- Continue-from: council block-level continue, consolidated logic paths
- Structural: `initApiCall` split into `runCouncilFlow`/`runArenaFlow`/`runNormalFlow`
