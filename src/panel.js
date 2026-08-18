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
/**
 * The transcript as it stood before the last regenerate or edit-and-resend, so
 * one misclick is recoverable.
 *
 * In memory only. The store is capped, and a snapshot is a second copy of the
 * whole thread; worse, a snapshot restored under a different chat would overwrite
 * a thread it never belonged to — the same trap the audit run token guards.
 *
 * @type {{messages: import('./thread.js').ThreadMessage[], threadId: string, label: string, dropped: number}|null}
 */
let undoStash = null;
/** Index of the user message currently open in an inline editor, or -1. */
let editingIndex = -1;

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

/**
 * Copy text, with a fallback for installs served over plain HTTP.
 *
 * `navigator.clipboard` is secure-context only. Reached over `http://` on a LAN
 * or VPN address it is not permission-gated, it is simply absent — and there is
 * nothing for the user to grant in browser settings, because the page never gets
 * to ask. That is a normal way to run SillyTavern, so fall back to the deprecated
 * `execCommand('copy')`, which still works in every current browser as long as it
 * runs inside a user gesture. Both callers are click handlers, and the async
 * clipboard attempt is the only await ahead of it, so the gesture survives.
 *
 * @param {string} text
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
async function copyToClipboard(text) {
    try {
        if (typeof navigator.clipboard?.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        // Present but refused — a Permissions-Policy header, or a denied
        // permission. The fallback below is not subject to either.
        debugLog('clipboard write refused, falling back', error);
    }
    return legacyCopy(text);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function legacyCopy(text) {
    if (typeof document.execCommand !== 'function') return false;

    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than hidden: a `display: none` field cannot be selected.
    // `readonly` keeps the on-screen keyboard down on the mobile layout.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    document.body.appendChild(area);

    // The copy steals the selection, so put the user's own back afterwards.
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    let copied = false;
    try {
        area.focus({ preventScroll: true });
        area.select();
        area.setSelectionRange(0, text.length);
        copied = document.execCommand('copy');
    } catch (error) {
        debugLog('execCommand copy failed', error);
    } finally {
        area.remove();
        if (selection && previous) {
            selection.removeAllRanges();
            selection.addRange(previous);
        }
    }
    return copied;
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
            <div class="btw-status-row">
                <div class="btw-status" id="btw-status"></div>
                <button type="button" class="btw-undo-btn" id="btw-undo-btn" hidden><i class="fa-solid fa-arrow-rotate-left"></i> Undo</button>
            </div>
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
    element.querySelector('#btw-undo-btn')?.addEventListener('click', onUndoClick);

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
    // The inline editor lives in the DOM and nowhere else, so a rebuild ends it.
    editingIndex = -1;
    updateUndoButton();

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

const TYPING_HTML = '<span class="btw-typing" aria-label="Waiting for the reply">●●●</span>';

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
        body.innerHTML = TYPING_HTML;
    }
    wrapper.appendChild(body);

    const missed = message.audit?.runId === auditRunId && Array.isArray(message.audit.missedIds)
        ? message.audit.missedIds.map(id => auditTargetIndex.get(id)).filter(Boolean)
        : [];
    if (missed.length) {
        wrapper.appendChild(renderAuditRetry(/** @type {import('./audit.js').AuditTarget[]} */ (missed)));
    } else if (message.role === 'user') {
        wrapper.appendChild(renderUserActions(index));
    } else if (message.role === 'assistant' && !message.meta && message.content) {
        // Error and stopped replies keep their regenerate button: a failed request
        // is the one that most needs re-sending, and the alternative was retyping.
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
            const copied = await copyToClipboard(element.querySelector('code')?.textContent || '');
            if (copied) toast(language === 'new' ? 'Replacement copied.' : 'Copied.', 'success');
            else toast('Copy failed. Select the text and copy it by hand.', 'warning');
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

    if (!message.error) {
        actions.appendChild(actionButton('fa-copy', 'Copy', async () => {
            const copied = await copyToClipboard(message.content);
            if (copied) toast('Copied.', 'success');
            else toast('Copy failed. Select the text and copy it by hand.', 'warning');
        }));
        actions.appendChild(actionButton('fa-book-medical', 'Save as lorebook entry', () => showSaveEntryDialog(message)));
    }
    actions.appendChild(actionButton(
        'fa-rotate-right',
        message.error ? 'Try this question again' : 'Regenerate this answer',
        () => regenerateFrom(index).catch(error => console.error(LOG_PREFIX, error)),
    ));

    return actions;
}

