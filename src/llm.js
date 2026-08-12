/**
 * Request dispatch for the side thread.
 *
 * Four backends, picked by `settings.connectionSource`:
 *   profile — SillyTavern Connection Manager profile (silent, no UI flicker, streams)
 *   default — the currently selected main API via generateRaw (no abort, no stream)
 *   ollama  — direct /api/chat against an Ollama server
 *   openai  — direct /chat/completions against any OpenAI-compatible endpoint
 *
 * The direct modes talk to the endpoint from the browser, so the endpoint has to
 * allow cross-origin requests (for Ollama: OLLAMA_ORIGINS).
 */

import { debugLog, LOG_PREFIX } from './settings.js';

/** @typedef {{role:'user'|'assistant'|'system', content:string}} ChatMessage */

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/**
 * Pull the text out of whatever shape the backend returned.
 *
 * @param {any} raw
 * @returns {string}
 */
function extractText(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                return extractText(JSON.parse(trimmed));
            } catch { /* not JSON after all */ }
        }
        return raw;
    }
    const text = raw.content
        ?? raw.message?.content
        ?? raw.choices?.[0]?.message?.content
        ?? raw.choices?.[0]?.text
        ?? raw.response
        ?? raw.text
        ?? null;
    if (typeof text === 'string') return text;
    // Some reasoning models return only a reasoning field when max_tokens is tight.
    const reasoning = raw.reasoning ?? raw.message?.reasoning ?? raw.choices?.[0]?.message?.reasoning;
    if (typeof reasoning === 'string') return reasoning;
    return '';
}

/**
 * @param {string} url
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(url, suffix) {
    const base = String(url || '').trim().replace(/\/+$/, '');
    if (base.endsWith(suffix)) return base;
    if (suffix === '/chat/completions' && /\/v\d+$/.test(base)) return `${base}${suffix}`;
    if (suffix === '/chat/completions') return `${base}/v1${suffix}`;
    return `${base}${suffix}`;
}

// ── Connection Manager profile ────────────────────────────────────────────────

/**
 * @param {Record<string, any>} settings
 * @param {ChatMessage[]} messages
 * @param {AbortSignal|null} signal
 * @param {((text:string) => void)|null} onProgress
 * @returns {Promise<string>}
 */
async function sendViaProfile(settings, messages, signal, onProgress) {
    const service = ctx().ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('Connection Manager is not available in this SillyTavern build.');
    }

    const maxTokens = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : undefined;
    const wantsStream = !!settings.stream && typeof onProgress === 'function';
    const requestedPreset = String(settings.completionPresetId || '').trim();

    const profile = typeof service.getProfile === 'function' ? service.getProfile(settings.connectionProfileId) : null;
    const overridePreset = !!requestedPreset && !!profile;
    const originalPreset = overridePreset ? profile.preset : null;

    let result;
    try {
        if (overridePreset) profile.preset = requestedPreset;
        result = await service.sendRequest(settings.connectionProfileId, messages, maxTokens, {
            stream: wantsStream,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
            signal,
        });
    } finally {
        if (overridePreset && profile && profile.preset !== originalPreset) profile.preset = originalPreset;
    }

    // Streaming mode hands back a generator factory; each chunk carries the full
    // accumulated text, not a delta.
    if (wantsStream && typeof result === 'function') {
        let text = '';
        for await (const chunk of result()) {
            if (signal?.aborted) break;
            if (typeof chunk?.text === 'string') {
                text = chunk.text;
                onProgress?.(text);
            }
        }
        return text;
    }

    return extractText(result);
}

// ── Direct Ollama ─────────────────────────────────────────────────────────────

/**
 * @param {Record<string, any>} settings
 * @param {ChatMessage[]} messages
 * @param {AbortSignal|null} signal
 * @returns {Promise<string>}
 */
