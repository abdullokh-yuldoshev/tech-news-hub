const FEED_CACHE_TTL_MS = 8 * 60 * 1000;
const FEED_STALE_TTL_MS = 60 * 60 * 1000;
const FEED_FETCH_TIMEOUT_MS = 7000;
const MAX_FEED_SIZE_BYTES = 2 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 100;

const feedCache = {};
const inFlightFeedRequests = new Map();
const rateLimitStore = new Map();
let requestCounter = 0;

const FEED_SLOTS = {
    ru: [
        'https://www.ixbt.com/export/news.rss',
        'https://hi-tech.mail.ru/rss/all/',
        'https://www.cnews.ru/inc/rss/news.xml',
    ],
    en: [
        'https://www.engadget.com/rss.xml',
        'https://www.wired.com/feed/rss',
        'https://www.tomshardware.com/feeds/all',
        'https://www.androidauthority.com/feed',
        'https://arstechnica.com/feed/',
        'https://www.theverge.com/rss/index.xml',
    ],
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=180, s-maxage=480, stale-while-revalidate=900');

    pruneRateLimitStoreIfNeeded();

    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
        res.setHeader('X-Feed-Error', 'rate-limited');
        const fallbackLang = req.query.lang === 'en' ? 'en' : 'ru';
        const fallbackSlot = Number.parseInt(String(req.query.slot ?? '0'), 10);
        const fallbackKey = `${fallbackLang}:${Number.isFinite(fallbackSlot) && fallbackSlot >= 0 ? fallbackSlot : 0}`;
        const fallback = feedCache[fallbackKey];
        if (fallback?.xml) {
            res.setHeader('X-Feed-Cache', 'stale-rate-limit');
            res.status(200).send(fallback.xml);
            return;
        }
        res.status(200).send('<rss version="2.0"><channel></channel></rss>');
        return;
    }

    const lang = req.query.lang || 'ru';
    const normalizedLang = lang === 'en' ? 'en' : 'ru';
    const requestedSlot = Number.parseInt(String(req.query.slot ?? '0'), 10);
    const slot = Number.isFinite(requestedSlot) && requestedSlot >= 0 ? requestedSlot : 0;
    const feeds = FEED_SLOTS[normalizedLang];
    res.setHeader('X-Feed-Slot-Count', String(feeds.length));

    if (slot >= feeds.length) {
        res.setHeader('X-Feed-Has-More', '0');
        res.setHeader('X-Feed-Error', 'out-of-range');
        res.status(200).send('<rss version="2.0"><channel></channel></rss>');
        return;
    }

    const hasMore = slot < feeds.length - 1 ? '1' : '0';
    res.setHeader('X-Feed-Has-More', hasMore);
    res.setHeader('X-Feed-Slot', String(slot));
    
    const feedUrl = feeds[slot];

    const now = Date.now();
    const cacheKey = `${normalizedLang}:${slot}`;
    const cacheEntry = feedCache[cacheKey];
    if (cacheEntry?.xml && now - cacheEntry.ts < FEED_CACHE_TTL_MS) {
        res.setHeader('X-Feed-Cache', 'hit');
        res.status(200).send(cacheEntry.xml);
        return;
    }

    const inFlight = inFlightFeedRequests.get(cacheKey);
    if (inFlight) {
        try {
            const xml = await inFlight;
            res.setHeader('X-Feed-Cache', 'collapsed');
            res.status(200).send(xml);
            return;
        } catch {
            // Continue to fresh attempt below.
        }
    }

    try {
        const fetchPromise = fetchFeedXml(feedUrl);
        inFlightFeedRequests.set(cacheKey, fetchPromise);

        const xml = await fetchPromise;
        feedCache[cacheKey] = { xml, ts: now };
        res.setHeader('X-Feed-Cache', 'miss');
        res.status(200).send(xml);
    } catch (error) {
        console.error(error);
        const stale = feedCache[cacheKey];
        if (stale?.xml && now - stale.ts < FEED_STALE_TTL_MS) {
            res.setHeader('X-Feed-Cache', 'stale');
            res.setHeader('X-Feed-Error', 'upstream-failed');
            res.status(200).send(stale.xml);
            return;
        }

        // Не роняем клиент при сбое отдельного источника: отдаем пустой RSS-слот.
        res.setHeader('X-Feed-Error', 'upstream-failed');
        res.status(200).send('<rss version="2.0"><channel></channel></rss>');
    } finally {
        inFlightFeedRequests.delete(cacheKey);
    }
}

async function fetchFeedXml(feedUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/xml, text/xml'
            }
        });

        if (!response.ok) throw new Error('Ошибка источника');

        const xml = await response.text();
        if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_SIZE_BYTES) {
            throw new Error('RSS payload too large');
        }
        return xml;
    } finally {
        clearTimeout(timeout);
    }
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