/**
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderUserActions(index) {
    const actions = document.createElement('div');
    actions.className = 'btw-message-actions btw-user-actions';
    actions.appendChild(actionButton('fa-pen-to-square', 'Edit and resend', () => beginEditUser(index)));
    return actions;
}

/**
 * @param {string} icon
 * @param {string} title
 * @param {() => void} handler
 * @returns {HTMLButtonElement}
 */
function actionButton(icon, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btw-icon-btn btw-action-btn';
    button.title = title;
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.addEventListener('click', handler);
    return button;
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
    undoStash = null;
    clearThread();
    renderTranscript();
    setStatus('');
}

// ── Composer ────────────────────────────────────────────────────────────────

function autoGrowInput() {
    const input = /** @type {HTMLTextAreaElement|null} */ (panel?.querySelector('#btw-input'));
    if (input) growTextarea(input, 180);
}

/** @param {HTMLTextAreaElement} area @param {number} max */
function growTextarea(area, max) {
    area.style.height = 'auto';
    area.style.height = `${Math.min(max, area.scrollHeight)}px`;
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

// ── Rewind: regenerate, edit and resend, undo ───────────────────────────────

/**
 * Drop `messages[index…]` so that exchange can be produced again, keeping one
 * undo snapshot.
 *
 * `replacedIndex` is the answer that is about to be regenerated anyway, so only
 * what follows it is a surprise loss — that is what earns a confirmation, and
 * that is why redoing the newest answer stays a single click.
 *
 * @param {number} index First message to drop.
 * @param {number} replacedIndex Index of the answer being redone.
 * @param {'regenerate'|'edit'} label
 * @returns {Promise<boolean>} Whether the caller may proceed.
 */
async function rewindTo(index, replacedIndex, label) {
    const tail = messages.slice(replacedIndex + 1);
    if (tail.length) {
        const reports = tail.filter(message => message.meta).length;
        const context = ctx();
        const confirmed = await context.callGenericPopup(
            `<h3>${tail.length} later message${tail.length === 1 ? '' : 's'} will be deleted</h3>
             <p>This ${label} drops the answer it replaces and everything after it${reports ? `, including ${reports} audit report${reports === 1 ? '' : 's'}` : ''}. Undo is offered once, until the next question.</p>`,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: label === 'edit' ? 'Delete and resend' : 'Delete and regenerate', cancelButton: 'Cancel' },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return false;
    }

    undoStash = { messages: messages.slice(), threadId: currentThreadId(), label, dropped: messages.length - index };
    messages = messages.slice(0, index);
    renderTranscript();
    persist();
    return true;
}

function updateUndoButton() {
    const button = panel?.querySelector('#btw-undo-btn');
    if (!(button instanceof HTMLButtonElement)) return;
    const stash = undoStash;
    const available = !!stash && !busy && stash.threadId === currentThreadId();
    button.hidden = !available;
    if (stash && available) {
        button.title = `Restore the ${stash.dropped} message${stash.dropped === 1 ? '' : 's'} dropped by the last ${stash.label}`;
    }
}

function onUndoClick() {
    if (!undoStash || busy) return;
    if (undoStash.threadId !== currentThreadId()) {
        undoStash = null;
        updateUndoButton();
        return;
    }
    messages = undoStash.messages;
    undoStash = null;
    renderTranscript();
    persist();
    setStatus('Restored.');
}

/**
 * Re-ask the question that produced the answer at `index`, dropping that answer
 * and everything after it.
 *
 * The question is not simply `index - 1`: an audit report is an assistant message
 * that belongs to the transcript but not to the conversation, so walk back past
 * any of them instead of giving up.
 *
 * @param {number} index
 */
async function regenerateFrom(index) {
    if (busy) {
        toast('The side thread is still answering.', 'warning');
        return;
    }
    let questionIndex = index - 1;
    while (questionIndex >= 0 && messages[questionIndex]?.meta) questionIndex -= 1;
    const question = messages[questionIndex];
    if (!question || question.role !== 'user') {
        toast('Cannot find the question for this answer.', 'warning');
        return;
    }

    if (!await rewindTo(questionIndex, index, 'regenerate')) return;
    await ask(question.content, { keepUndo: true });
}

/**
 * Open the user message at `index` for editing, in place. The editor is DOM-only
 * and never persisted, so any re-render ends it.
 *
 * @param {number} index
 */
function beginEditUser(index) {
    if (busy) {
        toast('The side thread is still answering.', 'warning');
        return;
    }
    cancelEdit();

    const message = messages[index];
    const wrapper = panel?.querySelector(`.btw-message[data-index="${index}"]`);
    if (!(wrapper instanceof HTMLElement) || message?.role !== 'user') return;

    editingIndex = index;
    // A user bubble is narrow and right-aligned; an editor wants the full width.
    wrapper.classList.add('btw-message-editing');
    wrapper.innerHTML = '';

    const area = document.createElement('textarea');
    area.className = 'btw-edit-area';
    area.value = message.content;
    wrapper.appendChild(area);

    const actions = document.createElement('div');
    actions.className = 'btw-edit-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'menu_button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => cancelEdit());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button';
    save.textContent = 'Save & resend';
    save.addEventListener('click', () => commitEdit(index, area.value).catch(error => console.error(LOG_PREFIX, error)));
    actions.append(cancel, save);
    wrapper.appendChild(actions);

    area.addEventListener('input', () => growTextarea(area, 240));
    area.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
        }
        if (event.key !== 'Enter' || event.shiftKey) return;
        const sendOnEnter = ctx().shouldSendOnEnter?.() ?? true;
        if (!event.ctrlKey && !event.metaKey && !sendOnEnter) return;
        event.preventDefault();
        commitEdit(index, area.value).catch(error => console.error(LOG_PREFIX, error));
    });

    growTextarea(area, 240);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
}

