// Каталог товаров
const Products = {
    data: [],
    categories: [],

    async load() {
        try {
            const response = await fetch('data/catalog.json');
            const catalog = await response.json();
            this.data = catalog.products;
            this.categories = catalog.categories;
        } catch (e) {
            console.error('Ошибка загрузки каталога:', e);
            this.data = [];
            this.categories = [];
        }
    },

    getAll() {
        return this.data;
    },

    getById(id) {
        return this.data.find(p => p.id === id);
    },

    getByCategory(categoryId) {
        if (categoryId === 'all') return this.data;
        return this.data.filter(p => p.category === categoryId);
    },

    getBySubcategory(subcategoryId) {
        return this.data.filter(p => p.subcategory === subcategoryId);
    },

    search(query) {
        const q = query.toLowerCase().trim();
        if (!q) return this.data;
        return this.data.filter(p =>
            p.name.toLowerCase().includes(q) ||
            p.full_name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            (p.viscosity && p.viscosity.toLowerCase().includes(q)) ||
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
        const subs = new Set(products.map(p => p.subcategory));
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

        return `
            <div class="product-card" onclick="App.showProduct(${product.id})">
                <div class="product-image">
                    <img src="${product.image}" alt="${product.name}"
                         onerror="this.style.display='none'; this.parentElement.innerHTML+='<span style=\\'font-size:48px;opacity:0.3;color:#999\\'>[фото]</span>';">
                    <div class="product-badges">
                        ${product.is_new ? '<span class="badge-new">NEW</span>' : ''}
                        ${discount > 0 ? `<span class="badge-sale">-${discount}%</span>` : ''}
                    </div>
                    <button class="favorite-btn ${isFavorite ? 'active' : ''}"
                            onclick="event.stopPropagation(); App.toggleFavorite(${product.id})">
                        <i data-lucide="heart"></i>
                    </button>
                </div>
                <div class="product-info">
                    <div class="product-title">${product.name}</div>
                    <div class="product-volume">${product.volume || '&nbsp;'}</div>
                    <button class="btn-buy" onclick="event.stopPropagation(); App.addToCart(${product.id})">
                        <i data-lucide="shopping-bag"></i>
                    </button>
                    <div class="product-price-row">
                        <span class="product-price">${product.price.toLocaleString()} ₽</span>
                        ${product.old_price > 0 ? `<span class="product-old-price">${product.old_price.toLocaleString()} ₽</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    },

    renderDetail(product) {
        const specsHtml = product.specs
            ? Object.entries(product.specs).map(([key, val]) =>
                `<div class="spec-row"><span class="spec-label">${key}</span><span class="spec-value">${val}</span></div>`
              ).join('')
            : '';

        return `
            <div class="product-detail">
                <button class="btn-back" onclick="App.goBack()">← Назад</button>
                <div class="product-detail-image">
                    <img src="${product.image}" alt="${product.name}"
                         onerror="this.style.display='none'; this.parentElement.innerHTML+='<span style=\\'font-size:24px;opacity:0.3;color:#999\\'>[фото товара]</span>';">
                </div>
                <div class="product-detail-name">${product.full_name}</div>
                <div class="product-detail-volume">${product.volume}${product.viscosity ? ' · ' + product.viscosity : ''}</div>
                <div class="product-detail-price-row">
                    <div class="product-detail-price">${product.price.toLocaleString()} ₽</div>
                    ${product.old_price > 0 ? `<div class="product-detail-old-price">${product.old_price.toLocaleString()} ₽</div>` : ''}
                </div>
                <div class="product-detail-description">${product.description}</div>
                ${specsHtml ? `<div class="product-detail-specs"><h3>Характеристики</h3>${specsHtml}</div>` : ''}
                <button class="btn-add-cart" onclick="App.addToCart(${product.id})">Добавить в корзину</button>
                <button class="btn-select-oil" onclick="App.goBack()">
                    <i data-lucide="search" style="width:16px;height:16px;"></i> Подобрать масло
                </button>
            </div>
        `;
    }
};
