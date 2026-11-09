// Кэш для PartsAPI: каждый уникальный запрос платный, поэтому сначала смотрим в свою базу.
// Подключение:  const pa = require('./partsapi-cache');  (pool - ваш pg.Pool из server.js)
//
// Главные функции:
//   pa.cachedApi(pool, method, params, ttlDays)  - любой метод API с кэшем в таблице api_cache
//   pa.saveVehicleFromCarsRow(pool, row)          - сохранить модификацию из getCars
//   pa.decodeVin(pool, vin)                       - VIN -> car_id (VINdecode), с кэшем
//   pa.loadCarData(pool, carId)                   - объёмы и допуски (GetFillVolumes + toDopusk), с кэшем
//   pa.getOilSelection(pool, carId)               - готовый подбор для приложения из своей базы
//   pa.requestsToday(pool)                        - сколько реальных запросов сделано сегодня
//
// Переменные .env (ключи PartsAPI; в код и в репозиторий их класть нельзя):
//   PARTSAPI_KEY_VINDECODE, PARTSAPI_KEY_GETFILLVOLUMES, PARTSAPI_KEY_TODOPUSK,
//   PARTSAPI_KEY_GETMAKES, PARTSAPI_KEY_GETMODELS, PARTSAPI_KEY_GETCARS
//   PARTSAPI_DAILY_LIMIT  - защитный лимит реальных запросов в сутки на метод (по умолчанию 45)

// Ошибки, текст которых можно показать клиенту. Остальные ошибки наружу не отдаём.
const userError = (msg, status = 400) => Object.assign(new Error(msg), { user: true, status });

const keyFor = m => process.env['PARTSAPI_KEY_' + m.toUpperCase()];
// Ключей в коде НЕТ: только переменные окружения. Нет ключа - понятная ошибка вместо запроса с "undefined".
function requireKey(m) {
  const k = keyFor(m);
  if (!k) throw new Error('Не задана переменная PARTSAPI_KEY_' + m.toUpperCase());
  return k;
}
const DAILY_LIMIT = Number(process.env.PARTSAPI_DAILY_LIMIT || 45);

// Сколько дней хранить ответ. Справочники и VIN почти не меняются.
const TTL_DAYS = { getMakes: 90, getModels: 90, getCars: 90, VINdecode: 365, GetFillVolumes: 180, toDopusk: 180 };
const EMPTY_TTL_DAYS = 1; // пустой ответ храним недолго: вдруг данные появятся позже

const isEmptyResponse = (method, d) => {
  if (method === 'toDopusk') return !(d && (d.oils?.length || d.specifications?.length));
  if (method === 'VINdecode') return !(d && d.result && d.result['0']);
  return Array.isArray(d) ? d.length === 0 : !d;
};

const inflight = new Map(); // защита: два одинаковых запроса одновременно = один платный вызов

