/**
 * The floating side-thread panel: transcript, composer and message actions.
 */

import { getSettings, debugLog, LOG_PREFIX } from './settings.js';
import { applyGeometry, makeDraggable, makeResizable, observeResize, saveGeometry, isMobileLayout, trackVisualViewport } from './geometry.js';
import { buildContext, countTokens } from './context.js';
import { sendSideRequest, canStream, canAbort } from './llm.js';
import { loadThread, saveThread, clearThread, threadForRequest, currentThreadId } from './thread.js';
import { renderMarkdown, escapeHtml, extractCodeBlocks } from './markdown.js';
import { listLorebooks, createLorebookEntry } from './lorebook.js';
import { auditableBooks, batchTargets, buildStoryNow, collectAuditTargets, humanizeReport, runAudit, unimportedCardLore } from './audit.js';

const PANEL_ID = 'btw-panel';
const GEOMETRY_KEY = 'btw_panel_geometry';
const OPEN_KEY = 'btw_panel_open';
const COLLAPSED_KEY = 'btw_panel_collapsed';

const QUICK_PROMPTS = [
    { label: 'Lore check', text: 'Based on everything established so far, walk me through the lore of this world. Flag anything contradictory or unresolved.' },
    { label: 'Who is…', text: 'Summarise what we know about this character so far, including what is only implied: ' },
    { label: 'New NPC', text: 'Design a new NPC who fits this world and could plausibly enter the story now. Give name, role, appearance, voice, what they want, what they are hiding, and how the cast could meet them. Then draft a lorebook entry for them.' },
    { label: "What's next", text: 'Given the current scene, suggest three ways this could develop next, each with a different tone, and what each would cost the characters.' },
    { label: 'Push back', text: 'Here is what I am planning to do next in the story. Tell me honestly where it is weak, what it would cost, and what you would do instead:\n\n' },
    { label: 'Complication', text: 'Suggest three complications that could land on the current scene: one growing out of a choice the cast already made, one from the world reacting to what they did, and one nobody in the story could have planned for. Say what each would cost.' },
    { label: 'Lorebook draft', text: 'Turn what we worked out in this side thread into a lorebook entry, ready to save as-is.' },
    { label: 'Continuity', text: 'Go through the context for continuity problems: contradictions, facts that changed without explanation, setups that were dropped, and characters who have stopped wanting anything. Worst first.' },
];

/** @type {HTMLElement|null} */
let panel = null;
/** @type {import('./thread.js').ThreadMessage[]} */
let messages = [];
/** @type {AbortController|null} */
let abortController = null;
/** @type {(() => void)|null} */
let teardownDrag = null;
/** @type {(() => void)|null} */
let teardownViewport = null;
/** @type {ResizeObserver|null} */
let resizeObserver = null;
let busy = false;
/**
 * Audit targets from the most recent collection, so the "unanswered targets"
 * button can re-send them. Only ids are persisted with the transcript — the full
 * texts would bloat localStorage — so the button disappears after a page reload.
 *
 * Ids are positional (`E1`, `E2`, …) and therefore collide across runs, so each
 * run gets a token and a stored summary only offers its button while that token is
 * still current. Changing chat invalidates everything: a persisted summary from
 * another chat must never resolve against this chat's targets.
 *
 * @type {Map<string, import('./audit.js').AuditTarget>}
 */
let auditTargetIndex = new Map();
let auditRunId = 0;
let lastAuditElapsed = '';

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/** @param {string} message @param {'info'|'success'|'warning'|'error'} [level] */
function toast(message, level = 'info') {
    const notifier = /** @type {any} */ (globalThis).toastr;
    if (notifier?.[level]) notifier[level](message, 'BTW');
    else console.log(LOG_PREFIX, message);
}

// ── Construction ─────────────────────────────────────────────────────────────

