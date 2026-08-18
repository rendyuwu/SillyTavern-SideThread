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
| `settings.js` | `DEFAULTS`, `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_BUDDY_VOICE`, `DEFAULT_AUDIT_PROMPT`, `PUSHBACK_ORDERS`, `getSettings()`, `saveSettings()`, `debugLog()` |
| `context.js` | Assembles the system prompt from live ST state; `buildContext()`, `countTokens()` |
| `thread.js` | Per-chat transcripts in localStorage; `threadForRequest()` window |
| `llm.js` | `sendSideRequest()` dispatch across four backends; `canStream()` / `canAbort()` |
| `panel.js` | The floating panel: transcript, composer, streaming, message actions, rewind |
| `geometry.js` | Drag, corner resize, viewport-clamped geometry persistence |
| `markdown.js` | Deliberately minimal markdown → safe HTML; `extractCodeBlocks()` |
| `lorebook.js` | Writes an answer back out as a World Info entry |
| `audit.js` | Stale-lore audit: batches reference material, proves coverage; read-only |
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

Section order is load-bearing at both ends. `SIDE THREAD PERSONA` (name + `buddyVoice`) comes first,
so the partner's identity sits directly under the task instructions. `STANDING ORDERS` (the
`pushback` dial, via `PUSHBACK_ORDERS`) comes **last**: an instruction to contradict the author loses
to the model's own agreeableness when it sits thousands of tokens upstream of the question. The
personality is deliberately three small settings rather than prose inside `systemPrompt`, so editing
one does not freeze the other at its old default (see invariant 3).

Things worth knowing before touching it:

- `ensureCardsLoaded()` first — cards are "shallow" (metadata only) right after a page load.
- `buildSummarySection()` reads the Summarize extension's running summary off the newest message
  carrying `extra.memory`. Without it everything before the history window is invisible, and
  continuity checks fail quietly rather than loudly on a long chat.
- Solo chats use `getCharacterCardFields()` so chat-level overrides and macros resolve; group chats
  read raw member cards and stay deliberately terser (eight full cards drown everything else).
- Lore mode `activated` calls `getWorldInfoPrompt(scanChat, maxContext, true)` — the trailing `true`
  is **dry-run**, so no `WORLD_INFO_ACTIVATED` events fire and sticky/cooldown state is untouched.
  The scanner wants newest-first plain strings.
- Lore mode `full` walks every bound book (character, group members, chat, persona, and the
  `#world_info` multiselect for the global selection) against a character budget, and emits a
  truncation notice when it runs out. The card-embedded `data.character_book` is **not** among them —
  see the audit notes below for why reading it is always either redundant or misleading.
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

### Rewind: regenerate and edit-and-resend (`panel.js`)

Both ways of taking a turn back run through `rewindTo(index, replacedIndex, label)`: regenerating an
answer re-asks the question above it, editing a user message resends the new text. Truncation *is*
the model — there are no branches and no swipes. Cut to `messages.slice(0, index)`, then
`ask(…, { keepUndo: true })`.

- The confirmation is keyed on the **tail** (`replacedIndex + 1` onwards), not on the total dropped:
  the answer being replaced was going to be replaced anyway. Redoing the newest answer stays one
  click, while reaching four exchanges back says how many messages go and how many of them are audit
  reports.
- **One undo snapshot, in memory only** (`undoStash`). Persisting it would put a second copy of the
  thread inside the 1.5 MB cap, and a snapshot restored under a different chat would write another
  chat's thread over this one — the hazard `auditRunId` already guards for audit ids. It is
  invalidated by the next question (hence the `keepUndo` flag, which only the two rewind callers
  pass), by an audit, by Clear, by a chat change, and by a reload.
- The question to re-ask is found by walking **back past `meta` messages**, not by assuming
  `index - 1`: an audit report is an assistant message that is not part of the conversation.
- Error and stopped replies keep their regenerate button — a request that failed is the one that most
  needs re-sending — but not Copy or Save as lorebook entry.
- The inline editor lives in the DOM and nowhere else. `renderTranscript()` resets `editingIndex`, so
  a re-render ends the edit instead of leaving a stale textarea holding text nobody will read;
  `cancelEdit()` rebuilds the one bubble rather than the transcript, so an edit scrolled back in
  history does not snap to the bottom on cancel.

### Lorebook writes (`lorebook.js`)

