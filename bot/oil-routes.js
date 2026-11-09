// Подбор масла по VIN и по марке/модели. Все запросы к PartsAPI идут через кэш в БД.
const pa = require('./partsapi-cache');

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

    app.get('/api/oil/by-vin', limit, wrap(async (req, res) => {
        const { carId } = await pa.decodeVin(pool, req.query.vin);
        await pa.loadCarData(pool, carId);
        res.json(await pa.getOilSelection(pool, carId));
    }));
    app.get('/api/oil/makes', limit, wrap(async (req, res) => {
        res.json((await pa.cachedApi(pool, 'getMakes', { carType: 'PC' })).data);
    }));
    app.get('/api/oil/models', limit, wrap(async (req, res) => {
        res.json((await pa.cachedApi(pool, 'getModels', { carType: 'PC', makeId: id(req.query.make_id), lang: '16' })).data);
    }));
    app.get('/api/oil/cars', limit, wrap(async (req, res) => {
        const { data } = await pa.cachedApi(pool, 'getCars', { carType: 'PC', makeId: id(req.query.make_id), modelId: id(req.query.model_id) });
        const list = Array.isArray(data) ? data : [];
        const extra = { make_name: String(req.query.make_name || '').slice(0, 100), model_name: String(req.query.model_name || '').slice(0, 200) };
        for (const c of list) await pa.saveVehicleFromCarsRow(pool, c, extra);
        res.json(list.map(c => ({ CAR_ID: c.CAR_ID, CAR_NAME: c.CAR_NAME, ENGINE_TYPE: c.ENGINE_TYPE, CAPACITY: c.CAPACITY,
                                  POWER_PS: c.POWER_PS, YEAR_START: c.YEAR_START, YEAR_END: c.YEAR_END })));
    }));
    app.get('/api/oil/by-car', limit, wrap(async (req, res) => {
        const carId = id(req.query.car_id);
        await pa.loadCarData(pool, carId);
        res.json(await pa.getOilSelection(pool, carId));
    }));
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
