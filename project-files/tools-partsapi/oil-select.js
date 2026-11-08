// Полный ручной выбор автомобиля: марка -> модель -> модификация, затем объёмы и допуски.
// Запуск (Node 20+):
//   node oil-select.js audi q3            -> найдёт марку и модели с "q3", покажет модификации
//   node oil-select.js audi q3 1          -> то же + проверка объёмов и допусков для модификации №1 из списка
// Ключи (у каждого метода свой, до 50 запросов в сутки):
//   PARTSAPI_MAKES_KEY, PARTSAPI_MODELS_KEY, PARTSAPI_CARS_KEY, PARTSAPI_FILL_KEY, PARTSAPI_KEY (toDopusk)
// Ключи только из переменных окружения (в репозиторий их класть нельзя)
for (const n of ['PARTSAPI_CARS_KEY', 'PARTSAPI_FILL_KEY', 'PARTSAPI_KEY', 'PARTSAPI_MAKES_KEY', 'PARTSAPI_MODELS_KEY']) {
  if (!process.env[n]) { console.error('Не задана переменная ' + n + '. См. инструкцию: ключи задаются в окружении, не в коде.'); process.exit(1); }
}

const K = {
  makes:  process.env.PARTSAPI_MAKES_KEY,
  models: process.env.PARTSAPI_MODELS_KEY,
  cars:   process.env.PARTSAPI_CARS_KEY,
  fill:   process.env.PARTSAPI_FILL_KEY,
  oil:    process.env.PARTSAPI_KEY,
};
const [makeQ, modelQ, pickRaw] = process.argv.slice(2);

async function api(params) {
  const res = await fetch('https://api.partsapi.ru?' + new URLSearchParams(params));
  if (!res.ok) throw new Error(`${params.method}: HTTP ${res.status}`);
  return res.json();
}
// В TecDoc "дата по настоящее время" приходит как 1970-01-01 - это заглушка, а не реальная дата
const ym = s => { if (!s) return 'по н.в.'; const d = new Date(s); return (isNaN(d) || d.getUTCFullYear() <= 1970) ? 'по н.в.' : d.toISOString().slice(0, 7); };

(async () => {
  try {
    if (!makeQ || !modelQ) { console.log('Использование: node oil-select.js <марка> <модель> [номер модификации]'); process.exit(1); }

    // 1. Марка
    const makes = await api({ method: 'getMakes', key: K.makes, carType: 'PC' });
    const mq = makeQ.toLowerCase();
    // Точное совпадение предпочтительнее: "AUDI", а не "AUDI (FAW)"
    const make = makes.find(m => m.makeName.toLowerCase() === mq) || makes.find(m => m.makeName.toLowerCase().includes(mq));
    if (!make) { console.log(`Марка "${makeQ}" не найдена`); process.exit(1); }
    console.log(`Марка: ${make.makeName} (makeId ${make.makeId})`);

    // 2. Модель (lang=16 - русский)
    const models = await api({ method: 'getModels', key: K.models, carType: 'PC', makeId: String(make.makeId), lang: '16' });
    const moq = modelQ.toLowerCase();
    const foundModels = models.filter(m => `${m.modelName} ${m.shortModelName}`.toLowerCase().includes(moq));
    if (!foundModels.length) { console.log(`Модель "${modelQ}" не найдена среди ${models.length} моделей ${make.makeName}`); process.exit(1); }
    console.log(`\nМодели по запросу "${modelQ}" (${foundModels.length}):`);
    foundModels.forEach(m => console.log(`  modelId ${m.modelId} | ${m.modelName} | ${ym(m.yearsFrom)} - ${ym(m.yearsTo)}`));
    if (foundModels.length > 1) console.log('  (несколько моделей - берём первую; уточните запрос, если нужна другая)');
    const model = foundModels[0];

    // 3. Модификации
    const cars = await api({ method: 'getCars', key: K.cars, makeId: String(make.makeId), carType: 'PC', modelId: String(model.modelId) });
    console.log(`\nМодификации ${model.modelName} (${cars.length}):`);
    cars.forEach((c, i) => console.log(`  #${i + 1} CAR_ID ${c.CAR_ID} | ${c.CAR_NAME} | ${c.ENGINE_TYPE}, ${c.CAPACITY}, ${Number(c.POWER_PS)} л.с. | ${ym(c.YEAR_START)} - ${ym(c.YEAR_END)}`));

    // 4. Проверка выбранной модификации
    if (!pickRaw) { console.log('\nДобавьте номер модификации, чтобы проверить объёмы и допуски: node oil-select.js ' + makeQ + ' ' + modelQ + ' 1'); return; }
    const car = cars[Number(pickRaw) - 1];
    if (!car) { console.log(`\nМодификации №${pickRaw} нет в списке`); process.exit(1); }
    const id = String(car.CAR_ID);
    console.log(`\nПроверка CAR_ID ${id} (${car.CAR_NAME}):`);
    const fill = await api({ method: 'GetFillVolumes', key: K.fill, carId: id });
    console.log('GetFillVolumes:', Array.isArray(fill) && fill.length ? `${fill.length} записей` : 'пусто');
    const oil = await api({ method: 'toDopusk', key: K.oil, typeId: id });
    console.log('toDopusk:', (oil.oils || oil.specifications)
      ? `oils: ${(oil.oils || []).length}, specifications: ${(oil.specifications || []).length}`
      : 'нет oils/specifications (ключи ответа: ' + Object.keys(oil).join(', ') + ')');
  } catch (e) { console.error('Ошибка:', e.message); process.exit(1); }
})();