Entry shape changes between ST releases, so a new entry is cloned from an existing entry in the
target book and only falls back to `FALLBACK_ENTRY` for empty books. A keyword entry with no keys
would never fire, so it is saved `disable: true` and the toast says why. Naming an unknown book
creates it (`saveWorldInfo` + `updateWorldInfoList`).

### Stale-lore audit (`audit.js`)

A long roleplay outgrows its own reference material. The audit reviews lorebook entries, raw card
fields and the persona description against the story as it now stands, and reports **verbatim
old → new spans** the author pastes over by hand. Read-only: nothing here writes World Info.

Four decisions hold it up:

- **It ignores `settings.loreMode`** and calls `loadWorldInfo()` directly. An audit has to see the
  entries that are *not* currently triggering — a location abandoned a year ago is both the least
  likely to fire and the most likely to be wrong.
- **Coverage is proved, not assumed.** Targets are handed over as `E1`, `E2`, … and the model must
  account for every one via the `OK:` line or an `#### E<n>` heading. `parseCoverage()` reads both
  back and reports whatever went unanswered. Without this, "no findings" and "never examined" look
  identical, which is the failure mode that makes an audit worthless. A heading beats an `OK`
  listing for the same id. Changing that output format in `auditPrompt` breaks coverage counting —
  the settings hint says so.
- **Batches are small on purpose** (`auditBatchChars`, default 7000 — about two entries). Twenty
  entries in one request gets three of them read.
- **Embedded card lore is not a source.** `data.character_book` is never read, by this extension or
  by SillyTavern: `getCharacterLore()` resolves only the file name in `data.extensions.world`, and
  "Import Card Lore" is what turns the embedded copy into such a file. So after an import the
  embedded book duplicates the bound file, and without one the roleplay is not using it either —
  either way, corrections to it could not be applied, since the copy inside the card is unreachable
  from the UI. `unimportedCardLore()` reports that second case instead of quietly auditing it.
- **Identical targets are merged** by `dedupeTargets()`, before ids are assigned, for the case that
  remains: two world files holding the same entries (one install has `Guild RPG.json` and
  `Guild RPG v2.json` sharing fourteen). The duplicate is not dropped silently — its location lands
  in `alsoAt` and the report names it, because fixing one copy and not the other leaves the two
  contradicting each other. Near-identical copies stay separate: they are different texts and each
  needs its own verdict.
- **`auditHistoryCount` caps the evidence separately** from the conversational history setting. The
  story block is re-sent with *every* batch, so `historyMode: 'all'` on a 1 MB chat would be paid
  for once per request. The running summary carries the older material.

Card targets use the **raw** `character.description` / `.personality` / `.scenario`, not
`getCharacterCardFields()`: the author pastes the replacement into the card editor, so the audit has
to quote what is actually stored there rather than the macro-resolved view.

Reports land in the transcript as `meta` messages — kept and re-readable, but excluded from
`threadForRequest()` so a multi-batch report does not ride along with every later question.

The "unanswered targets" button resolves ids through an in-memory index, so it disappears after a
reload; only the ids are persisted, never the target texts. Because ids are positional they collide
across runs, so each run carries a token (`auditRunId`) and a stored summary offers its button only
while that token is current; `onChatChanged()` bumps it and empties the index, since a summary
persisted under another chat must never resolve against this one's entries.

The ids are machinery, and `humanizeReport()` keeps them out of the report. It eats the `OK:` line
and re-emits it as names ("Unchanged: Ash, Oriane"), and rewrites each `#### E<n>` heading into the
entry's title plus the address this module knows — book and uid — rather than trusting whatever name
the model echoed. Streaming shows the raw reply; `onBatchDone` replaces it with the humanized one.
Without that pass the author reads "OK: E12, E13", which names nothing and locates nothing.

New display strings use `*asterisk italics*`, never `_underscores_`: `renderInline()` deliberately
omits underscore emphasis so keys and identifiers survive, so `_text_` renders literally.

Stopping an audit is a coverage event, not just an early exit: a streaming connection profile
resolves with partial text instead of throwing (`llm.js` `sendViaProfile`), so `runAudit()` reaches
its own loop guard normally. It pushes every unread batch into `missed` and returns `stopped: true`,
and the panel says "Audit stopped". Never let an abort quietly shrink the denominator.

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
3. The user's edited `systemPrompt` and `buddyVoice` are never overwritten by a new default; the
   matching **Restore default…** button is the only path that replaces either one.
