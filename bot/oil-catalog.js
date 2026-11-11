// Подбор по каталогу ТО PartsAPI: toMakes -> toModels -> toTypes -> typeId -> toDopusk.
// toDopusk по typeId отдаёт объёмы заправки, вязкость, допуски и рекомендованные масла по всем системам машины.
// Все запросы идут через кэш (partsapi-cache.cachedApi): платный запрос делается один раз.
const pa = require('./partsapi-cache');
const { buildSystems } = require('./oil-systems');

const userError = (msg, status = 400) => Object.assign(new Error(msg), { user: true, status });
const year = s => { const m = /^(\d{4})/.exec(String(s || '')); return m ? m[1] : null; };

async function listMakes(pool) {
  const { data } = await pa.cachedApi(pool, 'toMakes', {});
  return (Array.isArray(data) ? data : []).filter(m => m && m.id && m.name).map(m => ({ makeId: m.id, makeName: String(m.name) }));
}

async function listModels(pool, brandId) {
  const { data } = await pa.cachedApi(pool, 'toModels', { brandId });
  return (Array.isArray(data) ? data : []).filter(m => m && m.id && m.name).map(m => ({
    modelId: m.id,
    modelName: `${m.name}${m.yearFrom ? ` (${m.yearFrom}–${m.yearTo || 'н.в.'})` : ''}`,
  }));
}

// Модификации модели; заодно запоминаем их (чтобы показать название в результате подбора)
async function listTypes(pool, modelId) {
  const { data } = await pa.cachedApi(pool, 'toTypes', { modelId });
  const list = data && Array.isArray(data.modifications) ? data.modifications : [];
  for (const t of list) {
    if (!t.id) continue;
    await pool.query(
      `INSERT INTO to_vehicles (type_id, brand_id, brand_name, model_id, model_name, full_name, engine_code, engine_capacity, horse_power, fuel, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (type_id) DO UPDATE SET brand_name = EXCLUDED.brand_name, model_name = EXCLUDED.model_name, full_name = EXCLUDED.full_name,
         engine_code = EXCLUDED.engine_code, engine_capacity = EXCLUDED.engine_capacity, horse_power = EXCLUDED.horse_power,
         fuel = EXCLUDED.fuel, start_date = EXCLUDED.start_date, updated_at = NOW()`,
      [t.id, t.brand && t.brand.id, t.brand && t.brand.name || '', t.model && t.model.id, t.model && t.model.name || '',
       t.fullName || t.name || '', t.engineCode || null, t.engineCapacity || null, t.horsePower || null, t.fuel || null,
       t.startDate ? String(t.startDate).slice(0, 10) : null]);
  }
  return list.filter(t => t.id).map(t => ({
    CAR_ID: t.id,
    CAR_NAME: `${t.fullName || t.name}${t.engineCode ? ', ' + t.engineCode : ''}`,
  }));
}

// Ответ toDopusk -> вход для buildSystems (oil-systems.js)
function dopuskToInput(d) {
  const fill = [], approvals = [], items = [];
  for (const s of (d && d.specifications) || []) {
    const title = s.comment ? `${s.name} (${s.comment})` : String(s.name || '');
    if (s.volume !== undefined && String(s.volume).trim() !== '') fill.push({ title, info: null, unit: 'л', value_text: String(s.volume).trim() });
    for (const p of s.properties || []) {
      const viscosity = /вязкость/i.test(p.catalogItemType || '');
      for (const v of p.values || []) approvals.push({ fluid: title, approval: String(v), kind: viscosity ? 'viscosity' : 'approval' });
    }
  }
  for (const g of (d && d.oils) || []) {
    const first = (g.items || [])[0] || {};
    items.push({ fluid: first.originalName || '', spec_group: g.group, brand: first.manufactureName || null });
  }
  return { fill, approvals, items };
}

async function activeProducts(pool) {
  const r = await pool.query(
    `SELECT p.id, p.name, p.category, p.volume, p.viscosity, p.price,
            COALESCE(array_agg(pa.approval) FILTER (WHERE pa.approval IS NOT NULL), '{}') AS approvals
       FROM products p LEFT JOIN product_approvals pa ON pa.product_id = p.id
      WHERE p.active = true AND p.coming_soon = false
      GROUP BY p.id ORDER BY p.name`);
  return r.rows;
}

async function selectionByType(pool, typeId) {
  const { data } = await pa.cachedApi(pool, 'toDopusk', { typeId });
  const input = dopuskToInput(data);
  const v = await pool.query('SELECT * FROM to_vehicles WHERE type_id = $1', [typeId]);
  const t = v.rows[0];
  const vehicle = t ? {
    make_name: t.brand_name, model_name: t.model_name, modification: t.full_name,
    year_from: null, year_to: null,   // годы уже есть в названии модификации
  } : { make_name: '', model_name: 'Автомобиль', modification: '', year_from: null, year_to: null };
  const noData = !input.fill.length && !input.approvals.length && !input.items.length;
  const systems = buildSystems({ ...input, products: await activeProducts(pool) });
  const cache = await pool.query('SELECT is_empty, fetched_at FROM api_cache WHERE cache_key = $1', [`toDopusk|typeId=${typeId}`]);
  return { vehicle, systems, no_data: noData,
           diagnostics: { car_id: String(typeId), fill: { method: 'toDopusk', state: cache.rows[0] ? (cache.rows[0].is_empty ? 'PartsAPI вернул пусто' : 'данные получены') : 'нет в кэше', at: cache.rows[0] && cache.rows[0].fetched_at },
                          dopusk: { method: 'toDopusk', state: '', shape: '' } } };
}

// VIN: VINdecode знает марку и модель (TecDoc), но номер машины из другого каталога — поэтому только подсказка для выбора
async function vinHint(pool, vin) {
  vin = String(vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw userError('VIN должен состоять из 17 символов: латиница и цифры, без букв I, O, Q');
  const { data } = await pa.cachedApi(pool, 'VINdecode', { vin, lang: 'ru' });
  const car = data && data.result && data.result['0'];
  if (!car) { console.warn(`[PartsAPI] VINdecode: пустой ответ, WMI=${vin.slice(0, 3)}`); throw userError('По этому VIN автомобиль не найден. Выберите машину по марке и модели.', 404); }
  return { needs_pick: true, make_name: car.manuName || '', model_name: car.modelName || '', type_name: car.typeName || '', year: year(car.yearOfConstrFrom) };
}

module.exports = { listMakes, listModels, listTypes, selectionByType, dopuskToInput, vinHint };
