/**
 * Stale-lore audit.
 *
 * A long roleplay outgrows its own reference material: ages drift after a
 * timeskip, relationships change, a "secret" becomes common knowledge, a
 * character loses a boundary the card still insists on. This module walks the
 * lorebook entries, character card fields and persona descriptions, compares them
 * against the story as it now stands, and reports verbatim old → new spans for the
 * author to paste over by hand.
 *
 * Read-only by design. Nothing here writes to World Info, the chat or chat
 * metadata; the author does the replacing. The lore is loaded directly through
 * `loadWorldInfo()` rather than through `settings.loreMode`, because an audit has
 * to see the entries that are *not* currently triggering — those are exactly the
 * ones most likely to have gone stale.
 */

import { debugLog } from './settings.js';
import { buildContext, renderSections, getBoundLorebookNames, getEmbeddedCharacterBook } from './context.js';
import { sendSideRequest, canStream } from './llm.js';

/**
 * @typedef {object} AuditTarget
 * @property {string} id Short handle the model echoes back (`E1`, `E2`, …).
 * @property {string} label Human address, shown in the report.
 * @property {'lorebook'|'card'|'persona'} kind
 * @property {string} content The text under review.
 * @property {string} [book] Lorebook file name, for lorebook targets.
 * @property {number} [uid] Entry uid, for lorebook targets.
 * @property {string[]} [keys]
 */

/**
 * @typedef {object} AuditCoverage
 * @property {string[]} ok Ids the model declared unchanged.
 * @property {string[]} findings Ids the model reported on.
 * @property {AuditTarget[]} missed Targets it never accounted for.
 */

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// ── Collecting targets ───────────────────────────────────────────────────────

/**
 * Every enabled entry of the given books, plus the card fields and persona text.
 * Ids are assigned in collection order so a batch always carries a contiguous run.
 *
 * @param {object} scope
 * @param {string[]} scope.books
 * @param {boolean} [scope.includeCard]
 * @param {boolean} [scope.includePersona]
 * @param {boolean} [scope.includeEmbedded]
 * @returns {Promise<AuditTarget[]>}
 */
export async function collectAuditTargets({ books, includeCard = true, includePersona = true, includeEmbedded = true }) {
    const context = ctx();
    /** @type {AuditTarget[]} */
    const targets = [];
    let sequence = 0;
    const nextId = () => `E${++sequence}`;

    /** @param {string} label @param {any} book */
    const pushBook = (label, book) => {
        for (const entry of Object.values(book?.entries || {})) {
            const record = /** @type {any} */ (entry);
            if (!record || record.disable) continue;
            const content = trim(record.content);
            if (!content) continue;
            const keys = Array.isArray(record.key) ? record.key.filter(Boolean) : [];
            const memo = trim(record.comment) || keys.join(', ') || `uid ${record.uid}`;
            targets.push({
                id: nextId(),
                kind: 'lorebook',
                label: `LOREBOOK "${label}" · uid ${record.uid} · ${memo}`,
                book: label,
                uid: record.uid,
                keys,
                content,
            });
        }
    };

    if (typeof context.loadWorldInfo === 'function') {
        for (const name of books) {
            try {
                pushBook(name, await context.loadWorldInfo(name));
            } catch (error) {
                debugLog(`audit: loadWorldInfo("${name}") failed`, error);
            }
        }
    }

    if (includeEmbedded) {
        const embedded = await getEmbeddedCharacterBook();
        if (embedded) pushBook(`${embedded.label} (embedded in the card)`, embedded.book);
    }

    if (includeCard) {
        for (const character of activeCharacters()) {
            for (const [field, value] of Object.entries(cardFields(character))) {
                const content = trim(value);
                if (!content) continue;
                targets.push({
                    id: nextId(),
                    kind: 'card',
                    label: `CHARACTER CARD "${character.name}" · field: ${field}`,
                    content,
                });
            }
        }
    }

    if (includePersona) {
        const description = trim(context.powerUserSettings?.persona_description);
        if (description) {
            targets.push({
                id: nextId(),
                kind: 'persona',
                label: `USER PERSONA "${trim(context.name1) || 'User'}" · description`,
                content: description,
            });
        }
    }

    return targets;
}

