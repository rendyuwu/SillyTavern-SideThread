/**
 * Binds the extension settings drawer.
 */

import { getSettings, saveSettings, DEFAULT_SYSTEM_PROMPT, LOG_PREFIX } from './settings.js';
import { fetchOllamaModels, fetchOpenAIModels } from './llm.js';
import { openPanel, onSettingsChanged } from './panel.js';

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
 * @param {HTMLSelectElement|null} select
 * @param {string[]} values
 * @param {string} emptyLabel
 * @param {string} selected
 */
function setOptions(select, values, emptyLabel, selected) {
    if (!select) return;
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.append(empty);
    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
    }
    select.value = values.includes(selected) ? selected : '';
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @param {string} key
 * @param {(value:any) => void} [after]
 */
function bindField(root, selector, key, after) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return;
    const settings = getSettings();

    const isCheckbox = element instanceof HTMLInputElement && element.type === 'checkbox';
    const isNumber = element instanceof HTMLInputElement && element.type === 'number';

    if (isCheckbox) element.checked = !!settings[key];
    else element.value = String(settings[key] ?? '');

    const event = isCheckbox || element instanceof HTMLSelectElement ? 'change' : 'input';
    element.addEventListener(event, () => {
        const live = getSettings();
        if (isCheckbox) live[key] = /** @type {HTMLInputElement} */ (element).checked;
        else if (isNumber) live[key] = Number(element.value);
        else live[key] = element.value;
        saveSettings();
        after?.(live[key]);
        onSettingsChanged();
    });
}

/** @param {ParentNode} root */
function updateSourcePanels(root) {
    const source = getSettings().connectionSource;
    for (const [id, mode] of [['#btw-profile-group', 'profile'], ['#btw-ollama-group', 'ollama'], ['#btw-openai-group', 'openai']]) {
        const group = root.querySelector(id);
        if (group instanceof HTMLElement) group.style.display = source === mode ? '' : 'none';
    }
}

/** @param {ParentNode} root */
function bindConnectionProfiles(root) {
    const settings = getSettings();
    const context = ctx();
    const select = root.querySelector('#btw-connection-profile');
    if (!(select instanceof HTMLSelectElement)) return;

    const service = context.ConnectionManagerRequestService;
    const disabled = context.extensionSettings?.disabledExtensions?.includes('connection-manager');

    if (disabled || !service) {
        select.innerHTML = '<option value="">Connection Manager is disabled</option>';
        return;
    }

    // The service can own the dropdown, which keeps it in sync as profiles change.
    if (typeof service.handleDropdown === 'function') {
        try {
            service.handleDropdown('#btw-connection-profile', settings.connectionProfileId, (/** @type {any} */ profile) => {
                getSettings().connectionProfileId = profile?.id || '';
                saveSettings();
                onSettingsChanged();
            });
            return;
        } catch (error) {
            console.warn(LOG_PREFIX, 'handleDropdown failed, falling back to a manual list', error);
        }
    }

    const profiles = Array.isArray(context.extensionSettings?.connectionManager?.profiles)
        ? context.extensionSettings.connectionManager.profiles
        : [];
    const supported = profiles.filter((/** @type {any} */ profile) => {
        try {
            return typeof service.isProfileSupported !== 'function' || service.isProfileSupported(profile);
        } catch {
            return false;
        }
    });

    select.innerHTML = '<option value="">-- No profile selected --</option>';
    for (const profile of supported) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        select.append(option);
    }
    select.value = settings.connectionProfileId || '';
    select.addEventListener('change', () => {
        getSettings().connectionProfileId = select.value;
        saveSettings();
        onSettingsChanged();
    });
}

/** @param {ParentNode} root */
function bindPresets(root) {
    const select = root.querySelector('#btw-preset');
    if (!(select instanceof HTMLSelectElement)) return;
    /** @type {string[]} */
    let presets = [];
    try {
        presets = ctx().getPresetManager?.()?.getAllPresets?.() || [];
    } catch { /* no preset manager for the current API */ }
    setOptions(select, presets, '-- Use the profile default --', getSettings().completionPresetId);
    select.addEventListener('change', () => {
        getSettings().completionPresetId = select.value;
        saveSettings();
    });
}

