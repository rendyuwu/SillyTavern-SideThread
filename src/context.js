/**
 * Assembles the side-thread system prompt from the live SillyTavern state:
 * character card(s), persona, author's note, lorebooks and the main chat history.
 *
 * Everything is read through `SillyTavern.getContext()` so the extension does not
 * bind to core module paths that move between releases.
 */

import { debugLog, PUSHBACK_ORDERS } from './settings.js';

const CHAT_LOREBOOK_METADATA_KEY = 'world_info';

/**
 * @typedef {{ title: string, body: string }} Section
 * @typedef {{ systemPrompt: string, sections: Section[], chars: number }} BuiltContext
 */

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** Character cards can be "shallow" (metadata only) right after a page load. */
async function ensureCardsLoaded() {
    const context = ctx();
    try {
        if (context.groupId) await context.unshallowGroupMembers?.(context.groupId);
        else if (context.characterId !== undefined && context.characterId !== null) await context.unshallowCharacter?.(context.characterId);
    } catch (error) {
        debugLog('unshallow failed', error);
    }
}

/**
 * Who the side thread is, as opposed to what it does. Kept out of
 * `settings.systemPrompt` so the personality can be retuned without forking the
 * task instructions — and so a user who edits one still gets defaults for the other.
 *
 * @returns {Section[]}
 */
function buildBuddyPersonaSections(settings) {
    const name = trim(settings.buddyName);
    const voice = trim(settings.buddyVoice);
    if (!name && !voice) return [];

    const parts = [];
    if (name) parts.push(`Your name is ${name}. Use it when the author asks who they are talking to.`);
    if (voice) parts.push(voice);
    return [{ title: 'SIDE THREAD PERSONA', body: parts.join('\n\n') }];
}

/**
 * The pushback dial, emitted last: an instruction to contradict the author loses
 * to the model's own agreeableness when it sits a few thousand tokens upstream.
 *
 * @returns {Section[]}
 */
function buildStandingOrdersSections(settings) {
    const order = PUSHBACK_ORDERS[settings.pushback] || PUSHBACK_ORDERS.balanced;
    return [{
        title: 'STANDING ORDERS',
        body: `${order}\n\nThese orders outrank any instinct to be agreeable.`,
    }];
}

/**
 * The running summary kept by SillyTavern's Summarize extension, stored on the
 * newest message that carries one. Without it, everything before the history
 * window is invisible and continuity checks go quietly wrong on a long chat.
 *
 * @returns {Section[]}
 */
function buildSummarySection() {
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const summary = trim(chat[index]?.extra?.memory);
        if (summary) return [{ title: 'RUNNING SUMMARY (of the story so far)', body: summary }];
    }
    return [];
}

/**
 * Character card fields for the active solo character, via the core resolver so
 * chat-level overrides (scenario, examples) and macros are respected.
 *
 * @returns {Section[]}
 */
function buildSoloCardSections(settings) {
    const context = ctx();
    const character = context.characters?.[context.characterId];
    if (!character) return [];

    /** @type {Record<string, any>} */
    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() || {};
    } catch (error) {
        debugLog('getCharacterCardFields failed, falling back to raw card', error);
    }

    const name = character.name || 'Character';
    const description = trim(fields.description) || trim(character.description);
    const personality = trim(fields.personality) || trim(character.personality);
    const scenario = trim(fields.scenario) || trim(character.scenario);
    const depthPrompt = trim(fields.charDepthPrompt);
    const systemPromptOverride = trim(fields.system);

    const parts = [`Name: ${name}`];
    if (description) parts.push(`### Description\n${description}`);
    if (personality) parts.push(`### Personality\n${personality}`);
    if (scenario) parts.push(`### Scenario\n${scenario}`);
    if (depthPrompt) parts.push(`### Always-on behaviour note (depth prompt)\n${depthPrompt}`);
    if (systemPromptOverride) parts.push(`### Card system prompt\n${systemPromptOverride}`);
    if (settings.includeFirstMessage) {
        const firstMessage = trim(fields.firstMessage) || trim(character.first_mes);
        if (firstMessage) parts.push(`### First message\n${firstMessage}`);
    }
    if (settings.includeExamples) {
        const examples = trim(fields.mesExamples) || trim(character.mes_example);
        if (examples) parts.push(`### Example dialogue\n${examples}`);
    }

    return [{ title: 'ACTIVE CHARACTER CARD', body: parts.join('\n\n') }];
}

/**
 * One block per group member. Group cards deliberately keep it shorter than the
 * solo path: a group of eight full cards drowns the rest of the context.
 *
 * @returns {Section[]}
 */
function buildGroupCardSections(settings) {
    const context = ctx();
    const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
    if (!group) return [];

    const members = (group.members || [])
        .map((/** @type {string} */ avatar) => context.characters?.find((/** @type {any} */ c) => c.avatar === avatar))
        .filter(Boolean);
    if (!members.length) return [];

    const blocks = members.map((/** @type {any} */ member) => {
        const parts = [`### ${member.name}`];
        if (trim(member.description)) parts.push(trim(member.description));
        if (trim(member.personality)) parts.push(`Personality: ${trim(member.personality)}`);
        if (trim(member.scenario)) parts.push(`Scenario: ${trim(member.scenario)}`);
        if (settings.includeExamples && trim(member.mes_example)) parts.push(`Example dialogue:\n${trim(member.mes_example)}`);
        return parts.join('\n');
    });

    return [{
        title: `GROUP CAST — ${group.name || 'Group'} (${members.length} members)`,
        body: blocks.join('\n\n'),
    }];
}

