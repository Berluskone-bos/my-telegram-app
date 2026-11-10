// Раскладывает данные PartsAPI по системам автомобиля (двигатель, КПП, редукторы, антифриз, тормоза...)
// и подбирает товары магазина. Чистая функция: без базы и сети, поэтому легко проверяется тестом.

const VISC_RE = /\b(\d{1,2})W-?(\d{2,3})\b/gi;
const normVisc = m => String(m).replace(/-/g, '').toUpperCase();
const normSpec = s => String(s || '').toUpperCase().replace(/[^A-Z0-9А-Я]/g, '');
const viscIn = text => (String(text || '').match(VISC_RE) || []).map(normVisc);

const SYSTEMS = [
  { key: 'engine',   title: 'Двигатель' },
  { key: 'gearbox',  title: 'Коробка передач' },
  { key: 'axle',     title: 'Редукторы, мосты, раздатка' },
  { key: 'steering', title: 'Гидроусилитель руля' },
  { key: 'coolant',  title: 'Охлаждающая жидкость' },
  { key: 'brake',    title: 'Тормозная жидкость' },
  { key: 'ac',       title: 'Кондиционер' },
  { key: 'other',    title: 'Другое' },
];

function systemOf(text) {
  const s = String(text || '').toLowerCase();
  if (/антифриз|охлажда|coolant/.test(s)) return 'coolant';
  if (/тормозн|brake/.test(s)) return 'brake';
  if (/гидроусилит|усилител|power steering|гур/.test(s)) return 'steering';
  if (/кондиционер|хладагент|refrigerant/.test(s)) return 'ac';
  if (/моторн|двигател|engine/.test(s)) return 'engine';
  if (/мост|редуктор|раздат|дифференц|transfer|axle|differential/.test(s)) return 'axle';
  if (/акпп|мкпп|кпп|коробк|вариатор|cvt|dsg|робот|трансмисс|atf|передач|transmission|gear/.test(s)) return 'gearbox';
  return 'other';
}

function gearboxKind(text) {
  const s = String(text || '').toLowerCase();
  if (/вариатор|cvt/.test(s)) return 'Вариатор';
  if (/dsg|робот|dct|pdk|s tronic|powershift/.test(s)) return 'Робот';
  if (/акпп|atf|автомат|automatic/.test(s)) return 'Автомат';
  if (/мкпп|механич|manual/.test(s)) return 'Механика';
  return null;
}

// Подходит ли товар магазина к системе по категории / названию
function productFitsSystem(p, key, kinds) {
  const name = String(p.name || '').toLowerCase();
  const cat = String(p.category || '').toLowerCase();
  switch (key) {
    case 'engine':   return cat === 'motor' || (!cat && viscIn(p.viscosity || p.name).length > 0 && !/atf|трансм/.test(name));
    case 'coolant':  return /антифриз|coolant|g1[1-3]/.test(name);
    case 'brake':    return /тормозн|dot ?[345]/.test(name);
    case 'steering': return /гидроусилит|гур|power steering/.test(name);
    case 'gearbox': {
      if (!(cat === 'transmission' || /atf|dexron|cvt|dsg|gl-?[45]|трансм/.test(name))) return false;
      if (kinds.has('Автомат') || kinds.has('Вариатор') || kinds.has('Робот')) {
        if (/atf|dexron|mercon|cvt|dsg|dct|акпп|вариатор/.test(name)) return true;
        if (!kinds.has('Механика')) return false;
      }
      return true;
    }
    case 'axle':     return !/atf|dexron|mercon|cvt|dsg|dct/.test(name) && (cat === 'transmission' || /gl-?[45]|трансм|редуктор|мост/.test(name));
    default:         return false;
  }
}

