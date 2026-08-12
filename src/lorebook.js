/**
 * Writing side-thread output back into a lorebook.
 *
 * Entries are written through the context's loadWorldInfo/saveWorldInfo pair. The
 * shape of a world info entry changes between releases, so a new entry is cloned
 * from an existing one in the target book whenever possible and only falls back to
 * a hardcoded template for empty books.
 */

import { debugLog } from './settings.js';

/** Minimal entry shape, used only when the target book has no entry to clone. */
const FALLBACK_ENTRY = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
};

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/** @returns {string[]} */
export function listLorebooks() {
    try {
        return ctx().getWorldInfoNames?.() || [];
    } catch {
        return [];
    }
}

/**
 * @param {any} data
 * @returns {number}
 */
function nextUid(data) {
    const uids = Object.keys(data?.entries || {}).map(Number).filter(Number.isFinite);
    return uids.length ? Math.max(...uids) + 1 : 0;
}

/**
 * @param {any} data
 * @returns {Record<string, any>}
 */
function entryTemplate(data) {
    const existing = Object.values(data?.entries || {})[0];
    if (!existing || typeof existing !== 'object') return structuredClone(FALLBACK_ENTRY);

    const clone = structuredClone(existing);
    delete clone.uid;
    delete clone.displayIndex;
    return Object.assign(clone, {
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        disable: false,
        probability: 100,
        useProbability: true,
    });
}

/**
 * Create a lorebook entry. The book is created if it does not exist yet.
 *
 * @param {object} params
 * @param {string} params.book Lorebook file name.
 * @param {string[]} params.keys Primary keys.
 * @param {string} params.title Entry title (the "Memo/Comment" field).
 * @param {string} params.content Entry body.
 * @param {boolean} [params.constant] Always-on instead of keyword-triggered.
 * @returns {Promise<{book:string, uid:number}>}
 */
export async function createLorebookEntry({ book, keys, title, content, constant = false }) {
    const context = ctx();
    const name = String(book || '').trim();
    if (!name) throw new Error('No lorebook name given.');
    if (!String(content || '').trim()) throw new Error('Entry content is empty.');
    if (typeof context.loadWorldInfo !== 'function' || typeof context.saveWorldInfo !== 'function') {
        throw new Error('World Info API is not available in this SillyTavern build.');
    }

    const exists = listLorebooks().includes(name);
    /** @type {any} */
    let data = exists ? await context.loadWorldInfo(name) : null;
    if (!data || typeof data !== 'object') data = { entries: {} };
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};

    const uid = nextUid(data);
    const entry = entryTemplate(data);
    entry.uid = uid;
    entry.displayIndex = Object.keys(data.entries).length;
    entry.key = keys.map(key => String(key).trim()).filter(Boolean);
    entry.comment = String(title || '').trim();
    entry.content = String(content).trim();
    entry.constant = !!constant;
    // A keyword entry with no keys would never fire; make that visible instead of silent.
    if (!entry.constant && !entry.key.length) entry.disable = true;

    data.entries[uid] = entry;

    await context.saveWorldInfo(name, data, true);
    try {
        if (!exists) await context.updateWorldInfoList?.();
        await context.reloadWorldInfoEditor?.(name, false);
    } catch (error) {
        debugLog('world info editor refresh failed', error);
    }

    return { book: name, uid };
}