function panelHtml() {
    return `
        <div class="btw-header" id="btw-header">
            <div class="btw-header-left">
                <i class="fa-solid fa-comments" aria-hidden="true"></i>
                <span class="btw-title">Side Thread</span>
                <span class="btw-context-label" id="btw-context-label"></span>
            </div>
            <div class="btw-header-right">
                <button type="button" class="btw-icon-btn" id="btw-audit-btn" title="Audit the lore for what the story has outgrown"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button type="button" class="btw-icon-btn" id="btw-preview-btn" title="Preview the context that will be sent"><i class="fa-solid fa-eye"></i></button>
                <button type="button" class="btw-icon-btn" id="btw-clear-btn" title="Clear this side thread"><i class="fa-solid fa-trash-can"></i></button>
                <button type="button" class="btw-icon-btn" id="btw-collapse-btn" title="Collapse" aria-expanded="true"><i class="fa-solid fa-chevron-up"></i></button>
                <button type="button" class="btw-icon-btn" id="btw-close-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="btw-body">
            <div class="btw-transcript" id="btw-transcript" role="log" aria-live="polite"></div>
            <div class="btw-chips" id="btw-chips"></div>
            <div class="btw-composer">
                <textarea id="btw-input" rows="2" placeholder="Ask about the lore, plan an NPC, sanity-check the plot…"></textarea>
                <div class="btw-composer-actions">
                    <button type="button" class="btw-send-btn" id="btw-send-btn" title="Send" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
            </div>
            <div class="btw-status" id="btw-status"></div>
        </div>
        <div class="btw-resizer btw-resizer-bl" title="Resize"></div>
        <div class="btw-resizer btw-resizer-br" title="Resize"></div>
    `;
}

function createPanel() {
    if (panel) return panel;

    const element = document.createElement('div');
    element.id = PANEL_ID;
    element.className = 'btw-panel';
    element.innerHTML = panelHtml();
    document.body.appendChild(element);
    panel = element;

    applyFontSize();

    const header = /** @type {HTMLElement} */ (element.querySelector('#btw-header'));
    teardownDrag = makeDraggable(element, header, GEOMETRY_KEY);
    const resizerBr = element.querySelector('.btw-resizer-br');
    const resizerBl = element.querySelector('.btw-resizer-bl');
    if (resizerBr instanceof HTMLElement) makeResizable(element, resizerBr, GEOMETRY_KEY, 'br');
    if (resizerBl instanceof HTMLElement) makeResizable(element, resizerBl, GEOMETRY_KEY, 'bl');
    resizeObserver = observeResize(element, GEOMETRY_KEY);

    element.querySelector('#btw-close-btn')?.addEventListener('click', closePanel);
    element.querySelector('#btw-collapse-btn')?.addEventListener('click', toggleCollapse);
    element.querySelector('#btw-clear-btn')?.addEventListener('click', onClearClick);
    element.querySelector('#btw-preview-btn')?.addEventListener('click', showContextPreview);
    element.querySelector('#btw-audit-btn')?.addEventListener('click', () => showAuditDialog());
    element.querySelector('#btw-send-btn')?.addEventListener('click', onComposerAction);

    const input = /** @type {HTMLTextAreaElement} */ (element.querySelector('#btw-input'));
    input.addEventListener('keydown', onInputKeyDown);
    input.addEventListener('input', autoGrowInput);

    renderChips();
    applyGeometry(element, GEOMETRY_KEY);
    teardownViewport = trackVisualViewport(element, onVisualViewportChange);
    if (localStorage.getItem(COLLAPSED_KEY) === 'true') setCollapsed(true);

    window.addEventListener('resize', onWindowResize);
    return element;
}

function onWindowResize() {
    if (!panel || panel.style.display === 'none') return;
    applyGeometry(panel, GEOMETRY_KEY);
}

/**
 * The keyboard has just resized the sheet under us. The transcript keeps its
 * scrollTop while losing height, so the newest message slides out of view right
 * when the user is typing at it.
 */
function onVisualViewportChange() {
    const input = panel?.querySelector('#btw-input');
    if (input && document.activeElement === input) scrollToBottom();
}

function applyFontSize() {
    if (!panel) return;
    panel.style.setProperty('--btw-font-size', `${Number(getSettings().fontSize) || 14}px`);
}

function renderChips() {
    const container = panel?.querySelector('#btw-chips');
    if (!(container instanceof HTMLElement)) return;
    container.innerHTML = '';
    for (const prompt of QUICK_PROMPTS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'btw-chip';
        chip.textContent = prompt.label;
        chip.addEventListener('click', () => {
            const input = /** @type {HTMLTextAreaElement|null} */ (panel?.querySelector('#btw-input'));
            if (!input) return;
            // A chip frames what the author is already typing rather than replacing it:
            // half a question in the box used to be wiped by one stray click.
            const existing = input.value.trim();
            input.value = existing ? `${prompt.text.trim()}\n\n${existing}` : prompt.text;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            autoGrowInput();
        });
        container.appendChild(chip);
    }
}

// ── Open / close / collapse ──────────────────────────────────────────────────

export function isPanelOpen() {
    return !!panel && panel.style.display !== 'none';
}

export function openPanel() {
    const element = createPanel();
    element.style.display = 'flex';
    localStorage.setItem(OPEN_KEY, 'true');
    applyGeometry(element, GEOMETRY_KEY);
    updateContextLabel();
    if (!messages.length) reloadThread();
    else renderTranscript();
    /** @type {HTMLTextAreaElement|null} */ (element.querySelector('#btw-input'))?.focus();
}

