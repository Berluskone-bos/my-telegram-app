// ==============================================================
// Адреса для server.js: подбор масла по VIN или по выбору машины.
// Все запросы идут через кэш: повторный запрос к PartsAPI не уходит.
// Вставить в server.js перед строкой  const PORT = ...
// ==============================================================
const pa = require('./partsapi-cache');

const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.message.includes('лимит') ? 503 : 400).json({ error: e.message }); }
};

// 1) Подбор по VIN: GET /api/oil/by-vin?vin=WAUBH54B11N111054
app.get('/api/oil/by-vin', wrap(async (req, res) => {
  const { carId } = await pa.decodeVin(pool, req.query.vin);
  await pa.loadCarData(pool, carId);
  res.json(await pa.getOilSelection(pool, carId));
}));

// 2) Ручной выбор: марки -> модели -> модификации (каждый шаг кэшируется)
app.get('/api/oil/makes', wrap(async (req, res) => {
  const { data } = await pa.cachedApi(pool, 'getMakes', { carType: 'PC' });
  res.json(data);
}));
app.get('/api/oil/models', wrap(async (req, res) => {
  const { data } = await pa.cachedApi(pool, 'getModels', { carType: 'PC', makeId: req.query.make_id, lang: '16' });
  res.json(data);
}));
app.get('/api/oil/cars', wrap(async (req, res) => {
  const { data } = await pa.cachedApi(pool, 'getCars', { carType: 'PC', makeId: req.query.make_id, modelId: req.query.model_id });
  for (const c of data) await pa.saveVehicleFromCarsRow(pool, c); // запоминаем все показанные модификации
  res.json(data);
}));

// 3) Подбор по выбранной модификации: GET /api/oil/by-car?car_id=150179
app.get('/api/oil/by-car', wrap(async (req, res) => {
  await pa.loadCarData(pool, req.query.car_id);
  res.json(await pa.getOilSelection(pool, req.query.car_id));
}));

// 4) Расход лимита за сегодня (позже закройте requireAdminAuth из входа в админку)
app.get('/api/oil/usage', wrap(async (req, res) => {
  res.json(await pa.requestsToday(pool));
}));
