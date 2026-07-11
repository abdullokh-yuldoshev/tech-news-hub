const FEED_CACHE_TTL_MS = 8 * 60 * 1000;
const FEED_STALE_TTL_MS = 60 * 60 * 1000;
const FEED_FETCH_TIMEOUT_MS = 3500;
const AGG_CACHE_TTL_MS = 2 * 60 * 1000;
const AGG_STALE_TTL_MS = 15 * 60 * 1000;
const MAX_FEED_SIZE_BYTES = 2 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 300;

const feedCache = {};
const inFlightFeedRequests = new Map();
const aggregateCache = {};
const inFlightAggregateRequests = new Map();
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
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=180, s-maxage=480, stale-while-revalidate=900');

    pruneRateLimitStoreIfNeeded();

    const clientIp = getClientIp(req);
    const lang = req.query.lang === 'en' ? 'en' : 'ru';
    const hasExplicitSlot = typeof req.query.slot !== 'undefined';
    const requestedSlot = Number.parseInt(String(req.query.slot ?? '0'), 10);
    const slot = Number.isFinite(requestedSlot) && requestedSlot >= 0 ? requestedSlot : 0;
    const feeds = FEED_SLOTS[lang];

    res.setHeader('X-Feed-Slot-Count', String(feeds.length));

    if (!hasExplicitSlot) {
        res.setHeader('X-Feed-Mode', 'aggregate');

        if (isRateLimited(clientIp)) {
            const staleAggregate = aggregateCache[lang];
            if (staleAggregate?.items) {
                res.setHeader('X-Feed-Cache', 'stale-rate-limit');
                res.status(200).json({ items: staleAggregate.items, stale: true, reason: 'rate-limited' });
                return;
            }

            res.status(200).json({ items: [], stale: true, reason: 'rate-limited' });
            return;
        }

        try {
            const aggregate = await getAggregateItems(lang);
            res.setHeader('X-Feed-Cache', aggregate.cache);
            res.status(200).json({ items: aggregate.items, stale: aggregate.stale, cache: aggregate.cache });
        } catch {
            res.setHeader('X-Feed-Error', 'upstream-failed');
            res.status(200).json({ items: [], stale: true, reason: 'upstream-failed' });
        }
        return;
    }

    if (slot >= feeds.length) {
        res.setHeader('X-Feed-Has-More', '0');
        res.setHeader('X-Feed-Error', 'out-of-range');
        res.status(200).json({ items: [], stale: true, reason: 'out-of-range' });
        return;
    }

    res.setHeader('X-Feed-Has-More', slot < feeds.length - 1 ? '1' : '0');
    res.setHeader('X-Feed-Slot', String(slot));

    const cacheKey = `${lang}:${slot}`;
    const now = Date.now();
    const cacheEntry = feedCache[cacheKey];

    if (isRateLimited(clientIp)) {
        if (cacheEntry?.items) {
            res.setHeader('X-Feed-Cache', 'stale-rate-limit');
            res.status(200).json({ items: cacheEntry.items, stale: true, reason: 'rate-limited' });
            return;
        }
        res.status(200).json({ items: [], stale: true, reason: 'rate-limited' });
        return;
    }

    if (cacheEntry?.items && now - cacheEntry.ts < FEED_CACHE_TTL_MS) {
        res.setHeader('X-Feed-Cache', 'hit');
        res.status(200).json({ items: cacheEntry.items, stale: false, cache: 'hit' });
        return;
    }

    const inFlight = inFlightFeedRequests.get(cacheKey);
    if (inFlight) {
        try {
            const items = await inFlight;
            res.setHeader('X-Feed-Cache', 'collapsed');
            res.status(200).json({ items, stale: false, cache: 'collapsed' });
            return;
        } catch {
            // Continue to a fresh attempt below.
        }
    }

    try {
        const fetchPromise = fetchFeedItems(feeds[slot]);
        inFlightFeedRequests.set(cacheKey, fetchPromise);

        const items = await fetchPromise;
        feedCache[cacheKey] = { items, ts: now };
        res.setHeader('X-Feed-Cache', 'miss');
        res.status(200).json({ items, stale: false, cache: 'miss' });
    } catch (error) {
        console.error(error);
        const stale = feedCache[cacheKey];
        if (stale?.items && now - stale.ts < FEED_STALE_TTL_MS) {
            res.setHeader('X-Feed-Cache', 'stale');
            res.setHeader('X-Feed-Error', 'upstream-failed');
            res.status(200).json({ items: stale.items, stale: true, reason: 'upstream-failed' });
            return;
        }

        res.setHeader('X-Feed-Error', 'upstream-failed');
        res.status(200).json({ items: [], stale: true, reason: 'upstream-failed' });
    } finally {
        inFlightFeedRequests.delete(cacheKey);
    }
}