export function closePanel() {
    if (!panel) return;
    stopGeneration();
    saveGeometry(panel, GEOMETRY_KEY);
    panel.style.display = 'none';
    localStorage.setItem(OPEN_KEY, 'false');
}

export function togglePanel() {
    if (isPanelOpen()) closePanel();
    else openPanel();
}

/** @param {boolean} collapsed */
function setCollapsed(collapsed) {
    if (!panel) return;
    panel.classList.toggle('btw-collapsed', collapsed);
    const button = panel.querySelector('#btw-collapse-btn');
    if (button instanceof HTMLElement) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.title = collapsed ? 'Expand' : 'Collapse';
        button.innerHTML = `<i class="fa-solid fa-chevron-${collapsed ? 'down' : 'up'}"></i>`;
    }
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    if (!collapsed) applyGeometry(panel, GEOMETRY_KEY);
}

function toggleCollapse() {
    setCollapsed(!panel?.classList.contains('btw-collapsed'));
}

// ── Transcript ───────────────────────────────────────────────────────────────

function updateContextLabel() {
    const label = panel?.querySelector('#btw-context-label');
    if (!(label instanceof HTMLElement)) return;
    const context = ctx();
    const name = context.groupId
        ? (context.groups?.find((/** @type {any} */ g) => g.id === context.groupId)?.name || 'Group')
        : (context.characters?.[context.characterId]?.name || 'No character');
    const settings = getSettings();
    const source = settings.connectionSource === 'profile'
        ? 'profile'
        : settings.connectionSource === 'default' ? 'main API' : settings.connectionSource;
    label.textContent = `${name} · ${source}`;
    label.title = `Context: ${name}\nBackend: ${source}\nChat: ${currentThreadId()}`;
}

/** @param {string} text */
function setStatus(text) {
    const status = panel?.querySelector('#btw-status');
    if (status instanceof HTMLElement) status.textContent = text || '';
}

function renderTranscript() {
    const transcript = panel?.querySelector('#btw-transcript');
    if (!(transcript instanceof HTMLElement)) return;

    if (!messages.length) {
        const name = String(getSettings().buddyName || '').trim();
        transcript.innerHTML = `
            <div class="btw-empty">
                <p><strong>${name ? `${escapeHtml(name)} is listening` : 'Out-of-character side thread'} — off the record.</strong></p>
                <p>This conversation is invisible to the roleplay. It carries the active character card, the persona, the lorebooks and the chat history, so you can argue about the story instead of writing inside it.</p>
                <p>Ask for an NPC, poke at the plot, or float an idea you are not sure about. Nothing here is ever sent to the main chat.</p>
            </div>`;
        return;
    }

    transcript.innerHTML = '';
    messages.forEach((message, index) => transcript.appendChild(renderMessage(message, index)));
    scrollToBottom();
}

/**
 * @param {import('./thread.js').ThreadMessage} message
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderMessage(message, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `btw-message btw-message-${message.role}${message.error ? ' btw-message-error' : ''}${message.meta ? ' btw-message-meta' : ''}`;
    wrapper.dataset.index = String(index);

    const body = document.createElement('div');
    body.className = 'btw-message-body';
    if (message.role === 'user') {
        body.innerHTML = `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`;
    } else if (message.content) {
        body.innerHTML = renderMarkdown(message.content);
        decorateCodeBlocks(body);
    } else {
        body.innerHTML = '<span class="btw-typing" aria-label="Waiting for the reply">●●●</span>';
    }
    wrapper.appendChild(body);

    const missed = message.audit?.runId === auditRunId && Array.isArray(message.audit.missedIds)
        ? message.audit.missedIds.map(id => auditTargetIndex.get(id)).filter(Boolean)
        : [];
    if (missed.length) {
        wrapper.appendChild(renderAuditRetry(/** @type {import('./audit.js').AuditTarget[]} */ (missed)));
    } else if (message.role === 'assistant' && !message.error && !message.meta && message.content) {
        wrapper.appendChild(renderMessageActions(message, index));
    }
    return wrapper;
}

/**
 * A copy button per fenced block, and an OLD/NEW badge on audit diffs. The audit
 * workflow is replace-by-hand, so the replacement has to be one click away; the
 * badge comes free because renderMarkdown already forwards the fence language to
 * `data-lang`.
 *
 * The button lives in a wrapper rather than inside the `<pre>`: the `<pre>` scrolls,
 * and anything positioned inside it would scroll away with the content.
 *
 * @param {HTMLElement} container
 */
