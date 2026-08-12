# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BTW — Side Thread**: a SillyTavern third-party extension that adds a floating out-of-character
side chat. The user asks questions *about* the story (lore, continuity, NPC design) without adding
anything *to* it. The side thread receives the same world the roleplay does — character card,
persona, lorebooks, chat history — but nothing it says or sees is ever written into the chat file,
the chat metadata or the main prompt.

## No build step

There is no `package.json`, bundler, linter config or test suite. The files ship as-is: SillyTavern
loads `index.js` as a native ES module (per `manifest.json`) and `style.css` as a stylesheet.

Development loop:

1. Edit files in place under a SillyTavern install at
   `data/<user>/extensions/SillyTavern-SideThread/` (or symlink this repo there).
2. Hard-reload the SillyTavern browser tab. There is nothing to compile.
3. Enable **Panel → Debug logging** in the extension settings for `debugLog()` output, or use the
   console handle `globalThis.btwSideThread` (`{ ask, openPanel, closePanel, togglePanel, isPanelOpen }`).

Type checking is via JSDoc annotations only (`@param`, `@returns`, `/** @type {any} */` casts).
Follow that convention — every exported function is annotated. Prefer
`mcp__ide__getDiagnostics` over any shell-based type check.

## Architecture

`index.js` is bootstrap only: it waits for SillyTavern's DOM containers to exist (extension scripts
can load before `#extensions_settings2` and `#extensionsMenu` do — see `waitFor()`), mounts the
settings drawer, adds the wand-menu button, registers `/btw` (aliases `/side`, `/ooc`), and wires
`CHAT_CHANGED`.

Modules under `src/`, roughly in data-flow order:

| Module | Responsibility |
| --- | --- |
| `settings.js` | `DEFAULTS` + `DEFAULT_SYSTEM_PROMPT`, `getSettings()`, `saveSettings()`, `debugLog()` |
| `context.js` | Assembles the system prompt from live ST state; `buildContext()`, `countTokens()` |
| `thread.js` | Per-chat transcripts in localStorage; `threadForRequest()` window |
| `llm.js` | `sendSideRequest()` dispatch across four backends; `canStream()` / `canAbort()` |
| `panel.js` | The floating panel: transcript, composer, streaming, message actions |
| `geometry.js` | Drag, corner resize, viewport-clamped geometry persistence |
| `markdown.js` | Deliberately minimal markdown → safe HTML; `extractCodeBlocks()` |
| `lorebook.js` | Writes an answer back out as a World Info entry |
| `settings-ui.js` | Binds `settings.html` to the settings store |

### Everything goes through `SillyTavern.getContext()`