async function getAggregateItems(lang) {
    const cacheKey = lang;
    const now = Date.now();
    const cached = aggregateCache[cacheKey];

    if (cached?.items && now - cached.ts < AGG_CACHE_TTL_MS) {
        return { items: cached.items, stale: false, cache: 'hit' };
    }

    if (cached?.items && now - cached.ts < AGG_STALE_TTL_MS) {
        refreshAggregateInBackground(cacheKey, lang);
        return { items: cached.items, stale: true, cache: 'stale-hit' };
    }

    const inFlightAggregate = inFlightAggregateRequests.get(cacheKey);
    if (inFlightAggregate) {
        try {
            const items = await inFlightAggregate;
            return { items, stale: false, cache: 'collapsed' };
        } catch {
            // Continue to a fresh attempt below.
        }
    }

    const promise = buildAggregateItems(lang, cacheKey);

    inFlightAggregateRequests.set(cacheKey, promise);

    try {
        const items = await promise;
        return { items, stale: false, cache: 'miss' };
    } catch {
        const stale = aggregateCache[cacheKey];
        if (stale?.items && now - stale.ts < AGG_STALE_TTL_MS) {
            return { items: stale.items, stale: true, cache: 'stale' };
        }
        throw new Error('aggregate failed');
    } finally {
        inFlightAggregateRequests.delete(cacheKey);
    }
}

async function buildAggregateItems(lang, cacheKey) {
    const feeds = FEED_SLOTS[lang] || [];
    const settled = await Promise.allSettled(
        feeds.map((_, slot) => getSlotItemsWithFallback(lang, slot))
    );

    const merged = [];
    const byLink = new Set();

    settled.forEach(result => {
        if (result.status !== 'fulfilled') return;
        result.value.forEach(item => {
            if (!item?.link || byLink.has(item.link)) return;
            byLink.add(item.link);
            merged.push(item);
        });
    });

    merged.sort((a, b) => {
        const bt = Date.parse(b?.pubDate || '') || 0;
        const at = Date.parse(a?.pubDate || '') || 0;
        return bt - at;
    });

    const trimmed = merged.slice(0, 120);
    if (!trimmed.length) {
        throw new Error('aggregate empty');
    }

    aggregateCache[cacheKey] = { items: trimmed, ts: Date.now() };
    return trimmed;
}

function refreshAggregateInBackground(cacheKey, lang) {
    if (inFlightAggregateRequests.has(cacheKey)) return;

    const promise = buildAggregateItems(lang, cacheKey)
        .catch(() => null)
        .finally(() => {
            inFlightAggregateRequests.delete(cacheKey);
        });

    inFlightAggregateRequests.set(cacheKey, promise);
}

async function getSlotItemsWithFallback(lang, slot) {
    const feeds = FEED_SLOTS[lang] || [];
    if (slot < 0 || slot >= feeds.length) return [];

    const cacheKey = `${lang}:${slot}`;
    const now = Date.now();
    const cacheEntry = feedCache[cacheKey];

    if (cacheEntry?.items && now - cacheEntry.ts < FEED_CACHE_TTL_MS) {
        return cacheEntry.items;
    }

    const inFlight = inFlightFeedRequests.get(cacheKey);
    if (inFlight) {
        try {
            return await inFlight;
        } catch {
            // Continue to a fresh attempt below.
        }
    }

    try {
        const fetchPromise = fetchFeedItems(feeds[slot]);
        inFlightFeedRequests.set(cacheKey, fetchPromise);

        const items = await fetchPromise;
        feedCache[cacheKey] = { items, ts: now };
        return items;
    } catch {
        const stale = feedCache[cacheKey];
        if (stale?.items && now - stale.ts < FEED_STALE_TTL_MS) {
            return stale.items;
        }
        return [];
    } finally {
        inFlightFeedRequests.delete(cacheKey);
    }
}

