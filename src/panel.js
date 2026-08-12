/**
 * The floating side-thread panel: transcript, composer and message actions.
 */

import { getSettings, debugLog, LOG_PREFIX } from './settings.js';
import { applyGeometry, makeDraggable, makeResizable, observeResize, saveGeometry, isMobileLayout } from './geometry.js';
import { buildContext, countTokens } from './context.js';
import { sendSideRequest, canStream, canAbort } from './llm.js';
import { loadThread, saveThread, clearThread, threadForRequest, currentThreadId } from './thread.js';
import { renderMarkdown, escapeHtml, extractCodeBlocks } from './markdown.js';
import { listLorebooks, createLorebookEntry } from './lorebook.js';

const PANEL_ID = 'btw-panel';
const GEOMETRY_KEY = 'btw_panel_geometry';
const OPEN_KEY = 'btw_panel_open';
const COLLAPSED_KEY = 'btw_panel_collapsed';

const QUICK_PROMPTS = [
    { label: 'Lore check', text: 'Based on everything established so far, walk me through the lore of this world. Flag anything contradictory or unresolved.' },
    { label: 'Who is…', text: 'Summarise what we know about this character so far, including what is only implied: ' },
    { label: 'New NPC', text: 'Design a new NPC who fits this world and could plausibly enter the story now. Give name, role, appearance, voice, motivation, secret, and a hook for meeting them. Then draft a lorebook entry for them in a fenced block.' },
    { label: "What's next", text: 'Given the current scene, suggest three ways this could develop next, each with a different tone, and what each would cost the characters.' },
];

/** @type {HTMLElement|null} */
let panel = null;
/** @type {import('./thread.js').ThreadMessage[]} */
let messages = [];
/** @type {AbortController|null} */
let abortController = null;
/** @type {(() => void)|null} */
let teardownDrag = null;
/** @type {ResizeObserver|null} */
let resizeObserver = null;
let busy = false;

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
                    <button type="button" class="btw-send-btn" id="btw-send-btn" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
                    <button type="button" class="btw-send-btn btw-stop-btn" id="btw-stop-btn" title="Stop" hidden><i class="fa-solid fa-stop"></i></button>
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
    element.querySelector('#btw-send-btn')?.addEventListener('click', onSendClick);
    element.querySelector('#btw-stop-btn')?.addEventListener('click', stopGeneration);

    const input = /** @type {HTMLTextAreaElement} */ (element.querySelector('#btw-input'));
    input.addEventListener('keydown', onInputKeyDown);
    input.addEventListener('input', autoGrowInput);

    renderChips();
    applyGeometry(element, GEOMETRY_KEY);
    if (localStorage.getItem(COLLAPSED_KEY) === 'true') setCollapsed(true);

    window.addEventListener('resize', onWindowResize);
    return element;
}

function onWindowResize() {
    if (!panel || panel.style.display === 'none') return;
    applyGeometry(panel, GEOMETRY_KEY);
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
            input.value = prompt.text;
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
        transcript.innerHTML = `
            <div class="btw-empty">
                <p><strong>Out-of-character side thread.</strong></p>
                <p>This conversation is invisible to the roleplay. It carries the active character card, the persona, the lorebooks and the chat history, so you can talk about the story instead of inside it.</p>
                <p>Nothing here is ever sent to the main chat.</p>
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
    wrapper.className = `btw-message btw-message-${message.role}${message.error ? ' btw-message-error' : ''}`;
    wrapper.dataset.index = String(index);

    const body = document.createElement('div');
    body.className = 'btw-message-body';
    if (message.role === 'user') {
        body.innerHTML = `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`;
    } else if (message.content) {
        body.innerHTML = renderMarkdown(message.content);
    } else {
        body.innerHTML = '<span class="btw-typing" aria-label="Waiting for the reply">●●●</span>';
    }
    wrapper.appendChild(body);

    if (message.role === 'assistant' && !message.error && message.content) {
        wrapper.appendChild(renderMessageActions(message, index));
    }
    return wrapper;
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

function onSendClick() {
    const input = /** @type {HTMLTextAreaElement|null} */ (panel?.querySelector('#btw-input'));
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrowInput();
    ask(text).catch(error => console.error(LOG_PREFIX, error));
}

/** @param {boolean} value */
function setBusy(value) {
    busy = value;
    const send = panel?.querySelector('#btw-send-btn');
    const stop = panel?.querySelector('#btw-stop-btn');
    const canStop = value && canAbort(getSettings());
    if (send instanceof HTMLButtonElement) {
        send.disabled = value;
        send.hidden = canStop;
    }
    if (stop instanceof HTMLButtonElement) stop.hidden = !canStop;
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
            reply.content = '_(empty response — the backend returned nothing. Check the max response length and the selected model.)_';
            reply.error = true;
        }
        setStatus('');
    } catch (error) {
        const aborted = /** @type {any} */ (error)?.name === 'AbortError' || abortController?.signal.aborted;
        // renderMarkdown escapes its input, so the raw message goes in as-is.
        reply.content = aborted
            ? '_(stopped)_'
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
        <label>Content
            <textarea id="btw-entry-content" class="text_pole" rows="12"></textarea>
        </label>
        ${codeBlocks.length > 1 ? `<p class="btw-hint">${codeBlocks.length} fenced blocks found in this answer; the first one is prefilled.</p>` : ''}
    `;

    const bookInput = /** @type {HTMLInputElement} */ (form.querySelector('#btw-entry-book'));
    bookInput.value = bound && books.includes(bound) ? bound : (books[0] || '');
    /** @type {HTMLTextAreaElement} */ (form.querySelector('#btw-entry-content')).value = defaultBody;

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
    resizeObserver?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    panel?.remove();
    panel = null;
}