async function cachedApi(pool, method, params = {}, ttlDays = TTL_DAYS[method] || 30) {
  const clean = Object.entries(params).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b));
  const cacheKey = method + '|' + clean.map(([k, v]) => `${k}=${v}`).join('&'); // ключ API сюда не попадает

  const hit = await pool.query('SELECT response FROM api_cache WHERE cache_key = $1 AND expires_at > NOW()', [cacheKey]);
  if (hit.rows.length) return { data: hit.rows[0].response, fromCache: true };

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const job = (async () => {
    // Защитный лимит: не даём приложению выжечь суточный лимит ключа
    const used = await pool.query(
      "SELECT COUNT(*)::int AS n FROM api_request_log WHERE method = $1 AND created_at > date_trunc('day', NOW())", [method]);
    if (used.rows[0].n >= DAILY_LIMIT) {
      console.warn(`[PartsAPI] суточный лимит ${method} исчерпан`);
      throw userError('Подбор по этой машине сейчас недоступен. Напишите нам — подберём вручную.', 503);
    }
    let data;
    try {
      const url = 'https://api.partsapi.ru?' + new URLSearchParams({ method, key: requireKey(method), ...Object.fromEntries(clean) });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      await pool.query('INSERT INTO api_request_log (method, ok) VALUES ($1, true)', [method]);
    } catch (e) {
      await pool.query('INSERT INTO api_request_log (method, ok, error) VALUES ($1, false, $2)', [method, e.message]);
      throw new Error(`${method}: ${e.message}`); // ошибки в кэш НЕ пишем
    }
    const empty = isEmptyResponse(method, data);
    const days = empty ? EMPTY_TTL_DAYS : ttlDays;
    await pool.query(
      `INSERT INTO api_cache (cache_key, method, response, is_empty, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5 || ' days')::interval)
       ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, is_empty = EXCLUDED.is_empty,
         fetched_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [cacheKey, method, JSON.stringify(data), empty, String(days)]);
    return { data, fromCache: false };
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, job);
  return job;
}

// В TecDoc "по настоящее время" приходит как 1970-01-01 - это заглушка
const toDate = s => { if (!s) return null; const d = new Date(s); return (isNaN(d) || d.getUTCFullYear() <= 1970) ? null : d.toISOString().slice(0, 10); };
// "199701" (VINdecode) -> 1997-01-01
const ymToDate = s => (/^\d{6}$/.test(String(s || '')) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-01` : null);

async function saveVehicleFromCarsRow(pool, c, extra = {}) {
  await pool.query(
    `INSERT INTO vehicles (car_id, make_id, make_name, model_id, model_name, modification, engine_type, capacity, power_ps, year_from, year_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (car_id) DO UPDATE SET make_name = EXCLUDED.make_name, model_name = EXCLUDED.model_name,
       modification = EXCLUDED.modification, engine_type = EXCLUDED.engine_type, capacity = EXCLUDED.capacity,
       power_ps = EXCLUDED.power_ps, year_from = EXCLUDED.year_from, year_to = EXCLUDED.year_to`,
    [c.CAR_ID, c.MAKE_ID, c.MAKE_NAME || extra.make_name || '', c.MODEL_ID, c.FULL_MODEL_NAME || c.MODEL_NAME || extra.model_name || '', c.CAR_NAME, c.ENGINE_TYPE,
     c.CAPACITY, Number(c.POWER_PS) || null, toDate(c.YEAR_START), toDate(c.YEAR_END)]);
  return c.CAR_ID;
}

async function decodeVin(pool, vin) {
  vin = String(vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw userError('VIN должен состоять из 17 символов: латиница и цифры, без букв I, O, Q');
  const known = await pool.query('SELECT car_id FROM vin_lookup WHERE vin = $1', [vin]);
  if (known.rows.length) return { carId: known.rows[0].car_id, fromCache: true };

  const { data, fromCache } = await cachedApi(pool, 'VINdecode', { vin, lang: 'ru' });
  const car = data && data.result && data.result['0'];
  if (!car) throw userError('По этому VIN автомобиль не найден. Выберите машину по марке и модели.', 404);
  const carId = car.carId || car.typeNumber;
  await pool.query(
    `INSERT INTO vehicles (car_id, make_id, make_name, model_id, model_name, modification, engine_type, capacity, power_ps, year_from, year_to)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10) ON CONFLICT (car_id) DO NOTHING`,
    [carId, car.manuId, car.manuName, car.modId, car.modelName, car.typeName,
     car.cylinderCapacityLiter ? `${car.cylinderCapacityCcm}/${car.cylinderCapacityLiter} l` : null,
     Number(car.powerHpFrom) || null, ymToDate(car.yearOfConstrFrom), ymToDate(car.yearOfConstrTo)]);
  await pool.query('INSERT INTO vin_lookup (vin, car_id, raw) VALUES ($1,$2,$3) ON CONFLICT (vin) DO NOTHING',
    [vin, carId, JSON.stringify(car)]);
  return { carId, fromCache };
}

// GetFillVolumes дублирует записи в разных единицах (liter и "л.") - сводим к одной
function normalizeFill(list) {
  const unitMap = { liter: 'л', 'л.': 'л', gramme: 'г', 'гр.': 'г', 'cm³': 'см³' };
  const seen = new Set(), out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const unit = r.fillUnit ? (unitMap[r.fillUnit] || r.fillUnit) : null;
    const item = { title: r.fillTitle, info: r.fillInfo || null, unit, value: String(r.fillVolume).trim() };
    const k = [item.title, item.info, item.unit, item.value].join('|');
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

async function loadCarData(pool, carId) {
  const id = String(carId);
  const exists = await pool.query('SELECT 1 FROM vehicles WHERE car_id = $1', [id]);
  if (!exists.rows.length) throw userError('Автомобиль не найден. Выберите его заново.', 404);

  const fill = await cachedApi(pool, 'GetFillVolumes', { carId: id });
  const dop = await cachedApi(pool, 'toDopusk', { typeId: id });

  // Разворачиваем в нормальные таблицы только если данные пришли свежие (из кэша они там уже есть)
  if (!fill.fromCache || !dop.fromCache) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!fill.fromCache) {
        await client.query('DELETE FROM vehicle_fill_volumes WHERE car_id = $1', [id]);
        for (const f of normalizeFill(fill.data)) {
          await client.query(
            'INSERT INTO vehicle_fill_volumes (car_id, title, info, unit, value_text) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [id, f.title, f.info, f.unit, f.value]);
        }
      }
      if (!dop.fromCache) {
        await client.query('DELETE FROM vehicle_approvals WHERE car_id = $1', [id]);
        await client.query('DELETE FROM vehicle_oil_items WHERE car_id = $1', [id]);
        const d = dop.data || {};
        for (const s of d.specifications || []) {
          for (const p of s.properties || []) {
            for (const v of p.values || []) {
              await client.query(
                'INSERT INTO vehicle_approvals (car_id, fluid, approval_type, approval) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                [id, s.name, p.catalogItemType, v]);
            }
          }
        }
        for (const g of d.oils || []) {
          for (const it of g.items || []) {
            await client.query(
              `INSERT INTO vehicle_oil_items (car_id, fluid, spec_group, article, brand, pack_liters, priority)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [id, it.originalName, g.group, it.artNumber, it.manufactureName, it.volume, it.orderPosition]);
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  return { fillFromCache: fill.fromCache, approvalsFromCache: dop.fromCache };
}

// Подбор для приложения: берёт ТОЛЬКО из своей базы, к PartsAPI не обращается.
async function getOilSelection(pool, carId) {
  const id = String(carId);
  const v = await pool.query(
    `SELECT car_id, make_id, make_name, model_id, model_name, modification, engine_type, capacity, power_ps,
            to_char(year_from, 'YYYY-MM') AS year_from, to_char(year_to, 'YYYY-MM') AS year_to
       FROM vehicles WHERE car_id = $1`, [id]);
  if (!v.rows.length) return null;
  const fill = await pool.query('SELECT title, info, unit, value_text FROM vehicle_fill_volumes WHERE car_id = $1 ORDER BY id', [id]);
  const appr = await pool.query('SELECT fluid, approval_type, approval FROM vehicle_approvals WHERE car_id = $1 ORDER BY fluid, approval', [id]);
  const oems = await pool.query(
    'SELECT fluid, spec_group, article, brand, pack_liters, priority FROM vehicle_oil_items WHERE car_id = $1 ORDER BY fluid, priority', [id]);
  // Ваши товары, у которых заявлен подходящий допуск (сравнение без учёта пробелов, точек и регистра: "VW 504.00" = "VW 50400")
  const ours = await pool.query(
    `SELECT p.id, p.name, p.brand, p.volume, p.viscosity, p.price, p.image, array_agg(DISTINCT pa.approval) AS matched_approvals
       FROM products p
       JOIN product_approvals pa ON pa.product_id = p.id
      WHERE p.active = true AND p.coming_soon = false
        AND regexp_replace(upper(pa.approval), '[^A-Z0-9]', '', 'g') IN (
              SELECT regexp_replace(upper(approval), '[^A-Z0-9]', '', 'g') FROM vehicle_approvals WHERE car_id = $1)
      GROUP BY p.id ORDER BY p.name`, [id]);
  // Безопасность подбора: если у машины известна допустимая вязкость, показываем только масла с такой вязкостью
  const viscRe = /\b(\d{1,2})W-?(\d{2})\b/gi;
  const norm = m => m.replace(/-/g, '').toUpperCase();
  const allowed = new Set();
  for (const text of [...fill.rows.map(f => f.info), ...oems.rows.map(o => o.spec_group)]) {
    for (const m of String(text || '').match(viscRe) || []) allowed.add(norm(m));
  }
  const viscOf = p => { const m = String(p.viscosity || p.name || '').match(viscRe); return m ? norm(m[0]) : null; };
  const ourProducts = ours.rows
    .filter(p => allowed.size === 0 || (viscOf(p) && allowed.has(viscOf(p))))
    .sort((a, b) => b.matched_approvals.length - a.matched_approvals.length);
  return { vehicle: v.rows[0], fill_volumes: fill.rows, approvals: appr.rows, manufacturer_items: oems.rows,
           allowed_viscosity: [...allowed], our_products: ourProducts };
}

async function requestsToday(pool) {
  const r = await pool.query(
    "SELECT method, COUNT(*)::int AS n FROM api_request_log WHERE created_at > date_trunc('day', NOW()) GROUP BY method ORDER BY method");
  return r.rows;
}

module.exports = { cachedApi, saveVehicleFromCarsRow, decodeVin, loadCarData, getOilSelection, requestsToday, normalizeFill };