Each module has a local `function ctx() { return SillyTavern.getContext(); }`. Core module paths
move between SillyTavern releases; the context object does not. **Never** add a static import from
`../../../` — call it off the context and degrade gracefully when a member is missing
(`typeof context.getWorldInfoPrompt !== 'function'` → return no sections, don't throw).

### Two storage tiers, on purpose

- `extensionSettings.btwSideThread` (via `getSettings()`) — travels with the user's ST settings.
  Config, system prompt, connection details.
- `localStorage` — per-device, not per-account: panel geometry (`btw_panel_geometry`), open/collapsed
  flags, and the side-thread transcripts (`btw_threads_v1`, LRU-capped by chat count and total chars).

Transcripts are in localStorage **specifically so they can never reach chat metadata**, the exported
chat file, or ST's own prompt builder. Do not move them into `chatMetadata`.

### Context assembly (`context.js`)

`buildContext()` returns `{ systemPrompt, sections, chars }`. Sections are rendered with
`--- TITLE ---` / `--- END TITLE ---` delimiters and appended after the user's system prompt. The
`sections` array is what the eye-icon preview tabulates, so any new context source should be a
`Section` rather than string concatenation.

Things worth knowing before touching it:

- `ensureCardsLoaded()` first — cards are "shallow" (metadata only) right after a page load.
- Solo chats use `getCharacterCardFields()` so chat-level overrides and macros resolve; group chats
  read raw member cards and stay deliberately terser (eight full cards drown everything else).
- Lore mode `activated` calls `getWorldInfoPrompt(scanChat, maxContext, true)` — the trailing `true`
  is **dry-run**, so no `WORLD_INFO_ACTIVATED` events fire and sticky/cooldown state is untouched.
  The scanner wants newest-first plain strings.
- Lore mode `full` walks every bound book (character, group members, chat, persona, the
  `#world_info` multiselect for the global selection, plus the card-embedded `data.character_book`)
  against a character budget, and emits a truncation notice when it runs out.
- The global lorebook selection is *not* on the context object — it is read from the DOM.

### Backends (`llm.js`)

`settings.connectionSource` selects one of four paths. They differ in capability, and the panel
adapts through `canStream()` / `canAbort()`:

- `profile` — `ConnectionManagerRequestService.sendRequest`. Silent, streams, abortable. In
  streaming mode it returns a **generator factory**, and each chunk carries the full accumulated
  text, not a delta. A preset override mutates `profile.preset` and restores it in `finally`.
- `default` — `generateRaw` against the active main API. Single prompt string, so the thread is
  flattened into an `Author:`/`Assistant:` transcript. No streaming, no abort. `trimNames: false`
  is load-bearing: ST's default name trimming silently discards a whole response that starts with a
  character name, which is exactly what an NPC draft does.
- `ollama` — direct `POST /api/chat` from the browser (needs `OLLAMA_ORIGINS`).
- `openai` — direct `POST /chat/completions` with a hand-rolled SSE reader.

`extractText()` exists because replies arrive in many shapes; it also falls back to a `reasoning`
field, since some reasoning models return only that when `max_tokens` is tight. Add new shapes there
rather than at call sites.

### Rendering (`markdown.js`)

ST's own `messageFormatting()` is **avoided deliberately** — it substitutes macros and runs the
user's roleplay regex scripts, which mangles lorebook drafts and code fences. This renderer escapes
first, extracts fences before inline formatting, and passes the result through `DOMPurify` when
available. Keep the "escape, then build" order: `renderMarkdown()` callers pass raw error messages
straight in and rely on it.

Streaming patches a single bubble via `updateMessageBody()` instead of re-rendering the transcript,
and only auto-scrolls when the user is already pinned within 48px of the bottom.

### Lorebook writes (`lorebook.js`)

Entry shape changes between ST releases, so a new entry is cloned from an existing entry in the
target book and only falls back to `FALLBACK_ENTRY` for empty books. A keyword entry with no keys
would never fire, so it is saved `disable: true` and the toast says why. Naming an unknown book
creates it (`saveWorldInfo` + `updateWorldInfoList`).

### Panel geometry (`geometry.js`)

Pointer-capture drag on the header, two corner resizers. Saved geometry is clamped on every apply so
a panel restored on a smaller screen keeps its header reachable. Below 800px the panel is a
CSS-driven near-fullscreen sheet: `applyGeometry()` strips inline styles, `saveGeometry()` no-ops,
and `restoreIfPreviouslyOpen()` refuses to auto-open. The `ResizeObserver` skips its **first**
callback — it fires before restored geometry is painted and would otherwise persist the CSS default
over the saved position.

## Conventions

- All CSS classes, DOM ids and localStorage keys are prefixed `btw-` / `btw_`. `LOG_PREFIX` is `[BTW]`.
- 4-space indent, single quotes, semicolons, trailing commas in multi-line literals.
- Section comments use the box-drawing form: `// ── Name ─────────`.
- Settings fields are wired declaratively: add the control to `settings.html` with a `btw-`-prefixed
  id, the default to `DEFAULTS` in `settings.js`, and one `bindField(root, '#btw-…', 'key')` line in
  `bindSettingsUi()`. `bindField` infers checkbox/number/text handling from the element.
- Reuse ST's UI primitives in `settings.html` and dialogs (`text_pole`, `inline-drawer`,
  `callGenericPopup` with `POPUP_TYPE` / `POPUP_RESULT`, `toastr`) so the extension inherits the theme.
- Failures degrade: `debugLog()` and return empty, or `toast(..., 'error')`. Never let a missing
  context member break panel rendering.

## Invariants

Break these and the extension stops being what it is:

1. Nothing from the side thread is written to `chat`, `chatMetadata`, or the main generation prompt.
2. Reading context must not mutate main-chat state — hence dry-run World Info scanning.
3. The user's edited `systemPrompt` is never overwritten by a new default; **Restore default prompt**
   is the only path that replaces it.
