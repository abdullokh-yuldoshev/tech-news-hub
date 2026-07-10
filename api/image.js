export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
        res.status(400).send('Missing image url');
        return;
    }

    let imageUrl;
    try {
        imageUrl = new URL(rawUrl);
    } catch (e) {
        res.status(400).send('Invalid image url');
        return;
    }

    if (!['http:', 'https:'].includes(imageUrl.protocol)) {
        res.status(400).send('Unsupported protocol');
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const upstream = await fetch(imageUrl.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },
        });

        clearTimeout(timeout);

        if (!upstream.ok) {
            res.status(upstream.status).send('Image upstream error');
            return;
        }

        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        const data = Buffer.from(await upstream.arrayBuffer());

        res.setHeader('Content-Type', contentType);
        res.status(200).send(data);
    } catch (error) {
        clearTimeout(timeout);
        res.status(502).send('Image fetch failed');
    }
}
