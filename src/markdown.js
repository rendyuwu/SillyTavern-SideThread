/**
 * Small, deliberately boring markdown renderer for side-thread messages.
 *
 * SillyTavern's own messageFormatting() is avoided on purpose: it substitutes
 * macros and runs user regex scripts meant for roleplay output, which would mangle
 * lorebook drafts and code fences in the side thread.
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * @param {string} text
 * @returns {string}
 */
function renderInline(text) {
    return text
        .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
        .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * Renders a safe HTML subset: fenced code, headings, lists, blockquotes,
 * horizontal rules, paragraphs and inline emphasis.
 *
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
    const escaped = escapeHtml(source);

    // Pull fenced code out first so its contents are never inline-formatted. The
    // placeholder can start with a raw "<" because escapeHtml() has already turned
    // every "<" in the source into an entity, so it cannot collide with real text.
    /** @type {string[]} */
    const fences = [];
    const withoutFences = escaped.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
        const language = lang ? ` data-lang="${lang}"` : '';
        fences.push(`<pre class="btw-code"${language}><code>${code.replace(/\n$/, '')}</code></pre>`);
        return `\n<FENCE${fences.length - 1}>\n`;
    });

    /** @type {string[]} */
    const blocks = [];
    /** @type {string[]} */
    let listBuffer = [];
    let listType = '';

    const flushList = () => {
        if (!listBuffer.length) return;
        blocks.push(`<${listType}>${listBuffer.join('')}</${listType}>`);
        listBuffer = [];
        listType = '';
    };

    for (const rawLine of withoutFences.split('\n')) {
        const line = rawLine.replace(/\s+$/, '');
        const fenceMatch = line.match(/^<FENCE(\d+)>$/);
        if (fenceMatch) {
            flushList();
            blocks.push(fences[Number(fenceMatch[1])]);
            continue;
        }
        if (!line.trim()) { flushList(); continue; }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            flushList();
            const level = Math.min(6, heading[1].length + 2);
            blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
            continue;
        }
        if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
            flushList();
            blocks.push('<hr>');
            continue;
        }
        const quote = line.match(/^&gt;\s?(.*)$/);
        if (quote) {
            flushList();
            blocks.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
            continue;
        }
        const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
        if (unordered) {
            if (listType && listType !== 'ul') flushList();
            listType = 'ul';
            listBuffer.push(`<li>${renderInline(unordered[1])}</li>`);
            continue;
        }
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered) {
            if (listType && listType !== 'ol') flushList();
            listType = 'ol';
            listBuffer.push(`<li>${renderInline(ordered[1])}</li>`);
            continue;
        }

        flushList();
        blocks.push(`<p>${renderInline(line)}</p>`);
    }
    flushList();

    const html = blocks.join('');
    // DOMPurify ships with SillyTavern; use it when present as a second net.
    const purify = /** @type {any} */ (globalThis).DOMPurify;
    return purify?.sanitize ? purify.sanitize(html, { ADD_ATTR: ['target', 'data-lang'] }) : html;
}

/**
 * Extracts fenced code blocks, used by "save as lorebook entry" to offer the
 * drafted entry body instead of the whole reply.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractCodeBlocks(source) {
    /** @type {string[]} */
    const blocks = [];
    const pattern = /```[\w+-]*\n?([\s\S]*?)```/g;
    let match;
    while ((match = pattern.exec(String(source ?? ''))) !== null) {
        const body = match[1].trim();
        if (body) blocks.push(body);
    }
    return blocks;
}
