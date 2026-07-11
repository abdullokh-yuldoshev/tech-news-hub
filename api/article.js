// Допустимые домены — только наши новостные источники.
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
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_SIZE_BYTES = 3 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 800;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 50;

const articleCache = new Map();
const inFlightArticles = new Map();
const rateLimitStore = new Map();
let requestCounter = 0;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

    pruneRateLimitStoreIfNeeded();
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
        res.status(429).json({ error: 'Too many requests' });
        return;
    }

    const rawUrl = req.query.url;
    if (!rawUrl) { res.status(400).json({ error: 'Missing url' }); return; }

    let articleUrl;
    try { articleUrl = new URL(rawUrl); } catch {
        res.status(400).json({ error: 'Invalid url' }); return;
    }
    if (!['http:', 'https:'].includes(articleUrl.protocol)) {
        res.status(400).json({ error: 'Bad protocol' }); return;
    }
    if (!ALLOWED_DOMAINS.has(articleUrl.hostname)) {
        res.status(403).json({ error: 'Domain not allowed' }); return;
    }

    const cacheKey = articleUrl.href;
    const now = Date.now();
    const cached = articleCache.get(cacheKey);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
        res.json({ content: cached.content });
        return;
    }

    const inFlight = inFlightArticles.get(cacheKey);
    if (inFlight) {
        try {
            const content = await inFlight;
            res.json({ content });
            return;
        } catch {
            // Continue to a new attempt below.
        }
    }

    try {
        const fetchPromise = fetchAndExtractArticle(articleUrl.href);
        inFlightArticles.set(cacheKey, fetchPromise);

        const content = await fetchPromise;
        setArticleCache(cacheKey, content, now);
        res.json({ content });
    } catch (e) {
        const stale = articleCache.get(cacheKey);
        if (stale && now - stale.ts < STALE_TTL_MS) {
            res.json({ content: stale.content });
            return;
        }
        console.error('article fetch error:', e.message);
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

        if (!response.ok) {
            throw new Error(`Upstream status ${response.status}`);
        }

        const html = await response.text();
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_SIZE_BYTES) {
            throw new Error('Article HTML payload too large');
        }

        return extractArticle(html);
    } finally {
        clearTimeout(timeout);
    }
}

function setArticleCache(key, content, ts) {
    articleCache.set(key, { content, ts });

    if (articleCache.size <= MAX_CACHE_ENTRIES) return;

    let oldestKey = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [cacheKey, value] of articleCache.entries()) {
        if (value.ts < oldestTs) {
            oldestTs = value.ts;
            oldestKey = cacheKey;
        }
    }
    if (oldestKey) articleCache.delete(oldestKey);
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
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

/**
 * Извлекает основной текст статьи из HTML-страницы.
 * Стратегия: найти <article> или <main>, затем вытащить блочные элементы в порядке появления.
 */
function extractArticle(html) {
    // Убираем ненужные секции
    let clean = html
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<(nav|footer|header|form|noscript|aside|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');

    // Ищем <article> или <main> как основной контейнер
    let body = clean;
    const articleM = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(clean);
    if (articleM) {
        body = articleM[1];
    } else {
        const mainM = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(clean);
        if (mainM) body = mainM[1];
    }

    // Извлекаем блочные элементы в порядке их появления
    const results = [];
    const blockRe = /<(p|h[1-4]|ul|ol|blockquote|figure)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = blockRe.exec(body)) !== null) {
        const textOnly = m[2].replace(/<[^>]+>/g, '').trim();
        // Пропускаем слишком короткие абзацы (навигация, копирайты и т.п.)
        if (textOnly.length > 25 || m[1] === 'figure') {
            results.push(m[0]);
        }
    }

    return results.length >= 3 ? results.join('') : null;
}
