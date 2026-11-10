// Подбор масла по VIN и по марке/модели. Все запросы к PartsAPI идут через кэш в БД.
const pa = require('./partsapi-cache');
const oc = require('./oil-catalog');

function registerOilRoutes(app, { pool, verifyAdmin, rateLimit }) {
    const limit = rateLimit(30, 60_000);
    const wrap = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (e) {
            if (e.user) return res.status(e.status || 400).json({ error: e.message });
            console.error('[API /oil]', String(e.message).slice(0, 200));
            res.status(502).json({ error: 'Сервис подбора временно недоступен. Попробуйте позже.' });
        }
    };
    const id = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Некорректный запрос'), { user: true }); return n; };

    // Основной путь — каталог ТО PartsAPI: марка -> модель -> модификация (typeId) -> объёмы и допуски
    app.get('/api/oil/by-vin', limit, wrap(async (req, res) => { res.json(await oc.vinHint(pool, req.query.vin)); }));
    app.get('/api/oil/makes', limit, wrap(async (req, res) => { res.json(await oc.listMakes(pool)); }));
    app.get('/api/oil/models', limit, wrap(async (req, res) => { res.json(await oc.listModels(pool, id(req.query.make_id))); }));
    app.get('/api/oil/cars', limit, wrap(async (req, res) => { res.json(await oc.listTypes(pool, id(req.query.model_id))); }));
    app.get('/api/oil/by-car', limit, wrap(async (req, res) => { res.json(await oc.selectionByType(pool, id(req.query.car_id))); }));
    app.get('/api/oil/usage', verifyAdmin, wrap(async (req, res) => { res.json(await pa.requestsToday(pool)); }));

    // Допуски товара (админка): список и замена
    app.get('/api/products/:id/approvals', verifyAdmin, wrap(async (req, res) => {
        const r = await pool.query('SELECT approval FROM product_approvals WHERE product_id = $1 ORDER BY approval', [id(req.params.id)]);
        res.json(r.rows.map(x => x.approval));
    }));
    app.put('/api/products/:id/approvals', verifyAdmin, wrap(async (req, res) => {
        const pid = id(req.params.id);
        const list = [...new Set((Array.isArray(req.body && req.body.approvals) ? req.body.approvals : [])
            .map(s => String(s).trim().slice(0, 100)).filter(Boolean))].slice(0, 80);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM product_approvals WHERE product_id = $1', [pid]);
            for (const a of list) await client.query('INSERT INTO product_approvals (product_id, approval) VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, a]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        res.json({ success: true, count: list.length });
    }));
}

module.exports = { registerOilRoutes };