/**
 * The cast whose cards are under review: the solo character, or every member of
 * the active group.
 *
 * @returns {any[]}
 */
function activeCharacters() {
    const context = ctx();
    if (context.groupId) {
        const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
        return (group?.members || [])
            .map((/** @type {string} */ avatar) => context.characters?.find((/** @type {any} */ c) => c.avatar === avatar))
            .filter(Boolean);
    }
    const character = context.characters?.[context.characterId];
    return character ? [character] : [];
}

/**
 * Raw card fields, not the macro-resolved ones: the author is going to paste the
 * replacement into the card editor, so the audit has to quote what is stored there.
 *
 * @param {any} character
 * @returns {Record<string, string>}
 */
function cardFields(character) {
    return {
        description: character?.description || '',
        personality: character?.personality || '',
        scenario: character?.scenario || '',
    };
}

// ── Batching ─────────────────────────────────────────────────────────────────

/**
 * Split targets into requests that fit a character budget. A single oversized
 * target gets a batch of its own rather than being cut in half — the report has to
 * quote it verbatim, so it must be seen whole.
 *
 * @param {AuditTarget[]} targets
 * @param {number} budget
 * @returns {AuditTarget[][]}
 */
export function batchTargets(targets, budget) {
    const limit = Math.max(1500, Number(budget) || 7000);
    /** @type {AuditTarget[][]} */
    const batches = [];
    /** @type {AuditTarget[]} */
    let current = [];
    let size = 0;

    for (const target of targets) {
        const cost = target.content.length + target.label.length + 32;
        if (current.length && size + cost > limit) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(target);
        size += cost;
    }
    if (current.length) batches.push(current);
    return batches;
}

/**
 * @param {AuditTarget[]} batch
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
function renderBatch(batch, index, total) {
    const blocks = batch.map(target => {
        const keys = target.keys?.length ? `\nkeys: ${target.keys.join(', ')}` : '';
        return `[${target.id}] ${target.label}${keys}\nBEGIN ${target.id}\n${target.content}\nEND ${target.id}`;
    });
    return [
        `--- TARGETS UNDER REVIEW (batch ${index + 1} of ${total}, ${batch.length} targets) ---`,
        blocks.join('\n\n'),
        '--- END TARGETS UNDER REVIEW ---',
        '',
        `Account for all ${batch.length} targets: ${batch.map(t => t.id).join(', ')}.`,
    ].join('\n');
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * Which targets the model actually ruled on. Without this the report is
 * indistinguishable from a model that skimmed the batch and answered about three
 * entries — "no findings" and "not examined" have to look different.
 *
 * @param {string} text
 * @param {AuditTarget[]} batch
 * @returns {AuditCoverage}
 */