function buildSystems({ fill, approvals, items, products }) {
  const map = new Map(SYSTEMS.map(s => [s.key, { ...s, volumes: [], specs: [], approvals: [], items: [], viscosities: new Set(), kinds: new Set() }]));
  const touch = (key, text) => { const g = map.get(key); const k = gearboxKind(text); if (k && key === 'gearbox') g.kinds.add(k); return g; };

  for (const f of fill || []) {
    const g = touch(systemOf(f.title), `${f.title} ${f.info || ''}`);
    if (f.unit) g.volumes.push({ label: f.title, value: f.value_text, unit: f.unit });
    else g.specs.push(f.info ? `${f.info}${f.value_text ? ' ' + f.value_text : ''}` : f.value_text);
    viscIn(`${f.info || ''} ${f.value_text || ''}`).forEach(v => g.viscosities.add(v));
  }
  for (const a of approvals || []) {
    const g = touch(systemOf(a.fluid), a.fluid);
    if (a.kind === 'viscosity') { viscIn(a.approval).forEach(v => g.viscosities.add(v)); g.seen = true; continue; }
    if (!g.approvals.includes(a.approval)) g.approvals.push(a.approval);
    viscIn(a.approval).forEach(v => g.viscosities.add(v));
  }
  for (const o of items || []) {
    const g = touch(systemOf(o.fluid), `${o.fluid} ${o.spec_group}`);
    if (!g.items.some(i => i.spec_group === o.spec_group)) g.items.push({ spec_group: o.spec_group, brand: o.brand });
    viscIn(o.spec_group).forEach(v => g.viscosities.add(v));
  }

  const out = [];
  for (const g of map.values()) {
    if (!g.volumes.length && !g.specs.length && !g.approvals.length && !g.items.length && !g.seen) continue;
    const tokens = [...g.approvals, ...g.items.map(i => i.spec_group)].map(normSpec).filter(Boolean);
    const sysVisc = g.viscosities;
    const mine = (products || []).filter(p => productFitsSystem(p, g.key, g.kinds));
    const exact = [], byVisc = [], byType = [];
    for (const p of mine) {
      const pv = viscIn(p.viscosity || p.name)[0] || null;
      const matched = (p.approvals || []).filter(a => { const n = normSpec(a); return n.length >= 2 && tokens.some(t => t === n || (n.length >= 3 && t.includes(n))); });
      const viscOk = sysVisc.size === 0 || (pv && sysVisc.has(pv));
      const row = { id: p.id, name: p.name, volume: p.volume, viscosity: p.viscosity || null, price: Number(p.price), matched_approvals: matched };
      if (matched.length && viscOk) exact.push(row);
      else if (sysVisc.size && pv && sysVisc.has(pv)) byVisc.push(row);
      else if (matched.length && g.key !== 'engine') byType.push(row);   // допуск совпал, вязкость чуть другая (для трансмиссий допустимо) — только с пометкой «сверьте»
      else if (sysVisc.size === 0 && g.key !== 'engine') byType.push(row);
    }
    const rank = (a, b) => b.matched_approvals.length - a.matched_approvals.length || a.price - b.price;
    exact.sort(rank); byVisc.sort(rank); byType.sort(rank);
    out.push({
      key: g.key, title: g.title,
      kinds: [...g.kinds], volumes: g.volumes, specs: [...new Set(g.specs.filter(Boolean))],
      approvals: g.approvals, items: g.items.slice(0, 8),
      viscosities: [...sysVisc].map(v => v.replace(/W(\d)/, 'W-$1')),
      products: { exact: exact.slice(0, 6), by_viscosity: byVisc.slice(0, 6), by_type: byType.slice(0, 6) },
    });
  }
  return out.length ? out : fallbackSystems(products);
}

// В базе PartsAPI нет данных по этой машине: показываем, что есть в магазине по каждой системе.
// Совпадение с машиной НЕ утверждаем — только «есть в магазине», допуск и вязкость сверяет клиент.
function fallbackSystems(products) {
  const out = [];
  for (const s of SYSTEMS) {
    if (s.key === 'ac' || s.key === 'other') continue;
    const mine = (products || []).filter(p => productFitsSystem(p, s.key, new Set()))
      .map(p => ({ id: p.id, name: p.name, volume: p.volume, viscosity: p.viscosity || null, price: Number(p.price), matched_approvals: [] }))
      .sort((a, b) => a.price - b.price).slice(0, 6);
    if (!mine.length) continue;
    out.push({ key: s.key, title: s.title, no_data: true, kinds: [], volumes: [], specs: [], approvals: [], items: [], viscosities: [],
               products: { exact: [], by_viscosity: [], by_type: [], catalog: mine } });
  }
  return out;
}

module.exports = { buildSystems, systemOf };
