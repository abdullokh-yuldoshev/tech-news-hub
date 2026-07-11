const CACHE_TTL_MS = 10 * 60 * 1000;
const STALE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
const MAX_XML_SIZE_BYTES = 2 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const MAX_ITEMS_PER_SLOT = 20;

const FEED_SLOTS = {
    ru: [
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCt7sv-NKh44rHAEb-qCCxvA',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCDF_NIAEkcAUvzxe1DUzaQA',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCAfkLSa-ujPKhniiKZ2bCHg',
    ],
    en: [
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCeeFfhMcJa1kjtfZAGskOCA',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCVYamHliCI9rw1tHR1xbkfw',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCE_M8A5yxnLfW0KghEeajjw',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UCRPMAqdtSgd0Ipeef7iFsKw',
    ],
};

const cache = new Map();
const inFlight = new Map();
const rateLimitStore = new Map();
let requestCounter = 0;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=180, s-maxage=600, stale-while-revalidate=900');

    pruneRateLimitStoreIfNeeded();

    const lang = req.query.lang === 'en' ? 'en' : 'ru';
    const slots = FEED_SLOTS[lang] || FEED_SLOTS.en;
    const slotCount = slots.length;
    const requestedSlot = Number.parseInt(String(req.query.slot ?? '0'), 10);
    const slot = Number.isFinite(requestedSlot) ? Math.max(0, requestedSlot) % slotCount : 0;

    res.setHeader('X-YT-Slot-Count', String(slotCount));
    res.setHeader('X-YT-Slot', String(slot));
    res.setHeader('X-YT-Has-More', slot < slotCount - 1 ? '1' : '0');

    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
        const stale = cache.get(`${lang}:${slot}`);
        if (stale?.items) {
            res.status(200).json({ items: stale.items, stale: true, reason: 'rate-limited' });
            return;
        }
        res.status(200).json({ items: [], stale: true, reason: 'rate-limited' });
        return;
    }

    const key = `${lang}:${slot}`;
    const now = Date.now();
    const entry = cache.get(key);
    if (entry?.items && now - entry.ts < CACHE_TTL_MS) {
        res.status(200).json({ items: entry.items, stale: false, cache: 'hit' });
        return;
    }

    const active = inFlight.get(key);
    if (active) {
        try {
            const items = await active;
            res.status(200).json({ items, stale: false, cache: 'collapsed' });
            return;
        } catch {
            // Ignore and continue.
        }
    }

    try {
        const feedUrl = slots[slot];
        const promise = fetchFeedItems(feedUrl);
        inFlight.set(key, promise);

        const items = await promise;
        cache.set(key, { ts: now, items });
        res.status(200).json({ items, stale: false, cache: 'miss' });
    } catch {
        const stale = cache.get(key);
        if (stale?.items && now - stale.ts < STALE_TTL_MS) {
            res.status(200).json({ items: stale.items, stale: true, reason: 'upstream-failed' });
            return;
        }

        res.status(200).json({ items: [], stale: true, reason: 'upstream-failed' });
    } finally {
        inFlight.delete(key);
    }
}

async function fetchFeedItems(feedUrl) {
    const xml = await fetchXml(feedUrl);
    return parseYoutubeAtom(xml).slice(0, MAX_ITEMS_PER_SLOT);
}

async function fetchXml(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                Accept: 'application/xml, text/xml',
            },
        });

        if (!response.ok) throw new Error('youtube upstream failed');

        const xml = await response.text();
        if (Buffer.byteLength(xml, 'utf8') > MAX_XML_SIZE_BYTES) {
            throw new Error('youtube payload too large');
        }

        return xml;
    } finally {
        clearTimeout(timeout);
    }
}

function parseYoutubeAtom(xml) {
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map(parseEntry).filter(Boolean);
}

function parseEntry(entryXml) {
    const title = decodeXml(getTagText(entryXml, 'title'));
    const videoId = getTagText(entryXml, 'yt:videoId');
    const publishedAt = getTagText(entryXml, 'published') || getTagText(entryXml, 'updated') || new Date().toISOString();
    const channel = decodeXml(getTagText(entryXml, 'name'));

    const linkMatch = entryXml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i);
    const thumbMatch = entryXml.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    const descMatch = entryXml.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/i);

    const link = safeAbsoluteUrl(linkMatch ? decodeXml(linkMatch[1]) : `https://www.youtube.com/watch?v=${videoId}`);
    const thumbnail = safeAbsoluteUrl(thumbMatch ? decodeXml(thumbMatch[1]) : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
    const description = decodeXml(descMatch ? descMatch[1] : '');

    if (!videoId || !link) return null;

    return {
        title: title || 'YouTube Video',
        link,
        thumbnail,
        channel: channel || 'YouTube',
        description,
        publishedAt,
    };
}

function getTagText(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = xml.match(re);
    return match ? match[1].trim() : '';
}

function decodeXml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function safeAbsoluteUrl(value) {
    try {
        return new URL(String(value || '').trim()).href;
    } catch {
        return '';
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