export function parseCoverage(text, batch) {
    const source = String(text || '');
    /** @type {Set<string>} */
    const ok = new Set();
    /** @type {Set<string>} */
    const findings = new Set();

    for (const match of source.matchAll(/^[*_#>\s-]*OK\b\s*[:：]?(.*)$/gim)) {
        for (const id of String(match[1] || '').matchAll(/\bE(\d+)\b/g)) ok.add(`E${id[1]}`);
    }
    for (const match of source.matchAll(/^#{1,6}\s*\**\s*(E\d+)\b/gim)) {
        findings.add(match[1]);
    }

    // A heading wins over the OK line: a target with a finding is not unchanged.
    for (const id of findings) ok.delete(id);

    const accounted = new Set([...ok, ...findings]);
    return {
        ok: [...ok],
        findings: [...findings],
        missed: batch.filter(target => !accounted.has(target.id)),
    };
}

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * The story context the audit judges against: the same assembly the panel uses,
 * minus the lore under review and minus the conversational pushback orders.
 *
 * The history is capped separately from the conversational setting, because this
 * block is re-sent with **every batch**. A chat set to "entire chat" would be paid
 * for once per request, and a model handed a 300k-token transcript alongside the
 * entries does not read either carefully. The running summary carries the older
 * material; `auditHistoryCount: 0` opts back into whatever the panel would send.
 *
 * @param {Record<string, any>} settings
 * @returns {Promise<string>}
 */
export async function buildStoryNow(settings) {
    const cap = Number(settings.auditHistoryCount) || 0;
    const scoped = cap > 0 ? { ...settings, historyMode: 'last', historyCount: cap } : settings;
    const built = await buildContext(scoped, { omitLore: true, omitStandingOrders: true });
    return renderSections(built.sections);
}

/**
 * Audit every batch in turn, reporting as each one lands.
 *
 * @param {object} params
 * @param {Record<string, any>} params.settings
 * @param {AuditTarget[][]} params.batches
 * @param {string} params.storyNow
 * @param {string} [params.elapsed] The author's note on how much in-story time has passed.
 * @param {AbortSignal|null} [params.signal]
 * @param {(index:number, total:number, batch:AuditTarget[]) => void} [params.onBatchStart]
 * @param {(text:string) => void} [params.onProgress]
 * @param {(text:string, coverage:AuditCoverage, index:number) => void} [params.onBatchDone]
 * @returns {Promise<{findings:number, ok:number, missed:AuditTarget[], stopped:boolean}>}
 */
export async function runAudit({ settings, batches, storyNow, elapsed = '', signal = null, onBatchStart, onProgress, onBatchDone }) {
    const elapsedBlock = trim(elapsed)
        ? `--- IN-STORY TIME ELAPSED (stated by the author) ---\n${trim(elapsed)}\n--- END IN-STORY TIME ELAPSED ---\n\n`
        : '';
    const systemPrompt = `${trim(settings.auditPrompt)}\n\n${elapsedBlock}${storyNow}`;

    // The audit needs a longer leash than a chat reply: one old/new pair for a
    // 2000-character entry already costs most of a conversational budget.
    const auditSettings = {
        ...settings,
        maxTokens: Math.max(Number(settings.maxTokens) || 0, Number(settings.auditMaxTokens) || 4096),
    };

    let findings = 0;
    let ok = 0;
    let stopped = false;
    /** @type {AuditTarget[]} */
    const missed = [];

    for (let index = 0; index < batches.length; index++) {
        if (signal?.aborted) {
            // Not every backend throws on abort — a streaming connection profile
            // resolves with the partial text instead (llm.js sendViaProfile), so an
            // aborted run reaches here normally. Everything still unread has to be
            // reported as unanswered; silently dropping whole batches from the
            // accounting is the exact failure this module exists to prevent.
            stopped = true;
            for (const remaining of batches.slice(index)) missed.push(...remaining);
            break;
        }
        const batch = batches[index];
        onBatchStart?.(index, batches.length, batch);

        const text = await sendSideRequest({
            settings: auditSettings,
            systemPrompt,
            thread: [{ role: 'user', content: renderBatch(batch, index, batches.length) }],
            signal,
            onProgress: canStream(auditSettings) && onProgress ? onProgress : null,
        });

        const coverage = parseCoverage(text, batch);
        findings += coverage.findings.length;
        ok += coverage.ok.length;
        missed.push(...coverage.missed);
        debugLog(`audit batch ${index + 1}/${batches.length}: ${coverage.findings.length} findings, ${coverage.ok.length} ok, ${coverage.missed.length} missed`);
        onBatchDone?.(String(text || ''), coverage, index);
    }

    return { findings, ok, missed, stopped };
}

/**
 * Books an audit should offer by default: everything bound to this chat.
 *
 * @returns {string[]}
 */
export function auditableBooks() {
    return getBoundLorebookNames();
}