/** @returns {Section[]} */
function buildPersonaSection() {
    const context = ctx();
    const description = trim(context.powerUserSettings?.persona_description);
    const name = trim(context.name1);
    if (!description) return [];
    return [{
        title: `USER PERSONA${name ? ` — ${name}` : ''}`,
        body: description,
    }];
}

/** @returns {Section[]} */
function buildAuthorNoteSection() {
    const context = ctx();
    const note = trim(context.chatMetadata?.note_prompt);
    if (!note) return [];
    return [{ title: "AUTHOR'S NOTE (active in the main chat)", body: note }];
}

/**
 * Names of every lorebook currently bound to this chat: character book, chat
 * book, persona book and the global selection.
 *
 * @returns {string[]}
 */
function getBoundLorebookNames() {
    const context = ctx();
    const known = new Set(context.getWorldInfoNames?.() || []);
    /** @type {string[]} */
    const names = [];

    const push = (/** @type {any} */ name) => {
        const value = trim(name);
        if (value && known.has(value) && !names.includes(value)) names.push(value);
    };

    // Character-bound book(s).
    const character = context.characters?.[context.characterId];
    push(character?.data?.extensions?.world);

    // Group members can each bind their own book.
    const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
    for (const avatar of group?.members || []) {
        const member = context.characters?.find((/** @type {any} */ c) => c.avatar === avatar);
        push(member?.data?.extensions?.world);
    }

    // Chat-bound book.
    push(context.chatMetadata?.[CHAT_LOREBOOK_METADATA_KEY]);

    // Persona-bound book.
    push(context.powerUserSettings?.persona_description_lorebook);

    // Global selection. `selected_world_info` is not exposed on the context object,
    // so read the multiselect the World Info panel keeps in sync.
    for (const option of document.querySelectorAll('#world_info option')) {
        if (option instanceof HTMLOptionElement && option.selected) push(option.textContent);
    }

    return names;
}

/**
 * Full dump of every enabled entry in the bound books. Truncated at
 * `settings.loreMaxChars` so a 500-entry world does not eat the whole context.
 *
 * @returns {Promise<Section[]>}
 */
async function buildFullLoreSections(settings) {
    const context = ctx();
    if (typeof context.loadWorldInfo !== 'function') return [];

    const names = getBoundLorebookNames();
    const embedded = await getEmbeddedCharacterBook();
    if (!names.length && !embedded) return [];

    /** @type {Section[]} */
    const sections = [];
    let budget = Math.max(1000, Number(settings.loreMaxChars) || 20000);
    let truncated = false;

    const renderBook = (/** @type {string} */ label, /** @type {any} */ book) => {
        const entries = Object.values(book?.entries || {});
        /** @type {string[]} */
        const blocks = [];
        for (const entry of /** @type {any[]} */ (entries)) {
            if (!entry || entry.disable) continue;
            const content = trim(entry.content);
            if (!content) continue;
            const title = trim(entry.comment) || (Array.isArray(entry.key) ? entry.key.join(', ') : '') || `uid ${entry.uid}`;
            const keys = Array.isArray(entry.key) && entry.key.length ? `keys: ${entry.key.join(', ')}` : '';
            const block = `### ${title}${keys ? `\n_${keys}_` : ''}\n${content}`;
            if (block.length > budget) { truncated = true; break; }
            budget -= block.length;
            blocks.push(block);
        }
        if (blocks.length) sections.push({ title: `LOREBOOK — ${label}`, body: blocks.join('\n\n') });
    };

    for (const name of names) {
        if (budget <= 0) { truncated = true; break; }
        try {
            renderBook(name, await context.loadWorldInfo(name));
        } catch (error) {
            debugLog(`loadWorldInfo("${name}") failed`, error);
        }
    }
    if (embedded && budget > 0) renderBook(`${embedded.label} (embedded in card)`, embedded.book);

    if (truncated) {
        sections.push({
            title: 'LOREBOOK NOTICE',
            body: `Lorebook output was truncated at ~${settings.loreMaxChars} characters. Raise "Lore character budget" in the extension settings, or switch lore mode to "Activated entries only", if you need more.`,
        });
    }
    return sections;
}

/**
 * Character cards can carry their own book inline (`data.character_book`) instead
 * of referencing a file.
 *
 * @returns {Promise<{label:string, book:any}|null>}
 */
async function getEmbeddedCharacterBook() {
    const context = ctx();
    const character = context.characters?.[context.characterId];
    const raw = character?.data?.character_book;
    if (!raw || typeof context.convertCharacterBook !== 'function') return null;
    try {
        return { label: trim(raw.name) || character.name || 'Card book', book: context.convertCharacterBook(raw) };
    } catch (error) {
        debugLog('convertCharacterBook failed', error);
        return null;
    }
}

