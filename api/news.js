export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    
    // МАГИЯ КЭША: Vercel запоминает ответ на 5 минут (300 секунд). 
    // Сайт не ляжет даже от 10 000 пользователей, а TechCrunch нас не заблокирует.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    const lang = req.query.lang || 'ru';
    
    const feedUrl = lang === 'ru' 
        ? 'https://www.ixbt.com/export/news.rss' 
        : 'https://techcrunch.com/feed/';

    try {
        const response = await fetch(feedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechPulseBot/1.0)' }
        });
        
        if (!response.ok) throw new Error('Ошибка источника');
        
        const xml = await response.text();
        res.status(200).send(xml);
    } catch (error) {
        console.error(error);
        res.status(500).send('<error>Сервер недоступен</error>');
    }
}
