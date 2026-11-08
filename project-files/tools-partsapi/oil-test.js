// Тест подбора масла и тех. жидкостей через partsapi.ru (метод toDopusk)
// Запуск на VPS (нужен Node 20+):
//   node oil-test.js            -> живой запрос с тестовым ключом, typeId=9318
//   node oil-test.js 12345      -> другой typeId (идентификатор модификации)
//   node oil-test.js --sample   -> без интернета, на сохранённом примере sample.json
// Ключи только из переменных окружения (в репозиторий их класть нельзя)
for (const n of ['PARTSAPI_KEY']) {
  if (!process.env[n]) { console.error('Не задана переменная ' + n + '. См. инструкцию: ключи задаются в окружении, не в коде.'); process.exit(1); }
}

const fs = require('fs');

const KEY = process.env.PARTSAPI_KEY; // тестовый: до 50 запросов/сутки
const arg = process.argv[2];

async function load() {
  if (arg === '--sample') return JSON.parse(fs.readFileSync(__dirname + '/sample.json', 'utf8'));
  const typeId = arg || '9318';
  const url = `https://api.partsapi.ru?method=toDopusk&key=${KEY}&typeId=${typeId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Превращаем ответ в удобную структуру: жидкость -> объём заправки, допуски, подходящие товары
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
      f.products.push({
        spec: g.group, article: it.artNumber, brand: it.manufactureName,
        packL: it.volume, priority: it.orderPosition,
      });
    }
  }
  for (const f of Object.values(fluids)) f.products.sort((a, b) => a.priority - b.priority);
  return Object.values(fluids);
}

(async () => {
  try {
    const data = await load();
    const result = buildSelection(data);
    for (const f of result) {
      console.log(`\n== ${f.fluid} ==`);
      console.log('Объём заправки:', f.fillVolumeL ? f.fillVolumeL + ' л' : 'не указан');
      console.log('Допуски:', f.approvals.length ? f.approvals.join('; ') : 'нет данных');
      if (!f.products.length) console.log('Товары: нет в ответе');
      f.products.forEach(p =>
        console.log(`  #${p.priority} ${p.spec} | ${p.brand} | арт. ${p.article} | фасовка ${p.packL} л`));
    }
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
})();