/**
 * Only the entries SillyTavern would actually activate for the current chat tail.
 * Uses the core scanner in dry-run mode so no WORLD_INFO_ACTIVATED events fire and
 * nothing in the main chat is disturbed.
 *
 * @returns {Promise<Section[]>}
 */
async function buildActivatedLoreSections() {
    const context = ctx();
    if (typeof context.getWorldInfoPrompt !== 'function') return [];

    const chat = Array.isArray(context.chat) ? context.chat : [];
    // The scanner expects newest-first plain strings.
    const scanChat = chat
        .filter((/** @type {any} */ m) => !m.is_system)
        .map((/** @type {any} */ m) => String(m.mes || ''))
        .reverse();

    try {
        const result = await context.getWorldInfoPrompt(scanChat, Number(context.maxContext) || 4096, true);
        const body = trim(result?.worldInfoString);
        if (!body) return [];
        return [{ title: 'ACTIVE LORE (entries currently triggered in the main chat)', body }];
    } catch (error) {
        debugLog('getWorldInfoPrompt failed', error);
        return [];
    }
}

/** @returns {Section[]} */
function buildHistorySection(settings) {
    const context = ctx();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    if (settings.historyMode === 'none' || !chat.length) return [];

    const visible = chat.filter((/** @type {any} */ m) => settings.includeHiddenMessages || !m.is_system);
    const count = Math.max(1, Number(settings.historyCount) || 40);
    const slice = settings.historyMode === 'all' ? visible : visible.slice(-count);
    if (!slice.length) return [];

    const lines = slice.map((/** @type {any} */ message) => {
        const speaker = message.is_user ? (message.name || 'User') : (message.name || 'Character');
        const text = trim(message.mes);
        return text ? `${speaker}: ${text}` : '';
    }).filter(Boolean);
    if (!lines.length) return [];

    const scope = settings.historyMode === 'all'
        ? `all ${lines.length} messages`
        : `last ${lines.length} of ${visible.length} messages`;

    return [{ title: `MAIN CHAT HISTORY (${scope})`, body: lines.join('\n\n') }];
}

/**
 * Render sections into the delimited form the model sees.
 *
 * @param {Section[]} sections
 * @returns {string}
 */
export function renderSections(sections) {
    return sections
        .map(section => `--- ${section.title} ---\n${section.body}\n--- END ${section.title} ---`)
        .join('\n\n');
}

/**
 * Build the full side-thread system prompt.
 *
 * The options exist for the stale-lore audit, which needs the same story context
 * without the lore it is about to review, and without the pushback orders that
 * belong to conversation rather than to an audit.
 *
 * @param {Record<string, any>} settings
 * @param {{omitLore?: boolean, omitStandingOrders?: boolean}} [options]
 * @returns {Promise<BuiltContext>}
 */
export async function buildContext(settings, options = {}) {
    await ensureCardsLoaded();
    const context = ctx();

    /** @type {Section[]} */
    const sections = [];

    sections.push(...buildBuddyPersonaSections(settings));

    const chatName = context.getCurrentChatId?.() || '(no chat)';
    const characterName = context.groupId
        ? (context.groups?.find((/** @type {any} */ g) => g.id === context.groupId)?.name || 'Group')
        : (context.characters?.[context.characterId]?.name || '(no character)');
    sections.push({
        title: 'SESSION',
        body: `Character/group: ${characterName}\nChat file: ${chatName}\nUser persona name: ${trim(context.name1) || 'User'}`,
    });

    if (settings.includeCard) {
        sections.push(...(context.groupId ? buildGroupCardSections(settings) : buildSoloCardSections(settings)));
    }
    if (settings.includePersona) sections.push(...buildPersonaSection());
    if (settings.includeAuthorNote) sections.push(...buildAuthorNoteSection());
    if (settings.includeSummary) sections.push(...buildSummarySection());

    if (!options.omitLore) {
        if (settings.loreMode === 'activated') sections.push(...(await buildActivatedLoreSections()));
        else if (settings.loreMode === 'full') sections.push(...(await buildFullLoreSections(settings)));
    }

    sections.push(...buildHistorySection(settings));
    if (!options.omitStandingOrders) sections.push(...buildStandingOrdersSections(settings));

    const rendered = renderSections(sections);
    const systemPrompt = `${trim(settings.systemPrompt)}\n\n${rendered}`;
    return { systemPrompt, sections, chars: systemPrompt.length };
}

/**
 * Rough token count for the context preview. Falls back to a 4-chars-per-token
 * estimate when the tokenizer is unavailable.
 *
 * @param {string} text
 * @returns {Promise<{count:number, estimated:boolean}>}
 */
export async function countTokens(text) {
    const context = ctx();
    try {
        if (typeof context.getTokenCountAsync === 'function') {
            return { count: await context.getTokenCountAsync(text), estimated: false };
        }
    } catch (error) {
        debugLog('getTokenCountAsync failed', error);
    }
    return { count: Math.ceil(text.length / 4), estimated: true };
}

export { getBoundLorebookNames, getEmbeddedCharacterBook };
