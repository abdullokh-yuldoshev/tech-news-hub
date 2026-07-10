export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    const lang = req.query.lang || 'ru';
    
    // TechCrunch идет лесом. Подключаем элитный The Verge.
    const feedUrl = lang === 'ru' 
        ? 'https://www.ixbt.com/export/news.rss' 
        : 'https://www.theverge.com/rss/index.xml'; 

    try {
        const response = await fetch(feedUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/xml, text/xml'
            }
        });
        
        if (!response.ok) throw new Error('Ошибка источника');
        
        const xml = await response.text();
        res.status(200).send(xml);
    } catch (error) {
        console.error(error);
        res.status(500).send('<error>Сервер недоступен</error>');
    }
}
