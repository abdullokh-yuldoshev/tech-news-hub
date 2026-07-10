export default async function handler(req, res) {
    // Говорим браузеру, что это безопасный ответ с нашего же сервера (лечим CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');

    // Смотрим, какой язык запросил сайт
    const lang = req.query.lang || 'ru';
    
    // Прямые ссылки на оригинальные источники (никаких посредников!)
    const feedUrl = lang === 'ru' 
        ? 'https://www.ixbt.com/export/news.rss' 
        : 'https://techcrunch.com/feed/';

    try {
        // Vercel скачивает новости от своего лица (серверы не блокируют друг друга)
        const response = await fetch(feedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechPulseBot/1.0)' }
        });
        
        if (!response.ok) throw new Error('Ошибка источника');
        
        const xml = await response.text();
        res.status(200).send(xml); // Отдаем чистый код нашему сайту
    } catch (error) {
        console.error(error);
        res.status(500).send('<error>Сервер недоступен</error>');
    }
}