function decorateCodeBlocks(container) {
    for (const element of container.querySelectorAll('pre.btw-code')) {
        if (!(element instanceof HTMLElement) || element.parentElement?.classList.contains('btw-code-wrap')) continue;

        const language = element.dataset.lang || '';
        const diff = language === 'old' || language === 'new';

        const wrap = document.createElement('div');
        wrap.className = 'btw-code-wrap';
        if (diff) wrap.dataset.lang = language;
        element.replaceWith(wrap);
        wrap.appendChild(element);

        if (diff) {
            const badge = document.createElement('span');
            badge.className = 'btw-code-badge';
            badge.textContent = language.toUpperCase();
            wrap.appendChild(badge);
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btw-icon-btn btw-code-copy';
        button.title = language === 'new' ? 'Copy the replacement' : 'Copy';
        button.innerHTML = '<i class="fa-solid fa-copy"></i>';
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(element.querySelector('code')?.textContent || '');
                toast(language === 'new' ? 'Replacement copied.' : 'Copied.', 'success');
            } catch {
                toast('Clipboard blocked by the browser.', 'warning');
            }
        });
        wrap.appendChild(button);
    }
}

/**
 * @param {import('./audit.js').AuditTarget[]} targets
 * @returns {HTMLElement}
 */
function renderAuditRetry(targets) {
    // Not a hover-reveal row: an unanswered-coverage warning has to stay visible.
    const actions = document.createElement('div');
    actions.className = 'btw-message-actions btw-audit-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button btw-audit-retry';
    button.textContent = `Audit the ${targets.length} unanswered target${targets.length === 1 ? '' : 's'}`;
    button.addEventListener('click', () => {
        startAudit({ targets, elapsed: lastAuditElapsed }).catch(error => console.error(LOG_PREFIX, error));
    });
    actions.appendChild(button);
    return actions;
}

/**
 * @param {import('./thread.js').ThreadMessage} message
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderMessageActions(message, index) {
    const actions = document.createElement('div');
    actions.className = 'btw-message-actions';

    /** @param {string} icon @param {string} title @param {() => void} handler */
    const add = (icon, title, handler) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btw-icon-btn btw-action-btn';
        button.title = title;
        button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        button.addEventListener('click', handler);
        actions.appendChild(button);
    };

    add('fa-copy', 'Copy', async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            toast('Copied.', 'success');
        } catch {
            toast('Clipboard blocked by the browser.', 'warning');
        }
    });
    add('fa-book-medical', 'Save as lorebook entry', () => showSaveEntryDialog(message));
    add('fa-rotate-right', 'Regenerate this answer', () => regenerateFrom(index));

    return actions;
}

function scrollToBottom() {
    const transcript = panel?.querySelector('#btw-transcript');
    if (transcript instanceof HTMLElement) transcript.scrollTop = transcript.scrollHeight;
}

function persist() {
    if (getSettings().persistThreads) saveThread(messages);
}

export function reloadThread() {
    messages = getSettings().persistThreads ? loadThread() : [];
    renderTranscript();
    updateContextLabel();
}

function onClearClick() {
    if (!messages.length) return;
    messages = [];
    clearThread();
    renderTranscript();
    setStatus('');
}

// ── Composer ────────────────────────────────────────────────────────────────

function autoGrowInput() {
    const input = /** @type {HTMLTextAreaElement|null} */ (panel?.querySelector('#btw-input'));
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
}

/** @param {KeyboardEvent} event */
function onInputKeyDown(event) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    const sendOnEnter = ctx().shouldSendOnEnter?.() ?? true;
    if (!event.ctrlKey && !event.metaKey && !sendOnEnter) return;
    event.preventDefault();
    onSendClick();
}

/**
 * The composer has one button, not two. While a reply is in flight it is the
 * stop button; otherwise it sends. Two buttons that hide each other invite the
 * hidden-attribute trap, and on a narrow panel they cost width for nothing.
 */
function onComposerAction() {
    if (busy) stopGeneration();
    else onSendClick();
}

function onSendClick() {
    const input = /** @type {HTMLTextAreaElement|null} */ (panel?.querySelector('#btw-input'));
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    // ask() refuses while busy, so clearing the box first would eat the question.
    if (busy) {
        toast('The side thread is still answering.', 'warning');
        return;
    }
    input.value = '';
    autoGrowInput();
    ask(text).catch(error => console.error(LOG_PREFIX, error));
}

