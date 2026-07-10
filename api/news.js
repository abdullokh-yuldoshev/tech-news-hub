const FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const feedCache = {};

const FEED_SLOTS = {
    ru: [
        'https://www.ixbt.com/export/news.rss',
        'https://hi-tech.mail.ru/rss/all/',
    ],
    en: [
        'https://www.engadget.com/rss.xml',
        'https://www.wired.com/feed/rss',
        'https://techcrunch.com/feed/',
        'https://www.theverge.com/rss/index.xml',
    ],
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600');

    const lang = req.query.lang || 'ru';
    const normalizedLang = lang === 'en' ? 'en' : 'ru';
    const requestedSlot = Number.parseInt(String(req.query.slot ?? '0'), 10);
    const slot = Number.isFinite(requestedSlot) && requestedSlot >= 0 ? requestedSlot : 0;
    const feeds = FEED_SLOTS[normalizedLang];

    if (slot >= feeds.length) {
        res.setHeader('X-Feed-Has-More', '0');
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
        res.status(200).send(cacheEntry.xml);
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    try {
        const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/xml, text/xml'
            }
        });
        clearTimeout(timeout);
        
        if (!response.ok) throw new Error('Ошибка источника');
        
        const xml = await response.text();
        feedCache[cacheKey] = { xml, ts: now };
        res.status(200).send(xml);
    } catch (error) {
        clearTimeout(timeout);
        console.error(error);
        res.status(500).send('<error>Сервер недоступен</error>');
    }
}
