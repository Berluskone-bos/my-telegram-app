// Каталог товаров
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const Products = {
    data: [],
    categories: [],

    async load() {
        const API_BASE = window.location.hostname === 'localhost'
            ? 'http://localhost:3001'
            : 'https://gulf-bot-production.up.railway.app';

        try {
            const response = await fetch(`${API_BASE}/api/catalog`, { cache: 'no-store', headers: { Accept: 'application/json' } });
            if (response.ok) {
                const products = await response.json();
                if (Array.isArray(products) && products.length > 0) {
                    this.data = products.map(p => this.normalize(p));
                    this.categories = [
                        { id: 'motor', name: 'Моторные масла', icon: 'droplets' },
                        { id: 'transmission', name: 'Трансмиссионные масла', icon: 'cog' },
                        { id: 'filter', name: 'Фильтры', icon: 'filter' },
                        { id: 'fluid', name: 'Технические жидкости', icon: 'flask-conical' },
                        { id: 'additive', name: 'Присадки', icon: 'beaker' },
                        { id: 'special', name: 'Масла для спецтехники', icon: 'truck' }
                    ];
                    return;
                }
                console.warn('API каталога вернул пустой или некорректный список, используем резервный каталог');
            } else {
                console.warn(`API каталога: HTTP ${response.status}, используем резервный каталог`);
            }
        } catch (e) {
            console.warn('API недоступен, загружаем из catalog.json:', e.message);
        }

        try {
            const response = await fetch('data/catalog.json', { cache: 'no-store' });
            if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
            const catalog = await response.json();
            this.data = (Array.isArray(catalog.products) ? catalog.products : []).map(p => this.normalize(p));
            this.categories = Array.isArray(catalog.categories) ? catalog.categories : [];
        } catch (e) {
            console.error('Ошибка загрузки каталога:', e);
            this.data = [];
            this.categories = [];
        }
    },

    /** Поля из админки /api/catalog → единый вид для витрины */
    normalize(p) {
        let specs = p.specs;
        if (typeof specs === 'string') {
            try { specs = JSON.parse(specs); } catch (_) { specs = {}; }
        }
        if (!specs || typeof specs !== 'object') specs = {};
        const image = p.image || p.main_image || '';
        return {
            ...p,
            id: p.id,
            brand: p.brand || p.brand_name || 'Gulf Western Oil',
            category_id: p.category_id || p.category || '',
            category: p.category || p.category_id || '',
            name: p.name || '',
            full_name: p.full_name || p.name || '',
            series: p.series || '',
            sku: p.sku || '',
            viscosity: p.viscosity || '',
            oil_type: p.oil_type || '',
            volume: p.volume || '',
            api: p.api_std || p.api || '',
            acea: p.acea || '',
            ilsac: p.ilsac || '',
            price: Number(p.price) || 0,
            old_price: Number(p.old_price) || 0,
            main_image: image,
            image: image,
            description: p.description || '',
            specs,
            approvals: Array.isArray(p.approvals)
                ? p.approvals.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
                : [],
            is_new: !!p.is_new,
            is_popular: !!p.is_popular,
            coming_soon: !!p.coming_soon,
            in_stock: p.in_stock !== false,
            stock_left: p.stock_left != null ? p.stock_left : null,
            rating: Number(p.rating) || 0,
            reviews_count: Number(p.reviews_count) || 0
        };
    },

    getPictureHtml(imagePath, altText, extraAttrs = '') {
        const safePath = esc(imagePath);
        const safeAlt = esc(altText);
        const fallback = safePath.replace('/webp/', '/').replace('.webp', '.png');
        return `<picture>
            <source srcset="${safePath}" type="image/webp">
            <img src="${fallback}" alt="${safeAlt}" ${extraAttrs}>
        </picture>`;
    },

    getAll() {
        return this.data;
    },

    getById(id) {
        return this.data.find(p => p.id === id);
    },

    getByCategory(categoryId) {
        if (categoryId === 'all') return this.data;
        return this.data.filter(p => (p.category_id || p.category) === categoryId);
    },

    getBySubcategory(subcategoryId) {
        return this.data.filter(p => (p.subcategory || p.oil_type) === subcategoryId);
    },

    search(query) {
        const q = query.toLowerCase().trim();
        if (!q) return this.data;
        return this.data.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.full_name || '').toLowerCase().includes(q) ||
            (p.description || '').toLowerCase().includes(q) ||
            (p.viscosity && p.viscosity.toLowerCase().includes(q)) ||
            (p.sku && p.sku.toLowerCase().includes(q)) ||
            (p.series && p.series.toLowerCase().includes(q)) ||
            (p.api && p.api.toLowerCase().includes(q)) ||
            (p.specs && Object.values(p.specs).some(v => String(v).toLowerCase().includes(q)))
        );
    },

    sort(products, sortBy) {
        const sorted = [...products];
        switch (sortBy) {
            case 'price_asc':
                return sorted.sort((a, b) => a.price - b.price);
            case 'price_desc':
                return sorted.sort((a, b) => b.price - a.price);
            case 'rating':
                return sorted.sort((a, b) => b.rating - a.rating);
            case 'popular':
                return sorted.sort((a, b) => b.reviews_count - a.reviews_count);
            case 'new':
                return sorted.sort((a, b) => (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0));
            default:
                return sorted;
        }
    },

    getSubcategories(categoryId) {
        const products = this.getByCategory(categoryId);
        const subs = new Set(products.map(p => p.subcategory || p.oil_type).filter(Boolean));
        return [...subs];
    },

    getSubcategoryName(subId) {
        const names = {
            synthetic: 'Синтетика',
            semi_synthetic: 'Полусинтетика',
            mineral: 'Минеральное',
            diesel: 'Дизельное',
            atf: 'ATF',
            cvt: 'CVT',
            gear: 'Трансмиссионное',
            oil_filter: 'Масляные',
            air_filter: 'Воздушные',
            fuel_filter: 'Топливные',
            cabin_filter: 'Салона',
            engine_cleaner: 'Очистители',
            anti_wear: 'Защита',
            oil_stop: 'Течь',
            diesel_cleaner: 'Дизель',
            injector_cleaner: 'Форсунки',
            engine_flush: 'Промывка',
            fuel_cleaner: 'Топливо',
            cooling_flush: 'Охлаждение',
            psf: 'ГУР',
            washer: 'Омыватель',
            ready: 'Готовый',
            concentrate: 'Концентрат',
            dot4: 'DOT 4',
            dot5: 'DOT 5.1'
        };
        return names[subId] || subId;
    },

    renderCard(product, isFavorite) {
        const discount = product.old_price > 0
            ? Math.round((1 - product.price / product.old_price) * 100)
            : 0;
        const image = product.main_image || product.image;
        const brand = product.brand || product.brand_name || 'Gulf Western Oil';
        const viscosity = product.viscosity || '';
        const volume = product.volume || '';
        const approvalSource = Array.isArray(product.approvals) && product.approvals.length
            ? product.approvals
            : [product.api, product.acea, product.ilsac].filter(Boolean);
        const approvals = [...new Map(approvalSource
            .map(value => String(value).trim())
            .filter(Boolean)
            .map(value => [value.toLowerCase(), value])).values()];
        const approvalChips = approvals.slice(0, 2).map(value =>
            `<span class="product-approval-chip" title="${esc(value)}">${esc(value)}</span>`
        ).join('');
        const approvalMore = approvals.length > 2
            ? `<span class="product-approval-more" aria-label="Ещё ${approvals.length - 2} допуска">+${approvals.length - 2}</span>`
            : '';
        const approvalsHtml = approvals.length
            ? `<div class="product-approvals" role="group" aria-label="Основные допуски: ${esc(approvals.join(', '))}">${approvalChips}${approvalMore}</div>`
            : '';

        return `
            <article class="product-card ${product.coming_soon ? 'coming-soon' : (product.in_stock === false ? 'out-of-stock' : '')}" data-product-id="${product.id}" tabindex="0" aria-label="Открыть товар: ${esc(product.name)}" onclick="App.showProduct(${product.id})" onkeydown="if (event.target === this && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); App.showProduct(${product.id}); }">
                <div class="product-image">
                    ${this.getPictureHtml(image, product.name, 'loading="lazy"')}
                    <div class="product-badges">
                        ${product.is_new ? '<span class="badge-new">NEW</span>' : ''}
                        ${discount > 0 ? `<span class="badge-sale">-${discount}%</span>` : ''}
                    </div>
                    <button type="button" class="favorite-btn ${isFavorite ? 'active' : ''}"
                            onclick="event.stopPropagation(); App.toggleFavorite(${product.id})"
                            aria-label="${isFavorite ? 'Убрать из избранного: ' + esc(product.name) : 'Добавить в избранное: ' + esc(product.name)}"
                            aria-pressed="${isFavorite ? 'true' : 'false'}">
                        <i data-lucide="heart"></i>
                    </button>
                </div>
                <div class="product-info">
                    <div class="product-brand">${esc(brand)}</div>
                    ${viscosity ? `<div class="product-viscosity">${esc(viscosity)}</div>` : ''}
                    <button type="button" class="product-title-button" aria-label="Подробнее о товаре: ${esc(product.name)}"><span class="product-title">${esc(product.name)}</span></button>
                    ${approvalsHtml}
                    <div class="product-meta-row">
                        ${volume ? `<span class="product-volume">${esc(volume)}</span>` : '<span class="product-volume"></span>'}
                        ${product.coming_soon
                            ? '<span class="product-soon">Скоро</span>'
                            : product.in_stock === false
                                ? '<span class="product-soon">Нет в наличии</span>'
                                : ''}
                    </div>
                    <div class="product-footer">
                        <div class="product-price-row">
                            ${product.coming_soon
                                ? '<span class="product-soon">Скоро в продаже</span>'
                                : `<span class="product-price">${product.price.toLocaleString('ru-RU')} ₽</span>
                            ${product.old_price > 0 ? `<span class="product-old-price">${product.old_price.toLocaleString('ru-RU')} ₽</span>` : ''}`}
                        </div>
                        ${(product.coming_soon || product.in_stock === false) ? '' : `<button type="button" class="btn-buy" data-product-id="${product.id}" aria-label="Добавить ${esc(product.name)} в корзину" onclick="event.stopPropagation(); App.addToCart(${product.id})">
                            <i data-lucide="shopping-cart"></i>
                        </button>`}
                    </div>
                </div>
            </article>
        `;
    },

    renderDetail(product) {
        const image = product.main_image || product.image;
        const desc = (product.description || '').trim();
        const inCart = Cart.items.some(i => i.id === product.id);
        const isFavorite = Favorites.has(product.id);

        // Один список характеристик без дублей (Характеристики + specs)
        const rows = [];
        const seen = new Set();
        const add = (key, val) => {
            const v = String(val ?? '').trim();
            if (!v) return;
            const k = String(key).trim();
            const sig = k.toLowerCase() + '|' + v.toLowerCase();
            if (seen.has(sig)) return;
            // не дублируем API/тип, если уже есть такая же строка по смыслу
            const keyL = k.toLowerCase();
            if ((keyL === 'api' || keyL === 'acea' || keyL === 'sae' || keyL === 'тип') &&
                [...seen].some(s => s.endsWith('|' + v.toLowerCase()))) return;
            seen.add(sig);
            rows.push({ key: k, val: v });
        };

        if (product.volume) add('Объём', product.volume);
        if (product.oil_type) add('Тип масла', product.oil_type);
        // Список из product_approvals — источник полного набора, введённого в админке.
        // Старые поля API/ACEA/ILSAC оставляем запасным вариантом для товаров без списка.
        const approvalValues = Array.isArray(product.approvals) && product.approvals.length
            ? product.approvals
            : [product.api, product.acea, product.ilsac].filter(Boolean);
        const uniqueApprovals = [...new Map(approvalValues
            .map(value => String(value).trim())
            .filter(Boolean)
            .map(value => [value.toLowerCase(), value])).values()];
        if (product.sku) add('Артикул', product.sku);
        if (product.series) add('Серия', product.series);

        let specs = product.specs;
        if (typeof specs === 'string') {
            try { specs = JSON.parse(specs); } catch (_) { specs = {}; }
        }
        if (specs && typeof specs === 'object') {
            for (const [k, v] of Object.entries(specs)) {
                const kl = String(k).toLowerCase();
                // SAE часто = вязкость — не повторяем, если совпадает
                if (kl === 'sae' && product.viscosity && String(v).toLowerCase() === String(product.viscosity).toLowerCase()) continue;
                if (kl === 'api' && product.api && String(v).toLowerCase() === String(product.api).toLowerCase()) continue;
                if ((kl === 'тип' || kl === 'тип масла') && product.oil_type && String(v).toLowerCase() === String(product.oil_type).toLowerCase()) continue;
                add(k, v);
            }
        }

        const rowsHtml = rows.length
            ? rows.map(({ key, val }) =>
                `<div class="spec-row">
                    <span class="spec-label">${esc(key)}</span>
                    <span class="spec-value">${esc(val)}</span>
                </div>`).join('')
            : '';

        const stockHtml = product.coming_soon
            ? '<span class="product-stock soon">Скоро в продаже</span>'
            : product.in_stock === false
                ? '<span class="product-stock out">Нет в наличии</span>'
                : product.stock_left
                    ? `<span class="product-stock ok">В наличии · осталось ${esc(product.stock_left)} шт.</span>`
                    : '<span class="product-stock ok">В наличии</span>';

        const chips = product.volume
            ? `<span class="spec-chip"><span class="spec-chip-label">Объём</span>${esc(product.volume)}</span>`
            : '';
        const approvalsHtml = uniqueApprovals.length
            ? `<section class="product-detail-section product-detail-approvals" aria-labelledby="productApprovalsTitle">
                <h3 id="productApprovalsTitle">Допуски и одобрения</h3>
                <div class="product-approval-list">${uniqueApprovals.map(value =>
                    `<span class="product-detail-approval">${esc(value)}</span>`
                ).join('')}</div>
            </section>`
            : '';
        const specsHtml = rows.length
            ? `<section class="product-detail-section product-detail-specs" aria-labelledby="productSpecsTitle">
                <h3 id="productSpecsTitle">Характеристики</h3>
                ${rowsHtml}
            </section>`
            : '';
        const descriptionHtml = desc
            ? `<section class="product-detail-section product-detail-description" aria-labelledby="productDescriptionTitle">
                <h3 id="productDescriptionTitle">О товаре</h3><p>${esc(desc)}</p>
            </section>`
            : '';

        return `
            <div class="product-detail">
                <div class="product-detail-top">
                    <button type="button" class="btn-back" onclick="App.goBack()" aria-label="Назад">←</button>
                    <button type="button" class="product-detail-fav ${isFavorite ? 'active' : ''}"
                        onclick="App.toggleFavorite(${product.id}); this.classList.toggle('active'); this.setAttribute('aria-pressed', String(this.classList.contains('active')));"
                        aria-label="${isFavorite ? 'Убрать из избранного: ' + esc(product.name) : 'Добавить в избранное: ' + esc(product.name)}"
                        aria-pressed="${isFavorite ? 'true' : 'false'}"><i data-lucide="heart"></i></button>
                </div>
                <div class="product-detail-image">
                    ${this.getPictureHtml(image, product.name)}
                </div>
                <div class="product-detail-body">
                    <div class="product-detail-brand">${esc(product.brand || 'Gulf Western Oil')}</div>
                    <div class="product-detail-heading-row">
                        <div class="product-detail-heading-copy">
                            <div class="product-detail-name">${esc(product.name || product.full_name || '')}</div>
                            ${product.viscosity ? `<div class="product-detail-viscosity">${esc(product.viscosity)}</div>` : ''}
                        </div>
                        <div class="product-detail-brand-marks" aria-label="Логотип Gulf Western Oil">
                            <img class="product-detail-gulf-logo" src="img/GulfWesternOil_Logo%20%281%29.png" alt="Gulf Western Oil" loading="lazy" decoding="async">
                        </div>
                    </div>
                    ${chips ? `<div class="product-detail-chips">${chips}</div>` : ''}
                    <section class="product-detail-purchase" aria-label="Цена и наличие">
                        <div class="product-detail-price-row">
                            <div class="product-detail-price-main">
                                ${product.coming_soon
                                    ? '<div class="product-soon">Скоро в продаже</div>'
                                    : `<div class="product-detail-price">${product.price.toLocaleString('ru-RU')} ₽</div>`}
                                ${product.old_price > 0 ? `<div class="product-detail-old-price">${product.old_price.toLocaleString('ru-RU')} ₽</div>` : ''}
                            </div>
                            ${stockHtml}
                        </div>
                        ${product.coming_soon
                            ? '<button type="button" class="btn-add-cart" disabled>Скоро в продаже</button>'
                            : product.in_stock === false
                            ? '<button type="button" class="btn-add-cart" disabled>Нет в наличии</button>'
                            : `<button type="button" class="btn-add-cart ${inCart ? 'in-cart' : ''}" aria-label="${inCart ? 'Товар уже в корзине: ' : 'Добавить в корзину: '}${esc(product.name)}" onclick="App.addToCart(${product.id})">${inCart ? 'В корзине' : 'Добавить в корзину'}</button>`}
                        <button type="button" class="btn-oil-link" onclick="Oil.open()">Подобрать для своего авто</button>
                    </section>
                    ${approvalsHtml}
                    ${specsHtml}
                    ${descriptionHtml}
                </div>
            </div>
        `;
    }
};