/** @param {boolean} value */
function setBusy(value) {
    busy = value;
    const send = panel?.querySelector('#btw-send-btn');
    if (!(send instanceof HTMLButtonElement)) return;
    // `default` cannot abort, so it stays a disabled Send rather than a dead Stop.
    const canStop = value && canAbort(getSettings());
    const label = canStop ? 'Stop' : 'Send';
    send.classList.toggle('btw-stop-btn', canStop);
    send.disabled = value && !canStop;
    send.title = label;
    send.setAttribute('aria-label', label);
    send.innerHTML = `<i class="fa-solid ${canStop ? 'fa-stop' : 'fa-paper-plane'}"></i>`;
}

export function stopGeneration() {
    if (!abortController) return;
    try { abortController.abort(); } catch { /* already aborted */ }
    abortController = null;
}

/**
 * Ask a side question. Renders into the panel and returns the answer so the
 * /btw slash command can pipe it.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function ask(question) {
    const text = String(question || '').trim();
    if (!text) return '';
    if (busy) {
        toast('The side thread is still answering.', 'warning');
        return '';
    }

    openPanel();
    const settings = getSettings();

    messages.push({ role: 'user', content: text, ts: Date.now() });
    /** @type {import('./thread.js').ThreadMessage} */
    const reply = { role: 'assistant', content: '', ts: Date.now() };
    messages.push(reply);
    renderTranscript();

    setBusy(true);
    setStatus('Assembling context…');
    abortController = new AbortController();

    try {
        const built = await buildContext(settings);
        debugLog(`context: ${built.sections.length} sections, ${built.chars} chars`);
        setStatus(canStream(settings) ? 'Streaming…' : 'Thinking…');

        const replyIndex = messages.indexOf(reply);
        const onProgress = canStream(settings)
            ? (/** @type {string} */ full) => {
                reply.content = full;
                updateMessageBody(replyIndex, full);
            }
            : null;

        const answer = await sendSideRequest({
            settings,
            systemPrompt: built.systemPrompt,
            thread: threadForRequest(messages.slice(0, -1), settings.sideThreadTurns),
            signal: abortController.signal,
            onProgress,
        });

        reply.content = String(answer || '').trim();
        if (!reply.content) {
            reply.content = '*(empty response — the backend returned nothing. Check the max response length and the selected model.)*';
            reply.error = true;
        }
        setStatus('');
    } catch (error) {
        const aborted = /** @type {any} */ (error)?.name === 'AbortError' || abortController?.signal.aborted;
        // renderMarkdown escapes its input, so the raw message goes in as-is.
        reply.content = aborted
            ? '*(stopped)*'
            : `**Request failed:** ${/** @type {any} */ (error)?.message || String(error)}`;
        reply.error = true;
        if (!aborted) console.error(LOG_PREFIX, error);
        setStatus('');
    } finally {
        abortController = null;
        setBusy(false);
        renderTranscript();
        persist();
    }

    return reply.error ? '' : reply.content;
}

/**
 * Patch one bubble in place instead of re-rendering the whole transcript, so
 * streaming does not fight the scroll position.
 *
 * @param {number} index
 * @param {string} content
 */
function updateMessageBody(index, content) {
    const transcript = panel?.querySelector('#btw-transcript');
    if (!(transcript instanceof HTMLElement)) return;
    const wrapper = transcript.querySelector(`.btw-message[data-index="${index}"] .btw-message-body`);
    if (!(wrapper instanceof HTMLElement)) return;
    const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    wrapper.innerHTML = renderMarkdown(content);
    decorateCodeBlocks(wrapper);
    if (pinned) scrollToBottom();
}

/**
 * Re-ask the question that produced the answer at `index`, dropping that answer
 * and everything after it.
 *
 * @param {number} index
 */
async function regenerateFrom(index) {
    if (busy) return;
    const question = messages[index - 1];
    if (!question || question.role !== 'user') {
        toast('Cannot find the question for this answer.', 'warning');
        return;
    }
    messages = messages.slice(0, index - 1);
    renderTranscript();
    persist();
    await ask(question.content);
}

// ── Stale-lore audit ────────────────────────────────────────────────────────

