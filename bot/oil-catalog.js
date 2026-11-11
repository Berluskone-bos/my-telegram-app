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

// ---- Поиск по VIN: VINdecode (TecDoc) знает марку, модель, мощность и объём; номер машины берём из каталога ТО ----
const norm = s => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-ZА-Я0-9]/g, '');
const codes = s => ((String(s || '').match(/\(([^)]*)\)/g) || []).join(' ').toUpperCase().match(/[A-Z0-9]{2,}/g) || []);
const ymYear = s => (/^\d{4}/.test(String(s || '')) ? Number(String(s).slice(0, 4)) : null);

function pickModels(vin, models) {          // models: [{id, name, yearFrom, yearTo}] из toModels (сырые)
  const n1 = norm(vin.modelName), c1 = codes(vin.modelName);
  const from = ymYear(vin.yearOfConstrFrom), to = ymYear(vin.yearOfConstrTo) || 9999;
  const scored = [];
  for (const m of models) {
    const n2 = norm(m.name); if (!n1 || !n2) continue;
    let s = n1 === n2 ? 2 : (n2.startsWith(n1) || n1.startsWith(n2)) ? 1 : 0;
    if (!s) continue;
    if (codes(m.name).some(c => c1.includes(c))) s += 2;
    const mf = m.yearFrom || 0, mt = m.yearTo || 9999;
    if (from && (mt < from || mf > to)) continue;             // периоды выпуска не пересекаются
    scored.push({ m, s });
  }
  const best = Math.max(0, ...scored.map(x => x.s));
  let top = scored.filter(x => x.s === best).map(x => x.m);
  if (top.length > 1 && from) {                       // поколения: берём то, что началось ближе всего к году выпуска VIN
    const d = m => Math.abs((m.yearFrom || 0) - from);
    const dmin = Math.min(...top.map(d));
    const near = top.filter(m => d(m) === dmin);
    if (near.length === 1) top = near;
  }
  return top;
}

async function vinSearch(pool, vin) {
  vin = String(vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw userError('VIN должен состоять из 17 символов: латиница и цифры, без букв I, O, Q');
  const { data } = await pa.cachedApi(pool, 'VINdecode', { vin, lang: 'ru' });
  const car = data && data.result && data.result['0'];
  if (!car) {
    console.warn(`[PartsAPI] VINdecode: пустой ответ, WMI=${vin.slice(0, 3)}, статус=${String(data && data.statusMsg || '').slice(0, 80)}`);
    throw userError('PartsAPI не нашёл автомобиль по этому VIN. Выберите машину по марке и модели.', 404);
  }
  const base = { needs_pick: true, make_name: car.manuName || '', model_name: car.modelName || '', type_name: car.typeName || '', year: ymYear(car.yearOfConstrFrom) };
  const makes = await listMakes(pool);
  const mk = makes.find(m => norm(m.makeName) === norm(car.manuName)) || makes.find(m => norm(m.makeName).startsWith(norm(car.manuName)) && norm(car.manuName).length >= 3);
  if (!mk) return base;
  base.make_id = mk.makeId;
  const { data: rawModels } = await pa.cachedApi(pool, 'toModels', { brandId: mk.makeId });
  const models = pickModels(car, Array.isArray(rawModels) ? rawModels : []);
  if (models.length !== 1) return { ...base, model_candidates: models.slice(0, 8).map(m => ({ id: m.id, name: m.name })) };
  base.model_id = models[0].id;
  const types = await listTypes(pool, models[0].id);
  const { data: rawTypes } = await pa.cachedApi(pool, 'toTypes', { modelId: models[0].id });
  const mods = (rawTypes && rawTypes.modifications) || [];
  const hp = Number(car.powerHpFrom) || 0, ccm = Number(car.cylinderCapacityCcm) || 0;
  const near = mods.filter(t => (!hp || Math.abs((t.horsePower || 0) - hp) <= 3) && (!ccm || Math.abs((t.engineCapacity || 0) * 1000 - ccm) <= 60));
  const same = near.filter(t => t.horsePower === hp);       // точное совпадение мощности важнее близкого
  const fit = same.length ? same : near;
  const label = id => (types.find(x => x.CAR_ID === id) || {}).CAR_NAME || String(id);
  if (fit.length === 1) {
    const r = await selectionByType(pool, fit[0].id);
    return { ...r, vin_info: { make: base.make_name, model: base.model_name, type: base.type_name, matched: label(fit[0].id) } };
  }
  const list = (fit.length ? fit : mods).slice(0, 30);
  return { ...base, candidates: list.map(t => ({ id: t.id, label: label(t.id) })), exact: fit.length > 0 };
}

module.exports = { listMakes, listModels, listTypes, selectionByType, dopuskToInput, vinSearch, pickModels };
