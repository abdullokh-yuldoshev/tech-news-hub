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

const articleCache = {};
const CACHE_TTL_MS = 30 * 60 * 1000;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

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
    const cached = articleCache[cacheKey];
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        res.json({ content: cached.content });
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(articleUrl.href, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
                'Cache-Control': 'no-cache',
            }
        });
        clearTimeout(timeout);

        if (!response.ok) {
            res.status(response.status).json({ error: 'Upstream error' }); return;
        }

        const html = await response.text();
        const content = extractArticle(html);

        articleCache[cacheKey] = { content, ts: Date.now() };
        res.json({ content });
    } catch (e) {
        clearTimeout(timeout);
        console.error('article fetch error:', e.message);
        res.status(502).json({ error: 'Fetch failed' });
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
