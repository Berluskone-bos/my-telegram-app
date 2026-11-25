// Каталог товаров
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const Products = {
    data: [],
    categories: [],
    loadState: 'loading',
    loadError: null,

    async load() {
        this.loadState = 'loading';
        this.loadError = null;
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
                    this.loadState = 'ready';
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
            this.loadState = this.data.length > 0 ? 'ready' : 'empty';
        } catch (e) {
            console.error('Ошибка загрузки каталога:', e);
            this.data = [];
            this.categories = [];
            this.loadState = 'error';
            this.loadError = e;
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
            <article class="product-card
                        <button type="button" class="btn-oil-link" onclick="Oil.open()">Подобрать для своего авто</button>
                    </section>
                    ${approvalsHtml}
                    ${specsHtml}
                    ${descriptionHtml}
                </div>
                <aside class="product-detail-sticky-purchase" aria-label="Быстрая покупка">
                    <span class="product-detail-sticky-price">${stickyPrice}</span>
                    ${stickyButton}
                </aside>
            </div>
        `;
    }
};