async function sendViaOllama(settings, messages, signal) {
    if (!settings.ollamaModel) throw new Error('No Ollama model selected.');

    /** @type {Record<string, any>} */
    const options = {};
    if (Number(settings.maxTokens) > 0) options.num_predict = Number(settings.maxTokens);
    if (Number(settings.temperature) > 0) options.temperature = Number(settings.temperature);

    const response = await fetch(joinUrl(settings.ollamaUrl, '/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.ollamaModel, messages, stream: false, options }),
        signal,
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return extractText(await response.json());
}

/**
 * @param {string} url
 * @returns {Promise<string[]>}
 */
export async function fetchOllamaModels(url) {
    const response = await fetch(joinUrl(url, '/api/tags'), { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data?.models || []).map((/** @type {any} */ m) => m?.name).filter(Boolean);
}

// ── Direct OpenAI-compatible ──────────────────────────────────────────────────

/**
 * @param {Record<string, any>} settings
 * @param {ChatMessage[]} messages
 * @param {AbortSignal|null} signal
 * @param {((text:string) => void)|null} onProgress
 * @returns {Promise<string>}
 */
async function sendViaOpenAI(settings, messages, signal, onProgress) {
    if (!settings.openaiUrl) throw new Error('No OpenAI-compatible endpoint URL set.');
    if (!settings.openaiModel) throw new Error('No model name set for the OpenAI-compatible endpoint.');

    const wantsStream = !!settings.stream && typeof onProgress === 'function';
    /** @type {Record<string, any>} */
    const payload = { model: settings.openaiModel, messages, stream: wantsStream };
    if (Number(settings.maxTokens) > 0) payload.max_tokens = Number(settings.maxTokens);
    if (Number(settings.temperature) > 0) payload.temperature = Number(settings.temperature);

    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (settings.openaiKey) headers['Authorization'] = `Bearer ${settings.openaiKey}`;

    const response = await fetch(joinUrl(settings.openaiUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
    });
    if (!response.ok) throw new Error(`Endpoint HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    if (!wantsStream || !response.body) return extractText(await response.json());

    return await readSse(response, onProgress, signal);
}

/**
 * Minimal SSE reader for OpenAI-style `data:` streams.
 *
 * @param {Response} response
 * @param {(text:string) => void} onProgress
 * @param {AbortSignal|null} signal
 * @returns {Promise<string>}
 */
async function readSse(response, onProgress, signal) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';

    while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const parsed = JSON.parse(data);
                const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.text ?? '';
                if (delta) {
                    text += delta;
                    onProgress(text);
                }
            } catch (error) {
                debugLog('unparseable SSE chunk', data, error);
            }
        }
    }
    return text;
}

/**
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
export async function fetchOpenAIModels(url, apiKey) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const endpoint = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const response = await fetch(endpoint, { method: 'GET', headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const list = Array.isArray(data) ? data : (data?.data || data?.models || []);
    return list.map((/** @type {any} */ m) => (typeof m === 'string' ? m : (m?.id || m?.name))).filter(Boolean);
}

// ── Default: the active main API ──────────────────────────────────────────────

/**
 * generateRaw takes a single prompt string and offers no abort signal, so the
 * side thread is flattened into a transcript. Streaming is not available here.
 *
 * @param {Record<string, any>} settings
 * @param {string} systemPrompt
 * @param {ChatMessage[]} thread
 * @returns {Promise<string>}
 */
async function sendViaDefault(settings, systemPrompt, thread) {
    const { generateRaw } = ctx();
    if (typeof generateRaw !== 'function') throw new Error('generateRaw is not available in this SillyTavern build.');

    const transcript = thread
        .map(message => `${message.role === 'assistant' ? 'Assistant' : 'Author'}: ${message.content}`)
        .join('\n\n');

    /** @type {Record<string, any>} */
    const options = {
        prompt: `${transcript}\n\nAssistant:`,
        systemPrompt,
        // The reply is rendered in the side panel, not as chat dialogue. ST's default
        // name trimming drops the whole response when it happens to start with a
        // character name, which is common for NPC drafts.
        trimNames: false,
    };
    if (Number(settings.maxTokens) > 0) options.responseLength = Number(settings.maxTokens);

    return extractText(await generateRaw(options));
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {Record<string, any>} params.settings
 * @param {string} params.systemPrompt
 * @param {ChatMessage[]} params.thread Side-thread turns, oldest first, ending with the new question.
 * @param {AbortSignal|null} [params.signal]
 * @param {((text:string) => void)|null} [params.onProgress]
 * @returns {Promise<string>}
 */
export async function sendSideRequest({ settings, systemPrompt, thread, signal = null, onProgress = null }) {
    /** @type {ChatMessage[]} */
    const messages = [{ role: 'system', content: systemPrompt }, ...thread];
    debugLog(`dispatch source=${settings.connectionSource} stream=${!!settings.stream} turns=${thread.length}`);

    switch (settings.connectionSource) {
        case 'profile':
            if (!settings.connectionProfileId) throw new Error('No connection profile selected in the BTW settings.');
            return await sendViaProfile(settings, messages, signal, onProgress);
        case 'ollama':
            return await sendViaOllama(settings, messages, signal);
        case 'openai':
            return await sendViaOpenAI(settings, messages, signal, onProgress);
        default:
            return await sendViaDefault(settings, systemPrompt, thread);
    }
}

/**
 * True when the selected backend can stream into the panel.
 *
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function canStream(settings) {
    return !!settings.stream && (settings.connectionSource === 'profile' || settings.connectionSource === 'openai');
}

/**
 * True when the selected backend honours an AbortSignal.
 *
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function canAbort(settings) {
    return settings.connectionSource !== 'default';
}

export { extractText, LOG_PREFIX };
