const ALLOWED_DOMAINS = new Set([
    'www.engadget.com', 'engadget.com',
    'www.wired.com', 'wired.com',
    'www.tomshardware.com', 'tomshardware.com',
    'www.androidauthority.com', 'androidauthority.com',
    'arstechnica.com', 'www.arstechnica.com',
    'www.theverge.com', 'theverge.com',
    'www.ixbt.com', 'ixbt.com',
    'hi-tech.mail.ru',
    'www.cnews.ru', 'cnews.ru',
]);

const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_SIZE_BYTES = 3 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;

const articleCache = new Map();
const inFlightArticles = new Map();
const rateLimitStore = new Map();
let requestCounter = 0;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600');

    pruneRateLimitStoreIfNeeded();

    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
        res.status(429).json({ error: 'Too many requests' });
        return;
    }

    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
        res.status(400).json({ error: 'Missing url' });
        return;
    }

    let articleUrl;
    try {
        articleUrl = new URL(rawUrl);
    } catch {
        res.status(400).json({ error: 'Invalid url' });
        return;
    }

    if (!['http:', 'https:'].includes(articleUrl.protocol)) {
        res.status(400).json({ error: 'Unsupported protocol' });
        return;
    }

    if (!ALLOWED_DOMAINS.has(articleUrl.hostname)) {
        res.status(403).json({ error: 'Domain not allowed' });
        return;
    }

    const cacheKey = articleUrl.href;
    const now = Date.now();
    const cached = articleCache.get(cacheKey);

    if (cached && now - cached.ts < CACHE_TTL_MS) {
        res.status(200).json({ content: cached.content, stale: false, cache: 'hit' });
        return;
    }

    const active = inFlightArticles.get(cacheKey);
    if (active) {
        try {
            const content = await active;
            res.status(200).json({ content, stale: false, cache: 'collapsed' });
            return;
        } catch {
            // Continue to new attempt.
        }
    }

    try {
        const promise = fetchAndExtractArticle(cacheKey);
        inFlightArticles.set(cacheKey, promise);

        const content = await promise;
        articleCache.set(cacheKey, { ts: now, content });
        res.status(200).json({ content, stale: false, cache: 'miss' });
    } catch {
        const stale = articleCache.get(cacheKey);
        if (stale && now - stale.ts < STALE_TTL_MS) {
            res.status(200).json({ content: stale.content, stale: true, cache: 'stale' });
            return;
        }

        res.status(502).json({ error: 'Fetch failed' });
    } finally {
        inFlightArticles.delete(cacheKey);
    }
}

async function fetchAndExtractArticle(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
                'Cache-Control': 'no-cache',
            }
        });

        if (!response.ok) throw new Error('upstream error');

        const html = await response.text();
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_SIZE_BYTES) {
            throw new Error('payload too large');
        }

        const extracted = extractArticle(html);
        if (!extracted) throw new Error('content not found');

        return extracted;
    } finally {
        clearTimeout(timeout);
    }
}

function extractArticle(html) {
    const clean = String(html || '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<(nav|footer|header|form|noscript|aside|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');

    const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(clean);
    const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(clean);
    const body = articleMatch ? articleMatch[1] : (mainMatch ? mainMatch[1] : clean);

    const results = [];
    const blockRe = /<(p|h[1-4]|ul|ol|blockquote|figure)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = blockRe.exec(body)) !== null) {
        const textOnly = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (textOnly.length > 30 || match[1] === 'figure') {
            results.push(match[0]);
        }
    }

    if (results.length >= 3) return results.join('');

    const paragraphFallback = [];
    const pRe = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
    while ((match = pRe.exec(body)) !== null) {
        const textOnly = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (textOnly.length > 40) {
            paragraphFallback.push(`<p>${escapeHtml(textOnly)}</p>`);
            if (paragraphFallback.length >= 12) break;
        }
    }

    return paragraphFallback.length ? paragraphFallback.join('') : null;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
    if (!ip || ip === 'unknown') return false;

    const now = Date.now();
    const entry = rateLimitStore.get(ip);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    entry.count += 1;
    return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function pruneRateLimitStoreIfNeeded() {
    requestCounter += 1;
    if (requestCounter % 200 !== 0) return;

    const now = Date.now();
    for (const [ip, entry] of rateLimitStore.entries()) {
        if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitStore.delete(ip);
        }
    }
}
