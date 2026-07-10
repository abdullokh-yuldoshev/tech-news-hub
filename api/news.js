const FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const feedCache = {
    ru: { xml: null, ts: 0 },
    en: { xml: null, ts: 0 },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600');

    const lang = req.query.lang || 'ru';
    const normalizedLang = lang === 'en' ? 'en' : 'ru';
    
    // RU: iXBT, EN: Engadget (technology-focused RSS)
    const feedUrl = normalizedLang === 'ru' 
        ? 'https://www.ixbt.com/export/news.rss' 
        : 'https://www.engadget.com/rss.xml'; 

    const now = Date.now();
    const cacheEntry = feedCache[normalizedLang];
    if (cacheEntry.xml && now - cacheEntry.ts < FEED_CACHE_TTL_MS) {
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
        feedCache[normalizedLang] = { xml, ts: now };
        res.status(200).send(xml);
    } catch (error) {
        clearTimeout(timeout);
        console.error(error);
        res.status(500).send('<error>Сервер недоступен</error>');
    }
}
