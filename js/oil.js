// Подбор масла по VIN или по марке/модели. Данные приходят с нашего сервера (кэш PartsAPI в БД).
const OIL_API = window.location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://gulf-bot-production.up.railway.app';

const Oil = {
    root: null, tab: 'vin',

    open() {
        if (!this.root) {
            this.root = document.createElement('div');
            this.root.className = 'oil-overlay';
            this.root.innerHTML = `
              <div class="oil-sheet" role="dialog" aria-modal="true" aria-label="Подбор масла">
                <div class="oil-head"><div class="oil-title">Подбор масла</div><button class="oil-close" aria-label="Закрыть" onclick="Oil.close()">&times;</button></div>
                <div class="oil-tabs">
                  <button class="oil-tab active" data-tab="vin" onclick="Oil.setTab('vin')">По VIN</button>
                  <button class="oil-tab" data-tab="car" onclick="Oil.setTab('car')">По марке и модели</button>
                </div>
                <div class="oil-pane" id="oilPaneVin">
                  <label class="oil-label" for="oilVin">VIN-код (17 символов)</label>
                  <input id="oilVin" class="oil-input" maxlength="17" autocomplete="off" autocapitalize="characters" placeholder="например, WAUBH54B11N111054">
                  <p class="oil-hint">VIN указан в СТС и на кузове. Только латиница и цифры, без букв I, O, Q.</p>
                  <button class="oil-btn" onclick="Oil.byVin()">Подобрать масло</button>
                </div>
                <div class="oil-pane" id="oilPaneCar" hidden>
                  <label class="oil-label" for="oilMake">Марка</label><select id="oilMake" class="oil-input" onchange="Oil.loadModels()"><option value="">Выберите марку</option></select>
                  <label class="oil-label" for="oilModel">Модель</label><select id="oilModel" class="oil-input" onchange="Oil.loadCars()" disabled><option value="">Сначала марку</option></select>
                  <label class="oil-label" for="oilCar">Модификация</label><select id="oilCar" class="oil-input" disabled><option value="">Сначала модель</option></select>
                  <button class="oil-btn" onclick="Oil.byCar()">Подобрать масло</button>
                </div>
                <div id="oilResult" class="oil-result" aria-live="polite"></div>
              </div>`;
            document.body.appendChild(this.root);
            this.root.addEventListener('click', e => { if (e.target === this.root) this.close(); });
        }
        this.root.classList.add('open');
        document.body.style.overflow = 'hidden';
    },

    close() { if (this.root) this.root.classList.remove('open'); document.body.style.overflow = ''; },

    setTab(t) {
        this.tab = t;
        this.root.querySelectorAll('.oil-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
        document.getElementById('oilPaneVin').hidden = t !== 'vin';
        document.getElementById('oilPaneCar').hidden = t !== 'car';
        document.getElementById('oilResult').innerHTML = '';
        if (t === 'car' && document.getElementById('oilMake').options.length < 2) this._makes = this.loadMakes();
    },

    async api(path) {
        const r = await fetch(`${OIL_API}${path}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const err = new Error(j.error || 'Сервис подбора временно недоступен. Попробуйте позже.'); err.notFound = r.status === 404; throw err; }
        return j;
    },

    busy(msg) { document.getElementById('oilResult').innerHTML = `<p class="oil-note">${esc(msg)}</p>`; },
    fail(e) { document.getElementById('oilResult').innerHTML = `<p class="oil-error">${esc(e.message)}</p>`; },

    fill(sel, items, valueKey, labelKey, placeholder) {
        sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
            items.map(i => `<option value="${esc(i[valueKey])}">${esc(i[labelKey])}</option>`).join('');
        sel.disabled = false;
    },

    async loadMakes() {
        try {
            this.busy('Загружаем марки…');
            const list = await this.api('/api/oil/makes');
            const popular = ['TOYOTA','HYUNDAI','KIA','VOLKSWAGEN','SKODA','BMW','MERCEDES-BENZ','AUDI','NISSAN','MAZDA','LADA','RENAULT','FORD','CHEVROLET','HONDA','MITSUBISHI','LEXUS','SUBARU','OPEL','VOLVO'];
            const sorted = [...list].sort((a, b) => {
                const pa = popular.indexOf(String(a.makeName).toUpperCase()), pb = popular.indexOf(String(b.makeName).toUpperCase());
                return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb) || String(a.makeName).localeCompare(String(b.makeName));
            });
            this.fill(document.getElementById('oilMake'), sorted, 'makeId', 'makeName', 'Выберите марку');
            document.getElementById('oilResult').innerHTML = '';
        } catch (e) { this.fail(e); }
    },

    async loadModels() {
        const make = document.getElementById('oilMake').value;
        const mSel = document.getElementById('oilModel'), cSel = document.getElementById('oilCar');
        cSel.innerHTML = '<option value="">Сначала модель</option>'; cSel.disabled = true;
        if (!make) { mSel.innerHTML = '<option value="">Сначала марку</option>'; mSel.disabled = true; return; }
        try {
            this.busy('Загружаем модели…');
            const list = await this.api(`/api/oil/models?make_id=${encodeURIComponent(make)}`);
            this.fill(mSel, list.map(m => ({ modelId: m.modelId, label: m.modelName || '' })).filter(m => m.modelId && m.label).sort((a, b) => a.label.localeCompare(b.label)),
                      'modelId', 'label', 'Выберите модель');
            document.getElementById('oilResult').innerHTML = '';
        } catch (e) { this.fail(e); }
    },

    async loadCars() {
        const make = document.getElementById('oilMake'), model = document.getElementById('oilModel'), cSel = document.getElementById('oilCar');
        if (!model.value) { cSel.innerHTML = '<option value="">Сначала модель</option>'; cSel.disabled = true; return; }
        try {
            this.busy('Загружаем модификации…');
            const list = await this.api(`/api/oil/cars?model_id=${encodeURIComponent(model.value)}`);
            const rows = list.map(c => ({ id: c.CAR_ID, label: c.CAR_NAME }));
            this.fill(cSel, rows, 'id', 'label', rows.length ? 'Выберите модификацию' : 'Модификации не найдены');
            document.getElementById('oilResult').innerHTML = '';
        } catch (e) { this.fail(e); }
    },

    async byVin() {
        const vin = document.getElementById('oilVin').value.trim().toUpperCase();
        document.getElementById('oilVin').value = vin;
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return this.fail(new Error('VIN должен состоять из 17 символов: латиница и цифры, без букв I, O, Q.'));
        try { this.busy('Определяем марку…'); const r = await this.api(`/api/oil/by-vin?vin=${encodeURIComponent(vin)}`); r.needs_pick ? this.vinPick(r) : this.show(r); }
        catch (e) { e.notFound ? this.vinNotFound(vin, e.message) : this.fail(e); }
    },

    async byCar() {
        const id = document.getElementById('oilCar').value;
        if (!id) return this.fail(new Error('Выберите марку, модель и модификацию.'));
        try { this.busy('Подбираем масло…'); this.show(await this.api(`/api/oil/by-car?car_id=${encodeURIComponent(id)}`)); } catch (e) { this.fail(e); }
    },

    prod(p, note) {
        return `<div class="oil-prod"><div class="oil-prod-info"><div class="oil-prod-name">${esc(p.name)}</div>
              <div class="oil-prod-meta">${esc(p.volume || '')}${p.matched_approvals && p.matched_approvals.length ? ' · допуски: ' + esc(p.matched_approvals.slice(0, 3).join(', ')) : ''}</div></div>
              <div class="oil-prod-buy"><b>${Number(p.price).toLocaleString('ru-RU')} ₽</b>
              <button class="oil-add" onclick="App.addToCart(${Number(p.id)}); this.textContent='В корзине'">В корзину</button></div></div>`;
    },

    system(s) {
        const p = s.products || {};
        const kinds = (s.kinds || []).length ? ` · ${esc(s.kinds.join(', '))}` : '';
        const group = (list, title) => list && list.length ? `<div class="oil-group">${esc(title)}</div>${list.map(x => this.prod(x)).join('')}` : '';
        const any = (p.exact || []).length + (p.by_viscosity || []).length + (p.by_type || []).length + (p.catalog || []).length;
        return `<section class="oil-sys">
            <div class="oil-sys-title">${esc(s.title)}<span>${kinds}</span></div>
            ${(s.volumes || []).length ? `<div class="oil-chips">${s.volumes.map(v => `<span class="oil-chip"><i>${esc(v.label)}</i> <b>${esc(v.value)} ${esc(v.unit)}</b></span>`).join('')}</div>` : ''}
            ${(s.viscosities || []).length ? `<div class="oil-line"><span>Вязкость</span><b>${s.viscosities.map(esc).join(', ')}</b></div>` : ''}
            ${(s.specs || []).length ? `<div class="oil-line"><span>Спецификация</span><b>${s.specs.map(esc).join(', ')}</b></div>` : ''}
            ${(s.approvals || []).length ? `<div class="oil-line"><span>Допуски</span><b>${s.approvals.map(esc).join(', ')}</b></div>` : ''}
            ${(s.items || []).length ? `<div class="oil-line"><span>Рекомендует производитель</span><b>${s.items.map(i => esc(i.spec_group)).join('; ')}</b></div>` : ''}
            ${group(p.catalog, 'Есть в магазине — допуск и вязкость сверьте с руководством')}
            ${group(p.exact, 'Подходит по допуску')}
            ${group(p.by_viscosity, 'Подходит по вязкости — сверьте допуск с руководством')}
            ${group(p.by_type, 'Подходит по типу — сверьте допуск с руководством')}
            ${any ? '' : '<p class="oil-note">В каталоге такой жидкости пока нет. Напишите нам, и мы подберём вручную.</p>'}
        </section>`;
    },

    show(r) {
        const v = r.vehicle, el = document.getElementById('oilResult');
        let model = String(v.model_name || '');
        const mod = String(v.modification || '');
        if (mod && model.endsWith(mod)) model = model.slice(0, -mod.length).trim();   // модификация уже в названии
        const name = model.toUpperCase().startsWith(String(v.make_name || '').toUpperCase()) ? model : `${v.make_name} ${model}`;
        const years = [v.year_from, v.year_to].filter(Boolean).map(s => s.slice(0, 4)).join('–') + (v.year_from && !v.year_to ? '–н.в.' : '');
        el.innerHTML = `
          <div class="oil-car"><div class="oil-car-name">${esc(name)}</div>
            <div class="oil-car-sub">${esc(v.modification || '')}${years ? ' · ' + esc(years) : ''}</div></div>
          ${r.vin_info ? `<div class="oil-vin">Определено по VIN: <b>${esc(r.vin_info.matched)}</b>. Если модификация не ваша, <a href="#" onclick="Oil.toManual('${esc(r.vin_info.make)}');return false">выберите вручную</a>.</div>` : ''}
          ${r.no_data ? `<div class="oil-nodata"><b>Для этой модификации в базе нет объёмов и допусков.</b><br>Сколько и что заливать, уточните в руководстве по эксплуатации или напишите нам — подберём вручную. Ниже — что есть в магазине.</div>` : ''}
          ${(r.systems || []).length ? r.systems.map(s => this.system(s)).join('') : '<p class="oil-note">Для этой модификации данных о жидкостях нет. Напишите нам, и мы подберём вручную.</p>'}
          ${r.no_data && r.diagnostics ? this.diag(r.diagnostics) : ''}
          <p class="oil-disclaimer">Подбор справочный: спецификации могут меняться. Перед покупкой сверьтесь с руководством по эксплуатации автомобиля.</p>`;
    },

    diag(d) {
        const row = x => `${esc(x.method)}: ${esc(x.state)}${x.shape ? ' (' + esc(x.shape) + ')' : ''}`;
        return `<p class="oil-diag">Справка для поддержки: машина № ${esc(d.car_id)}. ${row(d.fill)}; ${row(d.dopusk)}.</p>`;
    },

    // Если VIN не найден: определяем марку по коду производителя и переходим к ручному выбору
    WMI: { Z94: 'HYUNDAI', KMH: 'HYUNDAI', XWE: 'KIA', KNA: 'KIA', KND: 'KIA', Z8N: 'NISSAN', JN1: 'NISSAN', XTA: 'LADA', X7L: 'RENAULT', VF1: 'RENAULT',
           XW8: 'VOLKSWAGEN', WVW: 'VOLKSWAGEN', TMB: 'SKODA', WAU: 'AUDI', WBA: 'BMW', WBS: 'BMW', WDB: 'MERCEDES-BENZ', WDD: 'MERCEDES-BENZ', Z6F: 'FORD',
           JTD: 'TOYOTA', JTM: 'TOYOTA', JTN: 'TOYOTA', JHM: 'HONDA', JMZ: 'MAZDA' },

    async vinNotFound(vin, message) {
        const make = this.WMI[vin.slice(0, 3)];
        document.getElementById('oilResult').innerHTML = `<p class="oil-error">${esc(message)}</p>
            <button class="oil-btn oil-btn-light" onclick="Oil.toManual('${esc(make || '')}')">Выбрать по марке и модели${make ? ' (' + esc(make) + ')' : ''}</button>`;
    },

    // VIN распознан, но модификацию однозначно определить не удалось: даём выбрать
    async vinPick(r) {
        const head = `<div class="oil-nodata"><b>${esc(r.make_name)} ${esc(r.model_name)}${r.type_name ? ' ' + esc(r.type_name) : ''}${r.year ? ', ' + esc(r.year) + ' г.' : ''}</b><br>`;
        if (r.candidates && r.candidates.length) {
            document.getElementById('oilResult').innerHTML = head + `${r.exact ? 'Подходит несколько модификаций. Выберите вашу:' : 'Точную модификацию определить не удалось. Выберите вашу:'}</div>` +
                r.candidates.map(c => `<button class="oil-btn oil-btn-light oil-pick" onclick="Oil.pickType(${Number(c.id)})">${esc(c.label)}</button>`).join('');
            return;
        }
        document.getElementById('oilResult').innerHTML = head + 'Выберите модель и модификацию из списка — так подбор будет точным.</div>' +
            `<button class="oil-btn oil-btn-light" onclick="Oil.toManual('${esc(r.make_name)}')">Выбрать модель и модификацию</button>`;
    },

    async pickType(id) {
        try { this.busy('Подбираем жидкости…'); this.show(await this.api(`/api/oil/by-car?car_id=${encodeURIComponent(id)}`)); } catch (e) { this.fail(e); }
    },

    async toManual(make) {
        this.setTab('car');
        if (this._makes) await this._makes;
        if (make) {
            const sel = document.getElementById('oilMake');
            const opt = [...sel.options].find(o => o.text.toUpperCase() === String(make).toUpperCase());
            if (opt) { sel.value = opt.value; await this.loadModels(); }
        }
    }
};

// Кнопки «Подобрать масло» на главной (в старом и новом оформлении)
document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('.select-oil-banner, .hero-cta');
    if (t) { e.preventDefault(); e.stopPropagation(); Oil.open(); }
}, true);
