// Шаг 1 ручного выбора авто: список марок (getMakes) + поиск по названию.
// Запуск (Node 20+):
//   node oil-makes.js            -> популярные марки с их makeId
//   node oil-makes.js toyota     -> поиск марки по части названия
//   node oil-makes.js --sample   -> офлайн, на sample-makes.json
// Ключ: PARTSAPI_MAKES_KEY (тестовый: до 50 запросов в сутки)
// Важно: в списке ~735 марок, включая китайские совместные предприятия ("AUDI (FAW)").
// В приложении список лучше один раз сохранить в базу, а не запрашивать у каждого клиента.
const fs = require('fs');
const KEY = process.env.PARTSAPI_MAKES_KEY || '308bd5cc6d03f9d33de161f943050b75';
const arg = process.argv[2];
const POPULAR = ['LADA', 'TOYOTA', 'KIA', 'HYUNDAI', 'VOLKSWAGEN', 'NISSAN', 'MAZDA', 'MITSUBISHI', 'SKODA', 'RENAULT',
                 'FORD', 'CHEVROLET', 'BMW', 'MERCEDES-BENZ', 'AUDI', 'HONDA', 'SUBARU', 'SUZUKI', 'LEXUS', 'OPEL'];

(async () => {
  try {
    let makes;
    if (arg === '--sample') makes = JSON.parse(fs.readFileSync(__dirname + '/sample-makes.json', 'utf8'));
    else {
      const res = await fetch('https://api.partsapi.ru?' + new URLSearchParams({ method: 'getMakes', key: KEY, carType: 'PC' }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      makes = await res.json();
    }
    if (!Array.isArray(makes) || !makes.length) throw new Error('Пустой или неожиданный ответ: ' + JSON.stringify(makes).slice(0, 300));
    console.log(`Всего марок: ${makes.length}`);

    if (arg && arg !== '--sample') {
      const q = arg.toLowerCase();
      const found = makes.filter(m => m.makeName.toLowerCase().includes(q));
      console.log(`Найдено по "${arg}": ${found.length}`);
      found.forEach(m => console.log(`makeId ${m.makeId} | ${m.makeName}`));
    } else {
      console.log('\nПопулярные марки (точное совпадение названия):');
      for (const name of POPULAR) {
        const m = makes.find(x => x.makeName.toUpperCase() === name);
        console.log(m ? `makeId ${m.makeId} | ${m.makeName}` : `— ${name}: не найдено`);
      }
    }
  } catch (e) { console.error('Ошибка:', e.message); process.exit(1); }
})();
