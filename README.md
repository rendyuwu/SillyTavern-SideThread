# BTW — Side Thread

An out-of-character side chat for SillyTavern, in the spirit of Claude Code's `/btw`.

Ask a question *about* the story without adding anything *to* it. The side thread runs in a
floating panel over SillyTavern and receives the same world the roleplay does — the active
character card, your persona, the bound lorebooks and the chat history — so you can discuss
lore, interrogate continuity, plan a scene or design an NPC, then go back to the story with
the main chat untouched.

Nothing the side thread says or sees is written into the chat file, the chat metadata or the
main prompt.

## Install

**From the SillyTavern UI:** Extensions → Install extension → paste this repository's URL.

**Manually:** clone into your data directory —

```
git clone https://github.com/rendyuwu/SillyTavern-SideThread \
  SillyTavern/data/<user>/extensions/SillyTavern-SideThread
```

then reload SillyTavern.

## Use

| How | What it does |
| --- | --- |
| Wand menu → **Side Thread (BTW)** | Toggle the panel |
| `/btw <question>` | Ask straight away; the answer is also returned down the slash-command pipe |
| `/btw` | Toggle the panel |
| Extensions settings → **BTW — Side Thread** | Configure everything |

Aliases for the command: `/side`, `/ooc`.

Inside the panel:

- **Quick prompts** — one-tap starters: a lore check, a character summary, a new NPC, three ways
  the scene could go next, a demand that it argue with your plan, complications for the current
  scene, a lorebook draft from what you just worked out, and a continuity sweep. A chip frames
  whatever you have already typed rather than replacing it.
- **Eye icon** — preview exactly what context will be sent, section by section, with a token
  count. Use this when the panel feels slow or expensive.
- **Clock icon** — audit the lore for what the story has outgrown. See below.
- **Save as lorebook entry** (on any answer) — turn a drafted NPC, faction or location into a
  real World Info entry. A fenced block in the answer is prefilled, together with the title and
  keys when the answer supplied them; if several entries were drafted, pick which one. Naming a
  book that does not exist creates it.
- **Copy button on any fenced block** — including the `old` / `new` pairs an audit produces.
- **Regenerate** — re-ask the question that produced an answer, discarding everything after it.
- **Trash icon** — clear this chat's side thread.

The panel is draggable by its header and resizable from either bottom corner; position and
size are remembered per device. On narrow screens it becomes a near-fullscreen sheet instead.

Each chat gets its own side thread, restored when you switch back to that chat.

## Connection

The side thread can run on a different backend from your roleplay, which is the point: a
cheap, fast model answers your questions while your expensive prose model stays untouched.

| Source | Notes |
| --- | --- |
| **Main API** | Reuses SillyTavern's current connection via `generateRaw`. No streaming, and the Stop button cannot interrupt it. |
| **Connection profile** | A Connection Manager profile. Silent (no UI flicker), streams, abortable. Recommended. |
| **Ollama (direct)** | Talks to `/api/chat` from the browser. The server must allow this origin — set `OLLAMA_ORIGINS`. |
| **OpenAI-compatible (direct)** | Talks to `/chat/completions` from the browser, with SSE streaming. Needs a CORS-permissive endpoint. The API key is stored in your SillyTavern settings, not in the secrets store. |

The **completion preset override** applies to connection-profile requests only — and in that mode it
is the only way to give the side thread its own sampler settings, because the extension's
temperature field is read by the direct modes alone. Point it at a preset with some temperature
(around 0.8) so a deterministic roleplay preset does not flatten the personality. For Ollama and
OpenAI-compatible sources, set the temperature here or on the endpoint itself.

## What gets sent

Every side question carries a freshly assembled system prompt: the instructions, then your
partner's persona, then the context below, then its standing orders last. All of the context is
optional:

- Character card — description, personality, scenario, depth prompt, card system prompt, and
  optionally example dialogue and the greeting. Group chats send one block per member.
- User persona description.
- Author's note, if one is active.
- The running summary kept by the Summarize extension, if there is one. This is what keeps a long
  chat visible past the history window, and what the audit leans on for anything older than its
  evidence window.
- Lorebooks, in one of three modes:
  - **Activated entries only** (default) — runs SillyTavern's own World Info scanner in dry-run
    mode, so you see exactly what the story is currently using.
  - **Every entry in every bound book** — character book, chat book, persona book and the global
    selection, capped by a character budget you set.
  - **None.**
- Main chat history — the last N messages, the whole chat, or nothing. Hidden/system messages
  are excluded unless you opt in.
- The last N turns of the side thread itself.

## Stale lore audit

A long roleplay outgrows its own reference material. A timeskip moves everyone's age. A secret
becomes common knowledge, so the entry that frames it as hidden is now wrong. A character loses a
boundary the card still insists on. A village the lorebook describes as standing was burned two
arcs ago.

The **clock icon** in the panel header reviews your lorebook entries, the raw character card fields
and the persona description against the story as it now stands, and reports **verbatim old → new
spans** for you to paste over by hand. It never writes to World Info; the replacing is yours.

It asks for three things:

- **How much in-story time has passed** — optional, but ages cannot be recomputed without it.
- **Which lorebooks** — the ones bound to this chat are already ticked; add any of the others.
- **The card and the persona** — where an outgrown personality note or a faded boundary usually
  hides, rather than in the lorebook.

It looks for ages and dates, relationships and forms of address, status (alive, rank, job, location,
possessions), world state, behaviour and boundaries that have shifted, secrets that have surfaced,
and keys that stopped triggering after a rename. It deliberately does **not** rewrite text that is
merely written badly — prose quality is out of scope, and every finding has to cite the evidence
that proves the change.

Two properties are what make the report worth trusting:

