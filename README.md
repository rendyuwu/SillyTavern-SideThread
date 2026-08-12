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

- **Quick prompts** — one-tap starters for a lore check, a character summary, a new NPC, or
  three ways the scene could go next.
- **Eye icon** — preview exactly what context will be sent, section by section, with a token
  count. Use this when the panel feels slow or expensive.
- **Save as lorebook entry** (on any answer) — turn a drafted NPC, faction or location into a
  real World Info entry. If the answer contains a fenced block, that block is prefilled.
  Naming a book that does not exist creates it.
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

The **completion preset override** applies to connection-profile requests only. For the other
sources, configure the model's sampling on the endpoint or in the profile itself.

## What gets sent

Every side question carries a freshly assembled system prompt. All of it is optional:

- Character card — description, personality, scenario, depth prompt, card system prompt, and
  optionally example dialogue and the greeting. Group chats send one block per member.
- User persona description.
- Author's note, if one is active.
- Lorebooks, in one of three modes:
  - **Activated entries only** (default) — runs SillyTavern's own World Info scanner in dry-run
    mode, so you see exactly what the story is currently using.
  - **Every entry in every bound book** — character book, embedded card book, chat book, persona
    book and the global selection, capped by a character budget you set.
  - **None.**
- Main chat history — the last N messages, the whole chat, or nothing. Hidden/system messages
  are excluded unless you opt in.
- The last N turns of the side thread itself.

## Configuration reference

**Connection** — source, profile, Ollama/OpenAI endpoints and models, preset override, max
response length, temperature (direct modes only), streaming.

**What the side thread sees** — history mode and count, lore mode and character budget, and
toggles for card, examples, greeting, persona, author's note, hidden messages, plus how many
side-thread turns to keep.

**Instructions** — the system prompt, with a one-click restore to the default.

The default prompt keeps the side thread out of character, tells it to ground every claim in
the supplied context and to label anything it invents, treats adult and dark subject matter as
in scope (this is a channel for analysing fiction, not for performing it), and makes it answer
in whichever language you write in — or in the language you name, if you name one. Edit it
freely; your version is stored in your SillyTavern settings, so a later update to the default
will not overwrite it. Use **Restore default prompt** if you want the new default.

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
