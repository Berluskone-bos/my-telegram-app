// Диагностика метода getCarsByOilSpecification: какие автомобили подходят под допуск масла.
// Запуск (Node 20+):
//   node oil-spec.js "MB 229.5"
//   node oil-spec.js "VW 504 00"
// Ключ: PARTSAPI_SPEC_KEY (тестовый: до 50 запросов в сутки). Спецификация - до 15 символов.
// Ключи только из переменных окружения (в репозиторий их класть нельзя)
for (const n of ['PARTSAPI_SPEC_KEY']) {
  if (!process.env[n]) { console.error('Не задана переменная ' + n + '. См. инструкцию: ключи задаются в окружении, не в коде.'); process.exit(1); }
}

const KEY = process.env.PARTSAPI_SPEC_KEY;
const query = process.argv[2] || 'MB 229.5';

(async () => {
  try {
    if (query.length > 15) throw new Error('Спецификация должна быть не длиннее 15 символов');
    const url = 'https://api.partsapi.ru?' + new URLSearchParams({ method: 'getCarsByOilSpecification', key: KEY, query });
    const res = await fetch(url);
    const text = await res.text();
    console.log(`HTTP ${res.status}, размер ответа: ${(text.length / 1024).toFixed(1)} КБ`);
    if (!res.ok) { console.log(text.slice(0, 500)); process.exit(1); }

    let data;
    try { data = JSON.parse(text); }
    catch { console.log('Ответ не JSON. Начало:\n' + text.slice(0, 500)); process.exit(2); }

    // Находим массив записей: либо сам ответ, либо первое поле-массив
    let list = Array.isArray(data) ? data : null;
    let listName = '(корень)';
    if (!list && data && typeof data === 'object') {
      console.log('Поля верхнего уровня:', Object.keys(data).join(', '));
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) { list = v; listName = k; break; }
        if (v && typeof v === 'object') { list = Object.values(v); listName = k; break; }
      }
    }
    if (!list) { console.log('Не нашёл список записей. Ответ:', JSON.stringify(data).slice(0, 500)); process.exit(3); }

    console.log(`Записей в "${listName}": ${list.length}`);
    if (list[0] && typeof list[0] === 'object') console.log('Поля записи:', Object.keys(list[0]).join(', '));
    console.log('Первые 3 записи:');
    list.slice(0, 3).forEach(r => console.log(JSON.stringify(r)));
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
})();