- **Coverage is proved, not assumed.** Targets go over in numbered batches and every one must come
  back with a verdict. Anything the model fails to rule on is reported as *unanswered* — never as
  clean — with a button to re-audit just those. Stopping mid-run counts every unread batch as
  unanswered too, so an abort cannot quietly shrink the denominator.
- **Batches are small on purpose**, around two entries per request. Twenty entries in one request
  gets three of them read. More requests, closer reading.
- **Duplicates are merged.** If two of the books you tick hold the same entries — an old copy and a
  v2, say — the identical text becomes one target, and the report names the other place it lives,
  because fixing one copy and not the other leaves the two contradicting each other.

Lore embedded inside a character card is **not** audited. SillyTavern never reads it either: "Import
Card Lore" converts it into a normal lorebook file, and that file is what the story uses and what you
edit. The copy inside the card stays frozen and unreachable, so a correction to it could not be
applied anywhere. If a card is carrying embedded lore that was never imported, the audit says so
instead of silently reviewing it.

The audit loads the books itself, so the lore mode above does not constrain it: it has to see the
entries that are *not* currently triggering, because a place nobody has mentioned in a year is both
the least likely to fire and the most likely to be wrong.

Its evidence window is capped separately from the chat history, because the story context is
re-sent with **every** batch — "entire chat" would otherwise be billed once per request. Keep the
Summarize extension on for a long chat; its running summary carries what falls outside the window.

Reports stay in the side thread, so you can leave one half-finished and come back to it. They are
marked, and excluded from what later questions send, so a long report does not ride along with
every follow-up.

## Configuration reference

**Connection** — source, profile, Ollama/OpenAI endpoints and models, preset override, max
response length, temperature (direct modes only), streaming.

**What the side thread sees** — history mode and count, lore mode and character budget, and
toggles for card, examples, greeting, persona, author's note, running summary, hidden messages,
plus how many side-thread turns to keep.

**Your writing partner** — the name it answers to, a free-form description of its voice and
temperament, and how hard it pushes back: *gentle* (leads with what works, raises problems as
questions), *balanced* (says what it thinks first, then helps), or *blunt* (attacks the premise
before helping build on it). This is kept separate from the system prompt so you can retune the
personality without losing later improvements to the instructions, and the other way round.

A small model will agree with you however this is set. If the pushback never arrives, the lever is
the model or the preset, not the dropdown.

**Instructions** — the system prompt, with a one-click restore to the default.

The default prompt keeps the side thread out of character and expects a collaborator rather than an
assistant: opinions unprompted, disagreement in the first sentence rather than after three
paragraphs of praise, a stated cost for every suggestion, one sharp question instead of a guess. It
grounds every claim in the supplied context and labels anything it invents, treats adult and dark
subject matter as in scope (this is a channel for analysing fiction, not for performing it), and
answers in whichever language you write in — or in the language you name, if you name one.

**Stale lore audit** — characters per request, max response length, how many messages of evidence
to send, and the audit instructions themselves. The `OK:` line and the `#### E<n>` headings in those
instructions are how coverage is counted: change that part of the format and the audit can no longer
tell you what it missed.

Edit any of these three texts freely. Your version is stored in your SillyTavern settings, so a
later update to a default will not overwrite it — which also means an existing install keeps the
prompt it already has. When you want the newer one, use the matching button:
**Restore default prompt**, **Restore default voice**, or
**Restore default audit instructions**.

**Panel** — font size, reset position, remember threads between sessions, debug logging.

## Requirements

SillyTavern with the extension context API (`SillyTavern.getContext()`). The Connection
Manager extension must be enabled for connection-profile mode; everything else degrades
gracefully without it.

## Credits

This extension was built by reading
**[SillyTavern-MultihogDnDFramework](https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework)**
by Disgusting Fatbody, which solves most of these problems already — as part of a much larger
RPG framework. It is the reference this project learned from, and it deserves the credit for the
patterns below.

What was taken from it, and where it ended up here:

| Their file | What it taught | Ours |
| --- | --- | --- |
| `ui-geometry.js` | Pointer-capture drag and corner resize, viewport clamping so a panel restored on a smaller screen keeps its header reachable, and the ResizeObserver "skip the first callback" trick that stops a CSS default from overwriting saved geometry | `src/geometry.js` |
| `llm-client.js` | Routing one request across four backends, and the `ConnectionManagerRequestService.sendRequest` call shape — including `includePreset` / `includeInstruct`, restoring `profile.preset` in a `finally`, and the many response shapes a reply can arrive in | `src/llm.js` |
| `character-creation-connection.js` | Wiring a per-extension connection panel: letting the service own the profile dropdown via `handleDropdown`, with a manual `isProfileSupported` list as the fallback | `src/settings-ui.js` |
| `adventure-companion.js` | Detaching a live view into a floating panel on `document.body`, and composing story context into one system prompt with labelled section delimiters | `src/panel.js`, `src/context.js` |
| `index.js` | Registering a wand-menu item on `#extensionsMenu` and mounting a settings drawer into `#extensions_settings2` | `index.js` |
| `generateRaw` usage | That `trimNames: true` silently discards a whole response when it starts with a character name — which is exactly what an NPC draft does | `src/llm.js` |

The code here was written fresh rather than copied, and the scope is deliberately tiny: one
side chat, no game systems, dice, quests, portraits or trackers. If you want those, use the
framework above — it is the more capable project by a wide margin.

The `/btw` idea is lifted from [Claude Code](https://claude.com/claude-code), where it asks a
side question without disturbing the main thread.

## License

MIT — see [LICENSE](LICENSE). The reference framework above is MIT too.

SillyTavern itself is AGPL-3.0. This extension carries no SillyTavern source: it reaches the
host only through the `SillyTavern.getContext()` runtime global and ships separately, so it is
licensed on its own terms.