async function fetchFeedItems(feedUrl) {
    const xml = await fetchFeedXml(feedUrl);
    return parseFeedXml(xml).slice(0, 60);
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

function parseFeedXml(xmlStr) {
    const items = [];
    const entries = [
        ...(xmlStr.match(/<item\b[\s\S]*?<\/item>/gi) || []),
        ...(xmlStr.match(/<entry\b[\s\S]*?<\/entry>/gi) || []),
    ];

    for (const entry of entries) {
        if (items.length >= 60) break;

        const title = decodeHtml(getTagText(entry, 'title')) || 'Без названия';
        const link = extractLink(entry);
        const pubDate = decodeHtml(
            getTagText(entry, 'pubDate') ||
            getTagText(entry, 'published') ||
            getTagText(entry, 'updated')
        );
        const categories = extractCategories(entry);

        let imgUrl = normalizeFeedUrl(
            getAttributeMatch(entry, /<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i) ||
            getAttributeMatch(entry, /<(?:media:content|media:thumbnail|content|thumbnail)[^>]*url=["']([^"']+)["'][^>]*>/i)
        );

        const descriptionHtml = decodeHtml(
            getTagText(entry, 'description') ||
            getTagText(entry, 'content') ||
            getTagText(entry, 'summary')
        );
        const encodedHtml = decodeHtml(
            getTagText(entry, 'content:encoded') ||
            getTagText(entry, 'encoded')
        );
        const fullHtml = encodedHtml || descriptionHtml;

        if (!imgUrl && fullHtml) {
            const imgMatch = fullHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (imgMatch) imgUrl = normalizeFeedUrl(imgMatch[1]);
        }

        const cleanDesc = stripTags(descriptionHtml || fullHtml).replace(/\s+/g, ' ').trim();
        items.push({
            title,
            link,
            desc: cleanDesc.length > 110 ? `${cleanDesc.slice(0, 110).trim()}...` : cleanDesc,
            img: safeAbsoluteUrl(imgUrl),
            categories,
            pubDate,
            fullHtml,
        });
    }

    return items.filter(item => item.link && item.link !== '#');
}

function extractLink(entry) {
    const hrefMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
    if (hrefMatch) return safeAbsoluteUrl(decodeHtml(hrefMatch[1]), '#');

    const linkTextMatch = entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (linkTextMatch) return safeAbsoluteUrl(decodeHtml(stripTags(linkTextMatch[1])).trim(), '#');

    return '#';
}

function extractCategories(entry) {
    const categories = [];
    const matches = entry.match(/<category\b[^>]*>[\s\S]*?<\/category>/gi) || [];

    matches.forEach(categoryXml => {
        const termMatch = categoryXml.match(/\bterm=["']([^"']+)["']/i);
        const text = decodeHtml(stripTags(categoryXml)).trim();

        if (termMatch && termMatch[1].trim()) categories.push(decodeHtml(termMatch[1].trim()));
        if (text) categories.push(text);
    });

    return categories;
}

function getTagText(xml, tagName) {
    const tagPattern = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = xml.match(new RegExp(`<${tagPattern}[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, 'i'));
    return match ? match[1].trim() : '';
}

function getAttributeMatch(xml, pattern) {
    const match = xml.match(pattern);
    return match ? decodeHtml(match[1]) : '';
}

function normalizeFeedUrl(url) {
    return decodeHtml(String(url || '').trim()).replace(/&amp;/gi, '&');
}

function safeAbsoluteUrl(url, fallback = '') {
    try {
        return new URL(String(url || '').trim()).href;
    } catch {
        return fallback;
    }
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
    return String(value || '').replace(/<[^>]+>/g, ' ');
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
