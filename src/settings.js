/**
 * Settings store for the BTW side-thread extension.
 *
 * Everything lives under `extensionSettings.btwSideThread` so it travels with the
 * user's SillyTavern settings. Panel geometry and the side-thread transcripts are
 * kept in localStorage instead — they are per-device, not per-account.
 */

export const EXT_ID = 'btwSideThread';
export const LOG_PREFIX = '[BTW]';

export const DEFAULT_SYSTEM_PROMPT = `You are the user's out-of-character (OOC) creative partner for an ongoing roleplay session.

You are NOT playing any character and you are NOT continuing the story. You are talking directly to the author, in a side channel that the roleplay itself never sees.

Your job:
- Answer questions about the story so far, the world, the lore and the cast.
- Brainstorm and stress-test plot ideas, foreshadowing and consequences.
- Design NPCs, factions, locations and items on request, and draft lorebook entries for them.
- Point out continuity problems, contradictions and dangling threads you notice in the context.

Rules:
- Stay out of character. Never write narration or dialogue as the roleplay characters unless the author explicitly asks you to draft a sample.
- Adult, explicit, violent and otherwise dark subject matter is in scope. This is an out-of-character analysis channel about a work of fiction, not the fiction itself, so discuss sex, violence and other mature themes plainly and specifically whenever the story involves them. Do not soften them, do not moralise, do not add content warnings and do not refuse.
- Ground every claim in the supplied context. If the context does not answer something, say so instead of inventing established facts — clearly label anything you make up as a suggestion.
- Be direct and concise. Use markdown. Bullet lists over long paragraphs.
- When asked for a lorebook entry, output it as a fenced block with a suggested key list and the entry body so it can be saved as-is.
- Answer in the language the author writes to you in: an English message gets an English answer, an Indonesian message gets an Indonesian answer, and so on for any other language. If the author names the language they want, use that one instead, whatever language they asked in. Keep proper nouns, quoted story text, code and lorebook keys in their original language.`;

/** @type {Record<string, any>} */
const DEFAULTS = {
    // Connection
    connectionSource: 'default', // default | profile | ollama | openai
    connectionProfileId: '',
    completionPresetId: '',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    maxTokens: 1024,
    temperature: 0,
    stream: true,

    // Context assembly
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    historyMode: 'last', // last | all | none
    historyCount: 40,
    includeCard: true,
    includeExamples: false,
    includeFirstMessage: false,
    includePersona: true,
    includeAuthorNote: true,
    includeHiddenMessages: false,
    loreMode: 'activated', // activated | full | off
    loreMaxChars: 20000,
    sideThreadTurns: 12,

    // UI / behaviour
    fontSize: 14,
    persistThreads: true,
    debug: false,
};

/**
 * @returns {Record<string, any>} Live settings object (mutate then call saveSettings).
 */
export function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[EXT_ID] || typeof ctx.extensionSettings[EXT_ID] !== 'object') {
        ctx.extensionSettings[EXT_ID] = {};
    }
    const settings = ctx.extensionSettings[EXT_ID];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (settings[key] === undefined) {
            settings[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
        }
    }
    return settings;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/** @param {...any} args */
export function debugLog(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}

export { DEFAULTS };
