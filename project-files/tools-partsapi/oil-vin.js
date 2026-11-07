// Цепочка: VIN -> автомобиль (VINdecode) -> заправочные объёмы (GetFillVolumes) -> допуски и масла (toDopusk)
// Запуск (Node 20+, файлы sample*.json рядом):
//   node oil-vin.js WAUBH54B11N111054     -> живые запросы
//   node oil-vin.js --sample              -> офлайн, на сохранённых примерах
// Ключи (у каждого метода свой тестовый ключ, до 50 запросов/сутки):
//   PARTSAPI_VIN_KEY  - для VINdecode
//   PARTSAPI_FILL_KEY - для GetFillVolumes
//   PARTSAPI_KEY      - для toDopusk
const fs = require('fs');

const VIN_KEY = process.env.PARTSAPI_VIN_KEY || '5cdb1bdd38ea05fb81466bafb1d86efb';
const FILL_KEY = process.env.PARTSAPI_FILL_KEY || '082fc8ed3d859321bb7643c0e0cfdab4';
const OIL_KEY = process.env.PARTSAPI_KEY || '3e8ae0c9ad0fb3c7575acc79891d5562';
const arg = process.argv[2] || 'WAUBH54B11N111054';
const SAMPLE = arg === '--sample';

async function api(params, sampleFile) {
  if (SAMPLE) return JSON.parse(fs.readFileSync(__dirname + '/' + sampleFile, 'utf8'));
  const res = await fetch('https://api.partsapi.ru?' + new URLSearchParams(params));
  if (!res.ok) throw new Error(`${params.method}: HTTP ${res.status}`);
  return res.json();
}

// GetFillVolumes отдаёт плоский список; единицы дублируются (liter и "л.", gramme и "гр."),
// число пишется через запятую, а в fillVolume бывают коды спецификаций. Нормализуем и убираем дубли.
function normalizeFill(list) {
  const unitMap = { liter: 'л', 'л.': 'л', gramme: 'г', 'гр.': 'г', 'cm³': 'см³' };
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const unit = r.fillUnit ? (unitMap[r.fillUnit] || r.fillUnit) : null;
    const item = { title: r.fillTitle, info: r.fillInfo || null, unit, value: String(r.fillVolume).trim() };
    const key = [item.title, item.info, item.unit, item.value].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildSelection(data) {
  const fluids = {};
  for (const s of data.specifications || []) {
    fluids[s.catalogItemId] = {
      fluid: s.name,
      fillVolumeL: s.volume ? Number(s.volume) : null,
      approvals: (s.properties || []).flatMap(p => p.values.map(v => `${p.catalogItemType}: ${v}`)),
      products: [],
    };
  }
  for (const g of data.oils || []) {
    for (const it of g.items) {
      const f = fluids[it.catalogItemId] || (fluids[it.catalogItemId] = {
        fluid: it.originalName, fillVolumeL: null, approvals: [], products: [],
      });
      f.products.push({ spec: g.group, article: it.artNumber, brand: it.manufactureName,
                        packL: it.volume, priority: it.orderPosition });
    }
  }
  for (const f of Object.values(fluids)) f.products.sort((a, b) => a.priority - b.priority);
  return Object.values(fluids);
}

(async () => {
  try {
    // Шаг 1. Расшифровка VIN
    const vinData = await api({ method: 'VINdecode', key: VIN_KEY, vin: arg, lang: 'ru' }, 'sample-vin.json');
    const car = vinData.result && vinData.result['0'];
    if (!car) {
      console.error('VINdecode не нашёл автомобиль. Ответ:', JSON.stringify(vinData).slice(0, 500));
      process.exit(1);
    }
    console.log(`Автомобиль: ${car.manuName} ${car.modelName} ${car.typeName}`);
    console.log(`Годы выпуска: ${car.yearOfConstrFrom} - ${car.yearOfConstrTo}, двигатель ${car.cylinderCapacityLiter} л, ${car.powerHpFrom} л.с.`);

    // Шаг 2. Заправочные объёмы (carId из VINdecode)
    const carId = car.carId || car.typeNumber;
    const fillRaw = await api({ method: 'GetFillVolumes', key: FILL_KEY, carId: String(carId) }, 'sample-fill.json');
    const fills = normalizeFill(fillRaw);
    console.log(`\n--- Заправочные объёмы (carId ${carId}) ---`);
    if (!fills.length) console.log('GetFillVolumes ничего не вернул для этого carId.');
    for (const f of fills) {
      const val = f.unit ? `${f.value} ${f.unit}` : f.value; // без единицы - обычно код спецификации
      console.log(`${f.title}${f.info ? ' (' + f.info + ')' : ''}: ${val}`);
    }

    // Шаг 3. typeNumber из VINdecode передаём в toDopusk как typeId
    const typeId = car.typeNumber;
    console.log(`typeNumber (используем как typeId): ${typeId}`);
    const oilData = await api({ method: 'toDopusk', key: OIL_KEY, typeId: String(typeId) }, 'sample.json');

    if (!oilData.oils && !oilData.specifications) {
      console.log('\nВНИМАНИЕ: toDopusk не вернул oils/specifications для этого typeId.');
      console.log('Ключи в ответе:', Object.keys(oilData).join(', '));
      console.log('Возможно, typeNumber из VINdecode не равен typeId для toDopusk, или для модификации нет данных.');
      process.exit(2);
    }

    // Шаг 4. Вывод подбора
    for (const f of buildSelection(oilData)) {
      console.log(`\n== ${f.fluid} ==`);
      console.log('Объём заправки:', f.fillVolumeL ? f.fillVolumeL + ' л' : 'не указан');
      console.log('Допуски:', f.approvals.length ? f.approvals.join('; ') : 'нет данных');
      if (!f.products.length) console.log('Товары: нет в ответе');
      f.products.forEach(p => console.log(`  #${p.priority} ${p.spec} | ${p.brand} | арт. ${p.article} | фасовка ${p.packL} л`));
    }
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
})();
