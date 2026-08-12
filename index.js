/**
 * BTW — Side Thread
 *
 * An out-of-character side chat for SillyTavern, in the spirit of Claude Code's
 * `/btw`: ask a question about the story without disturbing the story. The side
 * thread carries the active character card, persona, lorebooks and chat history,
 * and never writes anything into the main conversation.
 */

import { getSettings, LOG_PREFIX } from './src/settings.js';
import { bindSettingsUi } from './src/settings-ui.js';
import {
    ask,
    closePanel,
    isPanelOpen,
    onChatChanged,
    openPanel,
    restoreIfPreviouslyOpen,
    togglePanel,
} from './src/panel.js';

const WAND_BUTTON_ID = 'btw-wand-button';

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

async function injectSettingsDrawer() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || container.querySelector('.btw-settings')) return;

    try {
        const response = await fetch(new URL('./settings.html', import.meta.url), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = await response.text();
        const root = wrapper.firstElementChild;
        if (!root) throw new Error('settings.html is empty');
        container.appendChild(root);
        bindSettingsUi(root);
    } catch (error) {
        console.error(LOG_PREFIX, 'Could not mount the settings drawer:', error);
    }
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_BUTTON_ID)) return;

    const button = document.createElement('div');
    button.id = WAND_BUTTON_ID;
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');
    button.tabIndex = 0;
    button.innerHTML = `
        <div class="fa-solid fa-comments extensionsMenuExtensionButton" aria-hidden="true"></div>
        <span>Side Thread (BTW)</span>
    `;
    button.addEventListener('click', () => togglePanel());
    menu.appendChild(button);
}

function registerSlashCommand() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn(LOG_PREFIX, 'Slash command API unavailable; /btw not registered.');
        return;
    }

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'btw',
            aliases: ['side', 'ooc'],
            /**
             * @param {Record<string, any>} _args
             * @param {string} value
             */
            callback: async (_args, value) => {
                const question = String(value ?? '').trim();
                if (!question) {
                    togglePanel();
                    return '';
                }
                return await ask(question);
            },
            unnamedArgumentList: [
                new SlashCommandArgument('question', [ARGUMENT_TYPE.STRING], false),
            ],
            returns: 'the side-thread answer',
            helpString: `
                <div>
                    Ask an out-of-character side question about the current chat without adding anything to it.
                    The side thread receives the character card, persona, lorebooks and chat history.
                </div>
                <div>Without an argument, toggles the side-thread panel.</div>
                <div>
                    <strong>Example:</strong>
                    <pre><code>/btw who still owes the harbour guild money?</code></pre>
                </div>
            `,
        }));
    } catch (error) {
        console.error(LOG_PREFIX, '/btw registration failed:', error);
    }
}

function registerEventListeners() {
    const context = ctx();
    const types = context.eventTypes || context.event_types;
    if (!context.eventSource || !types) return;
    context.eventSource.on(types.CHAT_CHANGED, () => onChatChanged());
}

/**
 * Wait for the containers this extension attaches to. ST mounts extension scripts
 * before the settings panels exist in some load orders.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
function waitFor(predicate, timeoutMs = 15000) {
    return new Promise(resolve => {
        if (predicate()) return resolve(true);
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate() || Date.now() - started > timeoutMs) {
                clearInterval(timer);
                resolve(predicate());
            }
        }, 200);
    });
}

async function init() {
    if (typeof SillyTavern?.getContext !== 'function') {
        console.error(LOG_PREFIX, 'SillyTavern context unavailable; extension not loaded.');
        return;
    }

    getSettings();

    await waitFor(() => !!document.getElementById('extensions_settings2') || !!document.getElementById('extensions_settings'));
    await injectSettingsDrawer();

    await waitFor(() => !!document.getElementById('extensionsMenu'), 5000);
    addWandButton();

    registerSlashCommand();
    registerEventListeners();
    restoreIfPreviouslyOpen();

    // Small console handle for troubleshooting.
    /** @type {any} */ (globalThis).btwSideThread = { ask, openPanel, closePanel, togglePanel, isPanelOpen };

    console.log(LOG_PREFIX, 'Side Thread ready. Use the wand menu or /btw.');
}

const jq = /** @type {any} */ (globalThis).jQuery;
if (typeof jq === 'function') jq(() => { init(); });
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
else init();
