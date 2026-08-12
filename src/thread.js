/**
 * Per-chat side-thread transcripts, kept in localStorage.
 *
 * Deliberately not stored in chat metadata: the side thread must never end up in
 * the exported chat file, and it must never be part of what the main generation
 * sees. localStorage keeps it device-local and invisible to SillyTavern's own
 * prompt builder.
 */

import { debugLog } from './settings.js';

const STORE_KEY = 'btw_threads_v1';
const MAX_CHATS = 24;
const MAX_MESSAGES_PER_CHAT = 240;
const MAX_STORE_CHARS = 1_500_000;

/** @typedef {{role:'user'|'assistant', content:string, ts:number, error?:boolean}} ThreadMessage */

/** @returns {string} */
export function currentThreadId() {
    const context = SillyTavern.getContext();
    return String(context.getCurrentChatId?.() ?? context.chatId ?? '__no_chat__');
}

/** @returns {Record<string, {updated:number, messages:ThreadMessage[]}>} */
function readStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/** @param {Record<string, {updated:number, messages:ThreadMessage[]}>} store */
function writeStore(store) {
    // Drop the least recently used chats until the store fits.
    let entries = Object.entries(store).sort((a, b) => (b[1]?.updated || 0) - (a[1]?.updated || 0));
    if (entries.length > MAX_CHATS) entries = entries.slice(0, MAX_CHATS);

    let serialized = JSON.stringify(Object.fromEntries(entries));
    while (serialized.length > MAX_STORE_CHARS && entries.length > 1) {
        entries.pop();
        serialized = JSON.stringify(Object.fromEntries(entries));
    }

    try {
        localStorage.setItem(STORE_KEY, serialized);
    } catch (error) {
        debugLog('thread persist failed', error);
    }
}

/**
 * @param {string} [threadId]
 * @returns {ThreadMessage[]}
 */
export function loadThread(threadId = currentThreadId()) {
    const entry = readStore()[threadId];
    return Array.isArray(entry?.messages) ? entry.messages : [];
}

/**
 * @param {ThreadMessage[]} messages
 * @param {string} [threadId]
 */
export function saveThread(messages, threadId = currentThreadId()) {
    const store = readStore();
    const trimmed = messages.slice(-MAX_MESSAGES_PER_CHAT);
    if (!trimmed.length) delete store[threadId];
    else store[threadId] = { updated: Date.now(), messages: trimmed };
    writeStore(store);
}

/** @param {string} [threadId] */
export function clearThread(threadId = currentThreadId()) {
    const store = readStore();
    delete store[threadId];
    writeStore(store);
}

/**
 * The last N turns handed to the model, so a long side thread does not push the
 * story context out of the window.
 *
 * @param {ThreadMessage[]} messages
 * @param {number} turns One turn = one user message plus its reply.
 * @returns {{role:'user'|'assistant', content:string}[]}
 */
export function threadForRequest(messages, turns) {
    const limit = Math.max(1, Number(turns) || 12) * 2;
    return messages
        .filter(message => !message.error && typeof message.content === 'string' && message.content.trim())
        .slice(-limit)
        .map(({ role, content }) => ({ role, content }));
}