/** Put the edited bubble back the way it was, without touching the transcript. */
function cancelEdit() {
    if (editingIndex < 0) return;
    const index = editingIndex;
    editingIndex = -1;
    const wrapper = panel?.querySelector(`.btw-message[data-index="${index}"]`);
    const message = messages[index];
    if (wrapper instanceof HTMLElement && message) wrapper.replaceWith(renderMessage(message, index));
}

/**
 * @param {number} index
 * @param {string} value
 */
async function commitEdit(index, value) {
    const text = String(value || '').trim();
    if (!text) {
        toast('An empty message has nothing to ask.', 'warning');
        return;
    }
    // The answer to this question is replaced by definition — `index + 1`.
    if (!await rewindTo(index, index + 1, 'edit')) return;
    await ask(text, { keepUndo: true });
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
    // Undoing mid-request would restore messages the reply is still being written
    // into, so the offer waits for the request to settle.
    updateUndoButton();
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
 * @param {{keepUndo?: boolean}} [options] `keepUndo` for the resend that a
 *   regenerate or an edit just staged — every other question invalidates the
 *   snapshot, which describes a transcript this answer would not belong to.
 * @returns {Promise<string>}
 */
export async function ask(question, options = {}) {
    const text = String(question || '').trim();
    if (!text) return '';
    if (busy) {
        toast('The side thread is still answering.', 'warning');
        return '';
    }
    if (!options.keepUndo) undoStash = null;

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
 * A stream opens before there is anything to show: a connection profile hands
 * back chunks whose accumulated text is still empty, and a reasoning model can
 * sit there for a while emitting nothing renderable. Rendering that as empty
 * HTML wipes the waiting dots and leaves a blank bubble that reads as a dropped
 * request, so the indicator stays put until real text arrives.
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
    if (String(content).trim()) {
        wrapper.innerHTML = renderMarkdown(content);
        decorateCodeBlocks(wrapper);
    } else {
        wrapper.innerHTML = TYPING_HTML;
    }
    if (pinned) scrollToBottom();
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
    // An audit appends to the transcript, so the snapshot no longer describes it.
    undoStash = null;

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
    // Same reason: restoring it would write another chat's thread over this one.
    undoStash = null;
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
