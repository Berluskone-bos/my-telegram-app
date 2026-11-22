// Подбор масла по VIN и по марке/модели. Все запросы к PartsAPI идут через кэш в БД.
const pa = require('./partsapi-cache');
const oc = require('./oil-catalog');
const { requirePermission } = require('./admin-permissions');

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
    const id = v => {
        const raw = String(v == null ? '' : v);
        if (!/^\d{1,15}$/.test(raw)) throw Object.assign(new Error('Некорректный запрос'), { user: true });
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n <= 0) throw Object.assign(new Error('Некорректный запрос'), { user: true });
        return n;
    };

    // Основной путь — каталог ТО PartsAPI: марка -> модель -> модификация (typeId) -> объёмы и допуски
    app.get('/api/oil/by-vin', limit, wrap(async (req, res) => { res.json(await oc.vinSearch(pool, req.query.vin)); }));
    app.get('/api/oil/makes', limit, wrap(async (req, res) => { res.json(await oc.listMakes(pool)); }));
    app.get('/api/oil/models', limit, wrap(async (req, res) => { res.json(await oc.listModels(pool, id(req.query.make_id))); }));
    app.get('/api/oil/cars', limit, wrap(async (req, res) => { res.json(await oc.listTypes(pool, id(req.query.model_id))); }));
    app.get('/api/oil/by-car', limit, wrap(async (req, res) => { res.json(await oc.selectionByType(pool, id(req.query.car_id))); }));
    app.get('/api/oil/usage', verifyAdmin, requirePermission('settings.manage'), wrap(async (req, res) => { res.json(await pa.requestsToday(pool)); }));

    // Допуски товара (админка): список и замена
    app.get('/api/products/:id/approvals', verifyAdmin, requirePermission('settings.manage'), wrap(async (req, res) => {
        const pid = id(req.params.id);
        // Проверяем существование товара тем же запросом, чтобы неизвестный ID
        // не выглядел как существующий товар с пустым списком допусков.
        const r = await pool.query(
            `SELECT p.id, pa.approval
               FROM products p
               LEFT JOIN product_approvals pa ON pa.product_id = p.id
              WHERE p.id = $1
              ORDER BY pa.approval`, [pid]);
        if (!r.rowCount) return res.status(404).json({ error: 'Товар не найден' });
        res.json(r.rows.filter(x => x.approval !== null).map(x => x.approval));
    }));
    app.put('/api/products/:id/approvals', verifyAdmin, requirePermission('settings.manage'), wrap(async (req, res) => {
        const pid = id(req.params.id);
        const rawApprovals = req.body && req.body.approvals;
        if (!Array.isArray(rawApprovals) || rawApprovals.length > 80 ||
            rawApprovals.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 100)) {
            throw Object.assign(new Error('Некорректный список допусков'), { user: true });
        }
        const list = [...new Set(rawApprovals.map(value => value.trim()))];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Блокировка родительского товара не даёт принять пустую замену для
            // несуществующего ID и сериализует запись допусков с удалением товара.
            const product = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [pid]);
            if (!product.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Товар не найден' });
            }
            await client.query('DELETE FROM product_approvals WHERE product_id = $1', [pid]);
            for (const a of list) await client.query('INSERT INTO product_approvals (product_id, approval) VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, a]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        res.json({ success: true, count: list.length });
    }));
}

module.exports = { registerOilRoutes };
