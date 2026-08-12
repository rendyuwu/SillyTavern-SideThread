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
import { buildContext, renderSections, getBoundLorebookNames } from './context.js';
import { sendSideRequest, canStream } from './llm.js';

/**
 * @typedef {object} AuditTarget
 * @property {string} id Short handle the model echoes back (`E1`, `E2`, …).
 * @property {string} label Full address handed to the model.
 * @property {string} title What the author calls this thing, for the report.
 * @property {string} where Where to find it, for the report.
 * @property {'lorebook'|'card'|'persona'} kind
 * @property {string} content The text under review.
 * @property {string} [book] Lorebook file name, for lorebook targets.
 * @property {number} [uid] Entry uid, for lorebook targets.
 * @property {string[]} [keys]
 * @property {string[]} [alsoAt] Other places the identical text lives.
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
 * Merge targets whose text is identical.
 *
 * The same entry routinely lives in two places at once: a card ships with an
 * embedded `character_book`, the book also gets saved as a standalone world file,
 * and now every entry exists twice. Auditing both doubles the requests and reports
 * every finding twice.
 *
 * The duplicate is merged, not dropped silently — its location is recorded on the
 * survivor, because a fix applied to only one copy leaves the two contradicting
 * each other. Near-identical copies are left alone on purpose: they really are
 * different texts, and both need their own verdict.
 *
 * @param {any[]} targets
 * @returns {any[]}
 */
function dedupeTargets(targets) {
    /** @type {Map<string, any>} */
    const seen = new Map();
    /** @type {any[]} */
    const merged = [];

    for (const target of targets) {
        const fingerprint = String(target.content).replace(/\s+/g, ' ').trim().toLowerCase();
        const existing = seen.get(fingerprint);
        if (existing) {
            existing.alsoAt = [...(existing.alsoAt || []), target.where];
            continue;
        }
        seen.set(fingerprint, target);
        merged.push(target);
    }
    return merged;
}

/**
 * Every enabled entry of the given books, plus the card fields and persona text,
 * deduplicated. Ids are assigned after the merge so a batch carries a contiguous
 * run with no confusing gaps.
 *
 * @param {object} scope
 * @param {string[]} scope.books
 * @param {boolean} [scope.includeCard]
 * @param {boolean} [scope.includePersona]
 * @returns {Promise<AuditTarget[]>}
 */
export async function collectAuditTargets({ books, includeCard = true, includePersona = true }) {
    const context = ctx();
    /** @type {any[]} */
    const targets = [];

    /** @param {string} label @param {any} book */
    const pushBook = (label, book) => {
        for (const entry of Object.values(book?.entries || {})) {
            const record = /** @type {any} */ (entry);
            if (!record || record.disable) continue;
            const content = trim(record.content);
            if (!content) continue;
            const keys = Array.isArray(record.key) ? record.key.filter(Boolean) : [];
            // A title is a handle, not an index. Entries often carry no comment, and
            // the whole key list is sixty characters of synonyms; three is enough to
            // recognise, and the address below is what actually locates it.
            const keyLabel = keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '');
            const memo = trim(record.comment) || keyLabel || `uid ${record.uid}`;
            targets.push({
                kind: 'lorebook',
                label: `LOREBOOK "${label}" · uid ${record.uid} · ${memo}`,
                title: memo,
                where: `${label} · uid ${record.uid}`,
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

    if (includeCard) {
        for (const character of activeCharacters()) {
            for (const [field, value] of Object.entries(cardFields(character))) {
                const content = trim(value);
                if (!content) continue;
                targets.push({
                    kind: 'card',
                    label: `CHARACTER CARD "${character.name}" · field: ${field}`,
                    title: `${character.name} — card ${field}`,
                    where: `character card · ${character.name}`,
                    content,
                });
            }
        }
    }

    if (includePersona) {
        const description = trim(context.powerUserSettings?.persona_description);
        if (description) {
            targets.push({
                kind: 'persona',
                label: `USER PERSONA "${trim(context.name1) || 'User'}" · description`,
                title: `${trim(context.name1) || 'User'} — persona description`,
                where: 'user persona',
                content: description,
            });
        }
    }

    return dedupeTargets(targets).map((target, index) => ({ ...target, id: `E${index + 1}` }));
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

/**
 * Turn the raw batch reply into something an author can read.
 *
 * The `E<n>` handles and the `OK:` line exist so coverage can be proved; they mean
 * nothing to the person reading the report. "OK: E12, E13" names no entry, and a
 * heading like "#### E11 — Vess Draskel" drops the one thing needed to go and fix
 * it: which book, which uid. So the accounting is consumed here and replaced with
 * the address this module already knows — which is also more trustworthy than
 * whatever name the model chose to echo back.
 *
 * @param {string} text
 * @param {AuditTarget[]} batch
 * @returns {string}
 */
export function humanizeReport(text, batch) {
    const byId = new Map(batch.map(target => [target.id, target]));
    /** @type {string[]} */
    const unchanged = [];

    let out = String(text || '');

    out = out.replace(/^[*_#>\s-]*OK\b\s*[:：]?([^\n]*)$/gim, (line, list) => {
        const ids = [...String(list).matchAll(/\bE(\d+)\b/g)].map(match => `E${match[1]}`);
        if (!ids.length) return line;
        for (const id of ids) {
            const target = byId.get(id);
            if (target) unchanged.push(target.title);
        }
        return '';
    });

    out = out.replace(/^(#{1,6})\s*\**\s*(E\d+)\b[^\n]*$/gim, (line, hashes, id) => {
        const target = byId.get(id);
        if (!target) return line;
        // A merged duplicate has to be named: fixing one copy and not the other
        // leaves the card and the world file contradicting each other.
        const also = target.alsoAt?.length
            ? `\n\n*The identical text also lives in ${target.alsoAt.map((/** @type {string} */ where) => `\`${where}\``).join(', ')} — apply the fix there too.*`
            : '';
        return `${hashes} ${target.title}\n\n\`${target.where}\`${also}\n`;
    });

    out = out.replace(/\n{3,}/g, '\n\n').trim();

    if (unchanged.length) {
        // Asterisks, not underscores: renderMarkdown deliberately leaves `_` alone so
        // that keys and identifiers survive, so `_text_` would render literally.
        out += `${out ? '\n\n' : ''}*Unchanged: ${unchanged.join(', ')}.*`;
    }
    return out;
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

/**
 * Embedded card lore that was never imported.
 *
 * The audit deliberately does not read `data.character_book`: SillyTavern never
 * scans it either — `getCharacterLore()` resolves only the file name in
 * `data.extensions.world`, and "Import Card Lore" is what converts the embedded
 * copy into such a file. Auditing it would produce corrections the author cannot
 * apply, because the copy inside the card is unreachable from the UI.
 *
 * But "not audited" and "not there" are different things, so say when a card is
 * carrying lore the story is not using. Matched by the name ST's own importer would
 * give it; a book imported under a different name reads as unimported here, which
 * is why the wording stays about binding rather than about existence.
 *
 * @returns {{name: string, entries: number}|null}
 */
export function unimportedCardLore() {
    const context = ctx();
    const character = context.characters?.[context.characterId];
    const book = character?.data?.character_book;
    if (!book) return null;

    const name = trim(book.name) || `${trim(character.name)}'s Lorebook`;
    if (getBoundLorebookNames().includes(name)) return null;

    return { name, entries: Array.isArray(book.entries) ? book.entries.length : 0 };
}
