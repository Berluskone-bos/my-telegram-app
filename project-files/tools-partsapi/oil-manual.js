// Ручной выбор автомобиля (для клиентов без VIN) и проверка, что CAR_ID из getCars
// подходит для GetFillVolumes и toDopusk.
// Запуск (Node 20+):
//   node oil-manual.js                     -> makeId=5 (Audi), modelId=40155, проверка первых 3 модификаций
//   node oil-manual.js 5 40155 5           -> makeId, modelId, сколько модификаций проверять
//   node oil-manual.js --sample            -> офлайн: только список модификаций из sample-cars.json
// Ключи (у каждого метода свой, до 50 запросов в сутки):
//   PARTSAPI_CARS_KEY, PARTSAPI_FILL_KEY, PARTSAPI_KEY (toDopusk)
// Ключи только из переменных окружения (в репозиторий их класть нельзя)
for (const n of ['PARTSAPI_CARS_KEY', 'PARTSAPI_FILL_KEY', 'PARTSAPI_KEY']) {
  if (!process.env[n]) { console.error('Не задана переменная ' + n + '. См. инструкцию: ключи задаются в окружении, не в коде.'); process.exit(1); }
}

const fs = require('fs');

const CARS_KEY = process.env.PARTSAPI_CARS_KEY;
const FILL_KEY = process.env.PARTSAPI_FILL_KEY;
const OIL_KEY = process.env.PARTSAPI_KEY;

const SAMPLE = process.argv[2] === '--sample';
const makeId = SAMPLE ? '5' : (process.argv[2] || '5');
const modelId = process.argv[3] || '40155';
const checkCount = Number(process.argv[4] || 3);

async function api(params) {
  const res = await fetch('https://api.partsapi.ru?' + new URLSearchParams(params));
  if (!res.ok) throw new Error(`${params.method}: HTTP ${res.status}`);
  return res.json();
}
const fmtDate = s => { if (!s) return 'по н.в.'; const d = new Date(s); return isNaN(d) ? s : d.toISOString().slice(0, 7); };

(async () => {
  try {
    const cars = SAMPLE
      ? JSON.parse(fs.readFileSync(__dirname + '/sample-cars.json', 'utf8'))
      : await api({ method: 'getCars', key: CARS_KEY, makeId, carType: 'PC', modelId });

    if (!Array.isArray(cars) || !cars.length) {
      console.log('getCars не вернул модификации. Ответ:', JSON.stringify(cars).slice(0, 500));
      process.exit(1);
    }
    console.log(`Модификаций: ${cars.length}\n`);
    for (const c of cars) {
      console.log(`CAR_ID ${c.CAR_ID} | ${c.MAKE_NAME} ${c.CAR_NAME} | ${c.ENGINE_TYPE}, ${c.CAPACITY}, ${c.POWER_PS} л.с. | ${fmtDate(c.YEAR_START)} - ${fmtDate(c.YEAR_END)}`);
    }

    if (SAMPLE) { console.log('\n(офлайн-режим: проверка GetFillVolumes и toDopusk пропущена)'); return; }

    // Проверяем: принимают ли соседние методы CAR_ID из getCars
    console.log(`\nПроверка CAR_ID на соседних методах (первые ${checkCount}):`);
    for (const c of cars.slice(0, checkCount)) {
      const id = String(c.CAR_ID);
      let fillInfo, oilInfo;
      try {
        const fill = await api({ method: 'GetFillVolumes', key: FILL_KEY, carId: id });
        fillInfo = Array.isArray(fill) && fill.length ? `${fill.length} записей` : 'пусто';
      } catch (e) { fillInfo = 'ошибка: ' + e.message; }
      try {
        const oil = await api({ method: 'toDopusk', key: OIL_KEY, typeId: id });
        oilInfo = (oil.oils || oil.specifications)
          ? `oils: ${(oil.oils || []).length}, specifications: ${(oil.specifications || []).length}`
          : 'нет oils/specifications (ключи: ' + Object.keys(oil).join(', ') + ')';
      } catch (e) { oilInfo = 'ошибка: ' + e.message; }
      console.log(`CAR_ID ${id} (${c.CAR_NAME}): GetFillVolumes -> ${fillInfo}; toDopusk -> ${oilInfo}`);
    }
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
})();