async function showAuditDialog() {
    if (busy) {
        toast('The side thread is still working.', 'warning');
        return;
    }

    const context = ctx();
    const bound = auditableBooks();
    const rest = listLorebooks().filter(name => !bound.includes(name));

    const form = document.createElement('div');
    form.className = 'btw-entry-form btw-audit-form';
    form.innerHTML = `
        <h3>Audit stale lore</h3>
        <p class="btw-hint">
            Compares the reference material against the story as it now stands, and reports verbatim
            old → new spans. Nothing is written for you — you paste the replacements yourself.
        </p>
        <label>How much in-story time has passed?
            <span class="btw-hint">Optional, but ages and dates cannot be recomputed without it.</span>
            <input id="btw-audit-elapsed" class="text_pole" placeholder="e.g. roughly a year since the Frosthollow arc">
        </label>
        <div class="btw-audit-books">
            <strong>Lorebooks</strong>
            ${[...bound, ...rest].length
                ? [...bound, ...rest].map(name => `<label class="btw-checkbox"><input type="checkbox" class="btw-audit-book" value="${escapeHtml(name)}"${bound.includes(name) ? ' checked' : ''}> ${escapeHtml(name)}${bound.includes(name) ? ' <span class="btw-hint">bound to this chat</span>' : ''}</label>`).join('')
                : '<p class="btw-hint">No lorebooks found.</p>'}
        </div>
        <label class="btw-checkbox"><input type="checkbox" id="btw-audit-card" checked> Character card fields <span class="btw-hint">description, personality, scenario — where a faded boundary usually hides</span></label>
        <label class="btw-checkbox"><input type="checkbox" id="btw-audit-persona" checked> User persona description</label>
    `;

    const result = await context.callGenericPopup(form, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Run audit',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;

    const books = [...form.querySelectorAll('.btw-audit-book')]
        .filter(element => element instanceof HTMLInputElement && element.checked)
        .map(element => /** @type {HTMLInputElement} */ (element).value);

    await startAudit({
        books,
        includeCard: /** @type {HTMLInputElement} */ (form.querySelector('#btw-audit-card')).checked,
        includePersona: /** @type {HTMLInputElement} */ (form.querySelector('#btw-audit-persona')).checked,
        elapsed: /** @type {HTMLInputElement} */ (form.querySelector('#btw-audit-elapsed')).value.trim(),
    });
}

/**
 * @param {string} content
 * @param {Record<string, any>} [extra]
 */
function pushAuditNote(content, extra = {}) {
    messages.push({ role: 'assistant', content, ts: Date.now(), meta: true, ...extra });
    renderTranscript();
}

/**
 * Run an audit and report it into the transcript, batch by batch.
 *
 * @param {object} scope
 * @param {string[]} [scope.books]
 * @param {boolean} [scope.includeCard]
 * @param {boolean} [scope.includePersona]
 * @param {string} [scope.elapsed]
 * @param {import('./audit.js').AuditTarget[]} [scope.targets] Pre-collected, for a re-run of missed targets.
 */
async function startAudit(scope) {
    if (busy) {
        toast('The side thread is still working.', 'warning');
        return;
    }

    openPanel();
    const settings = getSettings();
    lastAuditElapsed = scope.elapsed ?? lastAuditElapsed;

    setBusy(true);
    setStatus('Collecting targets…');
    abortController = new AbortController();

    try {
        const targets = scope.targets ?? await collectAuditTargets({
            books: scope.books || [],
            includeCard: scope.includeCard,
            includePersona: scope.includePersona,
        });
        if (!targets.length) {
            toast('Nothing to audit: no enabled entries or card text in the selected scope.', 'info');
            return;
        }
        // Fresh index per run: `E4` from a previous collection is a different entry.
        auditRunId += 1;
        auditTargetIndex = new Map(targets.map(target => [target.id, target]));

        const batches = batchTargets(targets, settings.auditBatchChars);
        setStatus('Assembling the story so far…');
        const storyNow = await buildStoryNow(settings);

        // The story block is re-sent with every batch, so its size is the real bill.
        const duplicates = targets.reduce((total, target) => total + (target.alsoAt?.length || 0), 0);
        const orphanLore = unimportedCardLore();
        pushAuditNote([
            `**Lore audit** — ${targets.length} target${targets.length === 1 ? '' : 's'}${duplicates ? ` (${duplicates} duplicate${duplicates === 1 ? '' : 's'} merged)` : ''} across ${batches.length} request${batches.length === 1 ? '' : 's'}, story context ${storyNow.length.toLocaleString()} chars each.`,
            lastAuditElapsed ? `In-story time elapsed: ${lastAuditElapsed}` : '*No elapsed time given — ages cannot be recomputed reliably.*',
            orphanLore
                ? `*The card carries an embedded lorebook ("${orphanLore.name}", ${orphanLore.entries} entries) that is not bound to this chat. SillyTavern never reads embedded lore directly, so the story is not using it and it is not audited — use "Import Card Lore" on the character panel if it should be.*`
                : '',
        ].filter(Boolean).join('\n\n'));

        /** @type {import('./thread.js').ThreadMessage|null} */
        let current = null;
        let currentIndex = -1;

        const outcome = await runAudit({
            settings,
            batches,
            storyNow,
            elapsed: lastAuditElapsed,
            signal: abortController.signal,
            onBatchStart: (index, total, batch) => {
                setStatus(`Auditing batch ${index + 1}/${total} — ${batch.length} target${batch.length === 1 ? '' : 's'}…`);
                current = { role: 'assistant', content: '', ts: Date.now(), meta: true };
                messages.push(current);
                currentIndex = messages.length - 1;
                renderTranscript();
            },
            onProgress: text => {
                if (!current) return;
                current.content = text;
                updateMessageBody(currentIndex, text);
            },
            onBatchDone: (text, coverage, index) => {
                if (!current) return;
                // Streaming showed the raw reply, ids and all; the settled version
                // trades the coverage plumbing for names and addresses.
                const report = humanizeReport(text, batches[index]);
                const notes = coverage.missed.length
                    ? `\n\n*Never ruled on in this batch: ${coverage.missed.map(target => target.title).join(', ')}.*`
                    : '';
                current.content = `${report || '*(the backend returned nothing for this batch)*'}${notes}`;
                renderTranscript();
                persist();
            },
        });

        const lines = [`**Audit ${outcome.stopped ? 'stopped' : 'finished'}** — ${outcome.findings} stale, ${outcome.ok} unchanged, out of ${targets.length} target${targets.length === 1 ? '' : 's'}.`];
        if (outcome.missed.length) {
            lines.push(
                `**${outcome.missed.length} target${outcome.missed.length === 1 ? '' : 's'} were never ruled on.** Not "clean" — simply unanswered:`,
                outcome.missed.map(target => `- **${target.title}** — \`${target.where}\``).join('\n'),
            );
        }
        pushAuditNote(
            lines.join('\n\n'),
            outcome.missed.length ? { audit: { missedIds: outcome.missed.map(target => target.id), runId: auditRunId } } : {},
        );
        setStatus('');
    } catch (error) {
        const aborted = /** @type {any} */ (error)?.name === 'AbortError' || abortController?.signal.aborted;
        pushAuditNote(aborted ? '*(audit stopped)*' : `**Audit failed:** ${/** @type {any} */ (error)?.message || String(error)}`);
        if (!aborted) console.error(LOG_PREFIX, error);
        setStatus('');
    } finally {
        abortController = null;
        setBusy(false);
        renderTranscript();
        persist();
    }
}

// ── Context preview ─────────────────────────────────────────────────────────

async function showContextPreview() {
    const settings = getSettings();
    setStatus('Building preview…');
    try {
        const built = await buildContext(settings);
        const { count, estimated } = await countTokens(built.systemPrompt);
        setStatus('');

        const container = document.createElement('div');
        container.className = 'btw-preview';
        const rows = built.sections
            .map(section => `<tr><td>${escapeHtml(section.title)}</td><td class="btw-preview-num">${section.body.length.toLocaleString()}</td></tr>`)
            .join('');
        container.innerHTML = `
            <h3>Context sent with every side question</h3>
            <p class="btw-preview-summary">
                ${built.sections.length} sections · ${built.chars.toLocaleString()} characters ·
                ${estimated ? '~' : ''}${count.toLocaleString()} tokens${estimated ? ' (estimated)' : ''}
            </p>
            <table class="btw-preview-table"><thead><tr><th>Section</th><th class="btw-preview-num">Chars</th></tr></thead><tbody>${rows}</tbody></table>
            <h4>Raw system prompt</h4>
            <textarea class="btw-preview-raw" readonly rows="18"></textarea>
        `;
        const raw = container.querySelector('.btw-preview-raw');
        if (raw instanceof HTMLTextAreaElement) raw.value = built.systemPrompt;

        const context = ctx();
        await context.callGenericPopup(container, context.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    } catch (error) {
        setStatus('');
        console.error(LOG_PREFIX, error);
        toast(`Preview failed: ${/** @type {any} */ (error)?.message || error}`, 'error');
    }
}

// ── Save as lorebook entry ──────────────────────────────────────────────────

/**
 * The system prompt asks for `TITLE:` and `KEYS:` lines just above the fenced
 * entry body, so read them back instead of making the author retype them. Models
 * like to bold those labels, and some put the pair inside the fence despite being
 * told not to — searching the whole message covers both.
 *
 * @param {string} content
 * @returns {{title: string, keys: string}}
 */
function parseEntryHeader(content) {
    const source = String(content || '');
    const read = (/** @type {string} */ label) => {
        const match = source.match(new RegExp(`^\\s*[*_#>\\s-]*${label}\\s*[:：]\\s*(.+)$`, 'im'));
        return String(match?.[1] || '').replace(/[*_`]/g, '').trim();
    };
    return { title: read('TITLE'), keys: read('KEYS') };
}

/** @param {import('./thread.js').ThreadMessage} message */
async function showSaveEntryDialog(message) {
    const context = ctx();
    const books = listLorebooks();
    const bound = (() => {
        const character = context.characters?.[context.characterId];
        return String(character?.data?.extensions?.world || context.chatMetadata?.world_info || '');
    })();
    const codeBlocks = extractCodeBlocks(message.content);
    const defaultBody = codeBlocks[0] || message.content;
    const header = parseEntryHeader(message.content);

    const form = document.createElement('div');
    form.className = 'btw-entry-form';
    form.innerHTML = `
        <h3>Save as lorebook entry</h3>
        <label>Lorebook
            <input id="btw-entry-book" class="text_pole" list="btw-entry-books" placeholder="Book name (a new book is created if unknown)">
            <datalist id="btw-entry-books">${books.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
        </label>
        <label>Title / memo
            <input id="btw-entry-title" class="text_pole" placeholder="e.g. Marla, the harbour fence">
        </label>
        <label>Keys <span class="btw-hint">comma separated — leave empty and tick "always on" for a constant entry</span>
            <input id="btw-entry-keys" class="text_pole" placeholder="Marla, the fence, harbour contact">
        </label>
        <label class="btw-checkbox"><input type="checkbox" id="btw-entry-constant"> Always on (constant entry)</label>
        ${codeBlocks.length > 1 ? `<label>Drafted block <span class="btw-hint">${codeBlocks.length} fenced blocks in this answer</span>
            <select id="btw-entry-block" class="text_pole">
                ${codeBlocks.map((block, index) => `<option value="${index}">${index + 1}. ${escapeHtml(block.split('\n')[0].slice(0, 70))}</option>`).join('')}
            </select>
        </label>` : ''}
        <label>Content
            <textarea id="btw-entry-content" class="text_pole" rows="12"></textarea>
        </label>
    `;

    const bookInput = /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-book'));
    bookInput.value = bound && books.includes(bound) ? bound : (books[0] || '');
    /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-title')).value = header.title;
    /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-keys')).value = header.keys;

    const contentArea = /** @type {HTMLTextAreaElement} */ (form.querySelector('#btw-entry-content'));
    contentArea.value = defaultBody;

    const blockPicker = form.querySelector('#btw-entry-block');
    if (blockPicker instanceof HTMLSelectElement) {
        blockPicker.addEventListener('change', () => {
            contentArea.value = codeBlocks[Number(blockPicker.value)] || contentArea.value;
        });
    }

    const result = await context.callGenericPopup(form, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save entry',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;

    const book = bookInput.value.trim();
    const title = /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-title')).value.trim();
    const keys = /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-keys')).value.split(',');
    const constant = /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-constant')).checked;
    const content = /** @type {HTMLTextAreaElement} */ (form.querySelector('#btw-entry-content')).value;

    try {
        const saved = await createLorebookEntry({ book, keys, title, content, constant });
        const disabled = !constant && !keys.join('').trim();
        toast(
            disabled
                ? `Saved to "${saved.book}" as a disabled entry — it has no keys, so add some in World Info.`
                : `Saved to "${saved.book}".`,
            disabled ? 'warning' : 'success',
        );
    } catch (error) {
        console.error(LOG_PREFIX, error);
        toast(`Save failed: ${/** @type {any} */ (error)?.message || error}`, 'error');
    }
}

// ── Lifecycle hooks used by index.js ────────────────────────────────────────

export function onChatChanged() {
    // Invalidate audit targets even when the panel was never built: they describe
    // the chat we just left, and its ids would resolve against the wrong entries.
    auditTargetIndex = new Map();
    auditRunId += 1;
    if (!panel) return;
    stopGeneration();
    setBusy(false);
    reloadThread();
}

export function onSettingsChanged() {
    applyFontSize();
    updateContextLabel();
    setBusy(busy);
}

export function restoreIfPreviouslyOpen() {
    if (localStorage.getItem(OPEN_KEY) !== 'true') return;
    // Mobile starts closed: a full-screen sheet on load hides the chat.
    if (isMobileLayout()) {
        localStorage.setItem(OPEN_KEY, 'false');
        return;
    }
    openPanel();
}

export function destroyPanel() {
    stopGeneration();
    teardownDrag?.();
    teardownViewport?.();
    teardownViewport = null;
    resizeObserver?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    panel?.remove();
    panel = null;
}
