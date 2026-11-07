// ==============================================================
// Адреса для админ-панели (admin-dashboard.html).
// Вставить в server.js ПОСЛЕ блока входа по SMS (там определён requireAdminAuth)
// и после server-oil-snippet.js (там подключён pa = require('./partsapi-cache')).
// Все адреса закрыты: без токена администратора вернут 401.
// ==============================================================

// Обзор: расход лимита, сколько машин и ответов в базе, сколько товаров с допусками
app.get('/api/admin/overview', requireAdminAuth, wrap(async (req, res) => {
  const [usage, veh, cache, prod] = await Promise.all([
    pa.requestsToday(pool),
    pool.query('SELECT COUNT(*)::int AS n FROM vehicles'),
    pool.query('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_empty)::int AS empty FROM api_cache WHERE expires_at > NOW()'),
    pool.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM product_approvals pa WHERE pa.product_id = p.id))::int AS with_approvals
                  FROM products p WHERE p.is_active = true`),
  ]);
  res.json({
    daily_limit: Number(process.env.PARTSAPI_DAILY_LIMIT || 45),
    requests_today: usage,
    vehicles: veh.rows[0].n,
    cached_responses: cache.rows[0].n,
    cached_empty: cache.rows[0].empty,
    products_total: prod.rows[0].total,
    products_with_approvals: prod.rows[0].with_approvals,
  });
}));

// Машины в базе (поиск по марке/модели/модификации/VIN)
app.get('/api/admin/vehicles', requireAdminAuth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const r = await pool.query(
    `SELECT v.car_id, v.make_name, v.model_name, v.modification, v.engine_type, v.capacity, v.power_ps,
            to_char(v.year_from, 'YYYY-MM') AS year_from, to_char(v.year_to, 'YYYY-MM') AS year_to,
            (SELECT COUNT(*)::int FROM vehicle_approvals a WHERE a.car_id = v.car_id) AS approvals_count
       FROM vehicles v
      WHERE $1 = '' OR (v.make_name || ' ' || v.model_name || ' ' || COALESCE(v.modification, '')) ILIKE '%' || $1 || '%'
         OR v.car_id IN (SELECT car_id FROM vin_lookup WHERE vin ILIKE $1 || '%')
      ORDER BY v.created_at DESC LIMIT 100`, [q]);
  res.json(r.rows);
}));
app.get('/api/admin/vehicle/:id', requireAdminAuth, wrap(async (req, res) => {
  const sel = await pa.getOilSelection(pool, req.params.id);
  if (!sel) return res.status(404).json({ error: 'Автомобиль не найден в базе' });
  res.json(sel);
}));

// Товары и их допуски
app.get('/api/admin/products', requireAdminAuth, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.name, p.brand, p.category, p.price,
            COALESCE(array_agg(pa.approval ORDER BY pa.approval) FILTER (WHERE pa.approval IS NOT NULL), '{}') AS approvals
       FROM products p LEFT JOIN product_approvals pa ON pa.product_id = p.id
      WHERE p.is_active = true GROUP BY p.id ORDER BY p.id`);
  res.json(r.rows);
}));
app.post('/api/admin/product-approvals', requireAdminAuth, wrap(async (req, res) => {
  const productId = Number(req.body.product_id);
  const approval = String(req.body.approval || '').trim().replace(/\s+/g, ' ');
  if (!Number.isInteger(productId) || productId < 1) throw new Error('Не указан товар');
  if (approval.length < 2 || approval.length > 100) throw new Error('Допуск: от 2 до 100 символов');
  // Не создаём дубль, если такой допуск уже есть в другом написании ("VW 504.00" = "VW 504 00")
  const dup = await pool.query(
    `SELECT 1 FROM product_approvals WHERE product_id = $1
        AND regexp_replace(upper(approval), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')`, [productId, approval]);
  if (dup.rows.length) return res.json({ success: true, added: false });
  const r = await pool.query(
    'INSERT INTO product_approvals (product_id, approval) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [productId, approval]);
  res.json({ success: true, added: r.rows.length > 0 });
}));
app.delete('/api/admin/product-approvals', requireAdminAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM product_approvals WHERE product_id = $1 AND approval = $2', [Number(req.body.product_id), req.body.approval]);
  res.json({ success: true });
}));