/** @param {ParentNode} root */
function bindModelPickers(root) {
    const settings = getSettings();

    const ollamaModel = root.querySelector('#btw-ollama-model');
    if (ollamaModel instanceof HTMLSelectElement) {
        setOptions(ollamaModel, settings.ollamaModel ? [settings.ollamaModel] : [], '-- Select a model --', settings.ollamaModel);
        ollamaModel.addEventListener('change', () => {
            getSettings().ollamaModel = ollamaModel.value;
            saveSettings();
        });
    }
    root.querySelector('#btw-ollama-refresh')?.addEventListener('click', async () => {
        const url = getSettings().ollamaUrl;
        if (!url) return toast('Set the Ollama URL first.', 'info');
        try {
            const models = await fetchOllamaModels(url);
            setOptions(/** @type {HTMLSelectElement} */ (ollamaModel), models, '-- Select a model --', getSettings().ollamaModel);
            toast(`${models.length} models found.`, 'success');
        } catch (error) {
            toast(`Could not reach Ollama: ${/** @type {any} */ (error)?.message || error}`, 'error');
        }
    });

    const openaiModel = root.querySelector('#btw-openai-model');
    if (openaiModel instanceof HTMLSelectElement) {
        setOptions(openaiModel, settings.openaiModel ? [settings.openaiModel] : [], '-- Select a model --', settings.openaiModel);
        openaiModel.addEventListener('change', () => {
            if (!openaiModel.value) return;
            getSettings().openaiModel = openaiModel.value;
            saveSettings();
            const manual = root.querySelector('#btw-openai-model-manual');
            if (manual instanceof HTMLInputElement) manual.value = openaiModel.value;
        });
    }
    root.querySelector('#btw-openai-refresh')?.addEventListener('click', async () => {
        const { openaiUrl, openaiKey } = getSettings();
        if (!openaiUrl) return toast('Set the endpoint URL first.', 'info');
        try {
            const models = await fetchOpenAIModels(openaiUrl, openaiKey);
            setOptions(/** @type {HTMLSelectElement} */ (openaiModel), models, '-- Select a model --', getSettings().openaiModel);
            toast(`${models.length} models found.`, 'success');
        } catch (error) {
            toast(`Model list unavailable — type the model name manually. (${/** @type {any} */ (error)?.message || error})`, 'warning');
        }
    });
}

/**
 * @param {ParentNode} root
 */
export function bindSettingsUi(root) {
    bindField(root, '#btw-connection-source', 'connectionSource', () => updateSourcePanels(root));
    bindField(root, '#btw-ollama-url', 'ollamaUrl');
    bindField(root, '#btw-openai-url', 'openaiUrl');
    bindField(root, '#btw-openai-key', 'openaiKey');
    bindField(root, '#btw-openai-model-manual', 'openaiModel');
    bindField(root, '#btw-max-tokens', 'maxTokens');
    bindField(root, '#btw-temperature', 'temperature');
    bindField(root, '#btw-stream', 'stream');

    bindField(root, '#btw-history-mode', 'historyMode');
    bindField(root, '#btw-history-count', 'historyCount');
    bindField(root, '#btw-lore-mode', 'loreMode');
    bindField(root, '#btw-lore-max-chars', 'loreMaxChars');
    bindField(root, '#btw-include-card', 'includeCard');
    bindField(root, '#btw-include-examples', 'includeExamples');
    bindField(root, '#btw-include-first-message', 'includeFirstMessage');
    bindField(root, '#btw-include-persona', 'includePersona');
    bindField(root, '#btw-include-author-note', 'includeAuthorNote');
    bindField(root, '#btw-include-hidden', 'includeHiddenMessages');
    bindField(root, '#btw-side-thread-turns', 'sideThreadTurns');

    bindField(root, '#btw-system-prompt', 'systemPrompt');
    bindField(root, '#btw-font-size', 'fontSize');
    bindField(root, '#btw-persist-threads', 'persistThreads');
    bindField(root, '#btw-debug', 'debug');

    bindConnectionProfiles(root);
    bindPresets(root);
    bindModelPickers(root);
    updateSourcePanels(root);

    root.querySelector('#btw-open-panel')?.addEventListener('click', () => openPanel());

    root.querySelector('#btw-system-prompt-reset')?.addEventListener('click', () => {
        getSettings().systemPrompt = DEFAULT_SYSTEM_PROMPT;
        saveSettings();
        const textarea = root.querySelector('#btw-system-prompt');
        if (textarea instanceof HTMLTextAreaElement) textarea.value = DEFAULT_SYSTEM_PROMPT;
        toast('Default system prompt restored.', 'success');
    });

    root.querySelector('#btw-reset-geometry')?.addEventListener('click', () => {
        localStorage.removeItem('btw_panel_geometry');
        openPanel();
        toast('Panel position reset.', 'success');
    });
}
