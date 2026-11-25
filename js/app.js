// esc() объявлена в products.js (грузится первой)

// Главный модуль приложения
var App = {
    currentScreen: 'main',
    currentCategory: 'all',
    currentSubcategory: null,
    currentSort: 'popular',
    searchQuery: '',
    previousScreen: null,
    filters: {
        brand: [],
        viscosity: [],
        volume: [],
        type: [],
        priceMin: null,
        priceMax: null
    },

    async init() {
        // Сразу показываем состояние загрузки, пока получаем каталог.
        this.renderProducts();
        // Загружаем данные
        await Products.load();
        Cart.load();
        Favorites.load();
        Profile.load();

        // Инициализация Telegram
        const tg = TelegramApp.init();
        await Profile.loadFromServer(tg);
        Profile.updateProfileUI();
        Profile.syncOrders();   // история заказов с сервера (без ожидания)
        Profile.syncLoyalty();  // скидка клиента с сервера
        Profile.syncBonuses();  // бонусный баланс и реферальный код с сервера

        const user = TelegramApp.getUser(tg);
        const userName = TelegramApp.getUserName(user);
        const userInitial = TelegramApp.getUserInitial(user);

        document.getElementById('userName').innerText = userName;
        document.getElementById('userAvatar').innerText = userInitial;

        // Рендерим главную
        this.renderProducts();
        this.updateCartBadge();

        // Обработчики событий
        this.bindEvents();
    },

    bindEvents() {
        // Закрытие dropdown при клике вне
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#sortDropdown')) {
                document.getElementById('sortMenu').classList.remove('open');
                document.getElementById('sortToggle')?.setAttribute('aria-expanded', 'false');
            }
            if (!e.target.closest('#zoneSelect')) {
                const zoneMenu = document.getElementById('zoneMenu');
                if (zoneMenu) {
                    zoneMenu.classList.remove('open');
                    document.getElementById('zoneSelectToggle')?.setAttribute('aria-expanded', 'false');
                }
            }
        });

        // Поиск
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                this.renderProducts();
            });
        }

        // Telegram Web (особенно desktop WebView) может не доставлять click так же,
        // как обычный браузер. Поэтому открываем карточку на pointerup внутри сетки,
        // а click оставляем резервным способом для клавиатуры и старых браузеров.
        const productGrid = document.getElementById('productGrid');
        const getCardFromEvent = (event) => {
            const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
            return target?.closest?.('.product-card') || null;
        };
        const isCardAction = (event) => {
            const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
            return !!target?.closest?.('.favorite-btn, .btn-buy, a, input, select, textarea, label');
        };
        const openProductFromEvent = (event) => {
            const card = getCardFromEvent(event);
            if (!card || isCardAction(event)) return false;
            const productId = Number(card.getAttribute('data-product-id'));
            if (!Number.isInteger(productId) || productId <= 0) return false;
            event.preventDefault();
            this.showProduct(productId);
            return true;
        };

        // Основной путь для мыши, пера и сенсорного ввода.
        productGrid?.addEventListener('pointerup', (event) => {
            if (event.isPrimary === false || (typeof event.button === 'number' && event.button !== 0)) return;
            if (openProductFromEvent(event)) this._productPointerOpenedAt = Date.now();
        }, true);

        // Резервный click: клавиатурная активация и окружения без Pointer Events.
        document.addEventListener('click', (event) => {
            if (this._productPointerOpenedAt && Date.now() - this._productPointerOpenedAt < 800) return;
            openProductFromEvent(event);
        }, true);

        // Делегирование: категории, товары, фильтры, нижняя навигация
        document.addEventListener('click', (e) => {
            // Категория
            const cat = e.target.closest('.cat-badge');
            if (cat) {
                e.preventDefault();
                this.selectCategory(cat.dataset.cat);
                return;
            }
            // Покупка обрабатывается раньше клика по карточке.
            const btnBuy = e.target.closest('.btn-buy');
            if (btnBuy) {
                const pid = btnBuy.dataset.productId;
                if (pid) this.addToCart(Number(pid));
                e.preventDefault();
                return;
            }
            // Подкатегория: единый делегированный обработчик для динамического списка.
            const chip = e.target.closest('#subcategoriesRow .filter-chip[data-sub]');
            if (chip) {
                e.preventDefault();
                const container = chip.closest('#subcategoriesRow');
                container.querySelectorAll('.filter-chip').forEach(item => {
                    const active = item === chip;
                    item.classList.toggle('active', active);
                    item.setAttribute('aria-pressed', String(active));
                });
                this.currentSubcategory = chip.dataset.sub === 'all' ? null : chip.dataset.sub;
                this.renderProducts();
                return;
            }
            // Нижняя навигация
            const nav = e.target.closest('.nav-item');
            if (nav) {
                e.preventDefault();
                const screen = nav.getAttribute('data-screen');
                if (screen) this.switchScreen(screen);
                return;
            }
        });
    },

    toggleSort() {
        const menu = document.getElementById('sortMenu');
        const isOpen = menu.classList.toggle('open');
        document.getElementById('sortToggle')?.setAttribute('aria-expanded', String(isOpen));
    },

    selectSort(value) {
        this.currentSort = value;
        document.querySelectorAll('#sortMenu .sort-option').forEach(opt => {
            const active = opt.dataset.value === value;
            opt.classList.toggle('active', active);
            opt.setAttribute('aria-pressed', String(active));
        });
        document.getElementById('sortMenu').classList.remove('open');
        document.getElementById('sortToggle')?.setAttribute('aria-expanded', 'false');
        this.renderProducts();
    },

    toggleFilter() {
        const panel = document.getElementById('filterPanel');
        const overlay = document.getElementById('filterOverlay');
        const isOpen = panel.classList.contains('open');

        if (isOpen) {
            panel.classList.remove('open');
            overlay.classList.remove('open');
        } else {
            this.renderFilterOptions();
            panel.classList.add('open');
            overlay.classList.add('open');
        }
    },

    renderFilterOptions() {
        const products = Products.getAll();

        // Бренды
        const brands = [...new Set(products.map(p => {
            const name = p.full_name || p.name;
            if (name.includes('Gulf Western')) return 'Gulf Western';
            return 'Другой';
        }))].sort();
        this.renderFilterChips('filterBrand', brands, this.filters.brand);

        // Вязкость
        const viscosities = [...new Set(products.map(p => p.viscosity).filter(Boolean))].sort();
        this.renderFilterChips('filterViscosity', viscosities, this.filters.viscosity);

        // Объём
        const volumes = [...new Set(products.map(p => p.volume).filter(Boolean))].sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            return numA - numB;
        });
        this.renderFilterChips('filterVolume', volumes, this.filters.volume);

        // Тип масла
        const types = [...new Set(products.map(p => {
            if (p.subcategory === 'synthetic') return 'Синтетика';
            if (p.subcategory === 'semi_synthetic') return 'Полусинтетика';
            if (p.subcategory === 'mineral') return 'Минеральное';
            if (p.subcategory === 'diesel') return 'Дизельное';
            return null;
        }).filter(Boolean))].sort();
        this.renderFilterChips('filterType', types, this.filters.type);

        // Цена
        document.getElementById('filterPriceMin').value = this.filters.priceMin || '';
        document.getElementById('filterPriceMax').value = this.filters.priceMax || '';
    },

    renderFilterChips(containerId, options, selectedArray) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = options.map(opt => {
            const isActive = selectedArray.includes(opt);
            const optSafe = esc(opt);
            return `<button type="button" class="filter-chip ${isActive ? 'active' : ''}" data-value="${optSafe}" aria-pressed="${String(isActive)}" onclick="App.toggleFilterChip(this, '${containerId}')">${optSafe}</button>`;
        }).join('');
    },

    toggleFilterChip(chip, containerId) {
        const active = chip.classList.toggle('active');
        chip.setAttribute('aria-pressed', String(active));
        const value = chip.dataset.value;

        // Определяем массив фильтра по containerId
        let filterArray;
        switch (containerId) {
            case 'filterBrand': filterArray = this.filters.brand; break;
            case 'filterViscosity': filterArray = this.filters.viscosity; break;
            case 'filterVolume': filterArray = this.filters.volume; break;
            case 'filterType': filterArray = this.filters.type; break;
            default: return;
        }

        const index = filterArray.indexOf(value);
        if (index === -1) {
            filterArray.push(value);
        } else {
            filterArray.splice(index, 1);
        }
    },

    resetFilters() {
        this.filters = {
            brand: [],
            viscosity: [],
            volume: [],
            type: [],
            priceMin: null,
            priceMax: null
        };
        this.renderFilterOptions();
        this.renderProducts();
        this.updateFilterButton();
    },

    applyFilters() {
        this.filters.priceMin = document.getElementById('filterPriceMin').value ? parseInt(document.getElementById('filterPriceMin').value) : null;
        this.filters.priceMax = document.getElementById('filterPriceMax').value ? parseInt(document.getElementById('filterPriceMax').value) : null;

        this.toggleFilter();
        this.renderProducts();
        this.updateFilterButton();
    },

    updateFilterButton() {
        const btn = document.querySelector('.filter-btn');
        const hasFilters = this.filters.brand.length > 0 ||
            this.filters.viscosity.length > 0 ||
            this.filters.volume.length > 0 ||
            this.filters.type.length > 0 ||
            this.filters.priceMin !== null ||
            this.filters.priceMax !== null;

        btn.classList.toggle('active', hasFilters);
    },

    applyFiltersToProducts(products) {
        return products.filter(p => {
            // Бренд
            if (this.filters.brand.length > 0) {
                const brand = (p.full_name || p.name).includes('Gulf Western') ? 'Gulf Western' : 'Другой';
                if (!this.filters.brand.includes(brand)) return false;
            }

            // Вязкость
            if (this.filters.viscosity.length > 0) {
                if (!p.viscosity || !this.filters.viscosity.includes(p.viscosity)) return false;
            }

            // Объём
            if (this.filters.volume.length > 0) {
                if (!p.volume || !this.filters.volume.includes(p.volume)) return false;
            }

            // Тип
            if (this.filters.type.length > 0) {
                const oilType = p.oil_type || '';
                const subcategory = p.subcategory || '';
                let typeName = null;
                
                if (oilType.includes('синтетическое') || subcategory === 'synthetic') typeName = 'Синтетика';
                else if (oilType.includes('Полусинтетическое') || subcategory === 'semi_synthetic') typeName = 'Полусинтетика';
                else if (oilType.includes('Минеральное') || subcategory === 'mineral') typeName = 'Минеральное';
                else if (subcategory === 'diesel') typeName = 'Дизельное';
                
                if (!typeName || !this.filters.type.includes(typeName)) return false;
            }

            // Цена
            if (this.filters.priceMin !== null && p.price < this.filters.priceMin) return false;
            if (this.filters.priceMax !== null && p.price > this.filters.priceMax) return false;

            return true;
        });
    },

    toggleCategoryFilter() {
        // removed — categories now use horizontal scroll
    },

    selectCategory(value) {
        this.currentCategory = value;
        this.currentSubcategory = null;
        document.querySelectorAll('.cat-badge').forEach(badge => {
            const active = badge.dataset.cat === value;
            badge.classList.toggle('active', active);
            badge.setAttribute('aria-pressed', String(active));
        });
        this.renderSubcategories();
        this.renderProducts();
    },

    renderCategories() {
        const container = document.getElementById('categoriesScroll');
        let html = '<button type="button" class="cat-badge active" data-cat="all" aria-pressed="true">Все товары</button>';
        Products.categories.forEach(cat => {
            html += `<button type="button" class="cat-badge" data-cat="${cat.id}" aria-pressed="false"><i data-lucide="${cat.icon}" aria-hidden="true"></i> ${cat.name}</button>`;
        });
        container.innerHTML = html;
    },

    renderSubcategories() {
        const container = document.getElementById('subcategoriesRow');
        if (!container) return;

        if (this.currentCategory === 'all') {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        const subs = Products.getSubcategories(this.currentCategory);
        if (subs.length <= 1) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        let html = '<button type="button" class="filter-chip active" data-sub="all" aria-pressed="true">Все</button>';
        subs.forEach(sub => {
            html += `<button type="button" class="filter-chip" data-sub="${sub}" aria-pressed="false">${Products.getSubcategoryName(sub)}</button>`;
        });
        container.innerHTML = html;
    },

    async retryCatalogLoad() {
        const loading = Products.load();
        this.renderProducts();
        await loading;
        this.renderProducts();
    },

    renderProducts() {
        const grid = document.getElementById('productGrid');
        if (!grid) return;

        if (!Products.data.length) {
            if (Products.loadState === 'loading') {
                grid.innerHTML = '<div class="catalog-state" role="status" aria-live="polite"><span class="catalog-state-icon" aria-hidden="true"><i data-lucide="package-search"></i></span><strong>Загружаем каталог</strong><span>Подготавливаем товары и характеристики.</span><span class="catalog-state-progress" aria-hidden="true"></span></div>';
            } else if (Products.loadState === 'error') {
                grid.innerHTML = '<div class="catalog-state" role="alert"><span class="catalog-state-icon" aria-hidden="true"><i data-lucide="cloud-off"></i></span><strong>Не удалось загрузить каталог</strong><span>Проверьте подключение к интернету и попробуйте ещё раз.</span><button type="button" class="catalog-state-action" onclick="App.retryCatalogLoad()">Повторить загрузку</button></div>';
            } else {
                grid.innerHTML = '<div class="catalog-state" role="status"><span class="catalog-state-icon" aria-hidden="true"><i data-lucide="package-open"></i></span><strong>Каталог пока пуст</strong><span>Ассортимент скоро появится. Загляните сюда немного позже.</span></div>';
            }
            if (typeof lucide !== 'undefined') lucide.createIcons();
            return;
        }

        let products;

        // Поиск
        if (this.searchQuery) {
            products = Products.search(this.searchQuery);
        } else {
            products = Products.getByCategory(this.currentCategory);
            if (this.currentSubcategory) {
                products = products.filter(p => p.subcategory === this.currentSubcategory);
            }
        }

        // Применяем фильтры
        products = this.applyFiltersToProducts(products);

        // Сортировка
        products = Products.sort(products, this.currentSort);

        if (products.length === 0) {
            grid.innerHTML = '<div class="catalog-state catalog-state-filtered" role="status"><span class="catalog-state-icon" aria-hidden="true"><i data-lucide="search-x"></i></span><strong>Товары не найдены</strong><span>Попробуйте изменить поисковый запрос, категорию или параметры фильтра.</span></div>';
            if (typeof lucide !== 'undefined') lucide.createIcons();
            return;
        }

        grid.innerHTML = products.map(p => Products.renderCard(p, Favorites.has(p.id))).join('');

        // Re-init Lucide icons for dynamically added elements
        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    showProduct(productId) {
        const product = Products.getById(productId);
        if (!product) return;

        this.previousScreen = this.currentScreen;
        const container = document.getElementById('screen-detail');
        container.innerHTML = Products.renderDetail(product);

        // Переключаемся на экран деталей
        document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
        container.classList.add('active');
        const titleEl = document.getElementById('headerTitle');
        if (titleEl) {
            titleEl.innerHTML = '<img src="img/logo.png" alt="АВТОПРОМОЙЛ" class="header-logo-img">';
        }

        // Скрываем нижнее меню
        document.querySelector('.bottom-nav').style.display = 'none';

        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    goBack() {
        document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('screen-' + (this.previousScreen || 'main'));
        if (target) target.classList.add('active');

        // Показываем нижнее меню
        document.querySelector('.bottom-nav').style.display = 'flex';

        this.switchScreen(this.previousScreen || 'main');
    },

    switchScreen(screenName) {
        this.currentScreen = screenName;

        // Скрываем все экраны
        document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('screen-' + screenName);
        if (target) target.classList.add('active');

        // Показываем нижнее меню
        document.querySelector('.bottom-nav').style.display = 'flex';

        // Обновляем нижнее меню
        document.querySelectorAll('.nav-item').forEach(n => {
            n.classList.remove('active');
            n.removeAttribute('aria-current');
        });
        const navBtn = document.getElementById('btn-nav-' + screenName);
        if (navBtn) {
            navBtn.classList.add('active');
            navBtn.setAttribute('aria-current', 'page');
        }

        // Меняем заголовок
        const titleEl = document.getElementById('headerTitle');
        if (titleEl) {
            titleEl.innerHTML = '<img src="img/logo.png" alt="АВТОПРОМОЙЛ" class="header-logo-img">';
        }

        // Рендерим содержимое
        if (screenName === 'cart') {
            Cart.render();
            this.autoFillOrderForm();
        }
        if (screenName === 'favorites') Favorites.render();
        if (screenName === 'main') this.renderProducts();
        if (screenName === 'profile') Profile.updateUI();
    },

    // В форму подставляются только имя (из Telegram) и телефон. Адрес вводится при каждом заказе.
    // Блок «Списать бонусы»: показываем, только если на балансе есть бонусы; сумму считает сервер (здесь лишь подсказка)
    async refreshBonusBox() {
        const box = document.getElementById('bonusBox');
        if (!box) return;
        await Profile.syncBonuses();
        const spendable = Profile.getBonusSpendable(Math.round(Cart.getTotal() * (1 - Profile.getDiscount() / 100)));
        const cb = document.getElementById('orderUseBonuses');
        if (Profile.getBonusBalance() > 0 && spendable > 0) {
            document.getElementById('bonusLabel').textContent =
                `Списать бонусы: до ${spendable.toLocaleString('ru-RU')} ₽ (на балансе ${Profile.getBonusBalance().toLocaleString('ru-RU')})`;
            box.style.display = '';
        } else {
            box.style.display = 'none';
            if (cb) cb.checked = false;
        }
    },

    autoFillOrderForm() {
        this.refreshBonusBox();
        const profile = Profile.getProfileData() || {};

        const nameInput = document.getElementById('orderName');
        const name = Profile.getTelegramName() || profile.name;
        if (nameInput && name && !nameInput.value) nameInput.value = name;

        const phoneInput = document.getElementById('orderPhone');
        if (phoneInput && profile.phone && !phoneInput.value) phoneInput.value = profile.phone;
    },

    addToCart(productId) {
        const prod = Products.getById(productId);
        if (prod && prod.coming_soon) return;   // заглушка: товар ещё не в продаже
        Cart.add(productId);
        this.updateCartBadge();

        // Визуальный фидбек на карточках в каталоге
        const btns = document.querySelectorAll(`.btn-buy[data-product-id="${productId}"]`);
        btns.forEach(btn => {
            btn.innerHTML = '<i data-lucide="check"></i>';
            btn.classList.add('added');
            if (typeof lucide !== 'undefined') lucide.createIcons();
            setTimeout(() => {
                btn.innerHTML = '<i data-lucide="shopping-bag"></i>';
                btn.classList.remove('added');
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }, 800);
        });

        // Обновляем кнопку на экране деталей
        const detailBtn = document.querySelector('.btn-add-cart');
        if (detailBtn && detailBtn.getAttribute('onclick') === `App.addToCart(${productId})`) {
            detailBtn.textContent = 'В корзине';
            detailBtn.classList.add('in-cart');
        }
    },

    removeFromCart(productId) {
        Cart.remove(productId);
        this.updateCartBadge();
        Cart.render();
    },

    toggleFavorite(productId) {
        Favorites.toggle(productId);
        // Перерисовываем текущий экран
        if (this.currentScreen === 'main') this.renderProducts();
        if (this.currentScreen === 'favorites') Favorites.render();
    },

    updateCartBadge() {
        const badge = document.getElementById('cartBadge');
        const count = Cart.getCount();
        if (count > 0) {
            badge.textContent = count;
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    },

    toggleSearch() {
        const container = document.getElementById('searchContainer');
        const input = document.getElementById('searchInput');
        container.classList.toggle('active');
        if (container.classList.contains('active')) {
            input.focus();
        } else {
            input.value = '';
            this.searchQuery = '';
            this.renderProducts();
        }
    },

    toggleMenu(open) {
        const menu = document.getElementById('sideMenu');
        const overlay = document.getElementById('menuOverlay');
        const trigger = document.querySelector('.burger-btn');
        menu.setAttribute('aria-hidden', String(!open));
        menu.inert = !open;
        trigger?.setAttribute('aria-expanded', String(open));
        if (open) {
            overlay.style.display = 'block';
            setTimeout(() => {
                overlay.style.opacity = '1';
                menu.style.left = '0';
                menu.querySelector('.menu-back')?.focus();
            }, 10);
        } else {
            menu.style.left = '-300px';
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
            trigger?.focus();
        }
    },

    menuClick(pageName) {
        this.toggleMenu(false);
        const screenMap = {
            'О нас': 'about',
            'Доставка и оплата': 'delivery',
            'Контакты': 'contacts'
        };
        const screen = screenMap[pageName];
        if (screen) {
            this.previousScreen = this.currentScreen;
            document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
            const target = document.getElementById('screen-' + screen);
            if (target) target.classList.add('active');
            document.querySelector('.bottom-nav').style.display = 'flex';
            document.querySelectorAll('.nav-item').forEach(n => {
                n.classList.remove('active');
                n.removeAttribute('aria-current');
            });
            const titleEl = document.getElementById('headerTitle');
            if (titleEl) {
                titleEl.innerHTML = '<img src="img/logo.png" alt="АВТОПРОМОЙЛ" class="header-logo-img">';
            }
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    },

    toggleZoneDropdown() {
        const isOpen = document.getElementById('zoneMenu').classList.toggle('open');
        document.getElementById('zoneSelectToggle')?.setAttribute('aria-expanded', String(isOpen));
    },

    selectZone(value, label) {
        document.getElementById('orderZone').value = value;
        document.getElementById('zoneSelectLabel').textContent = label;
        document.querySelectorAll('#zoneMenu .custom-select-option').forEach(opt => {
            const active = opt.dataset.value === value;
            opt.classList.toggle('active', active);
            opt.setAttribute('aria-pressed', String(active));
        });
        document.getElementById('zoneMenu').classList.remove('open');
        document.getElementById('zoneSelectToggle')?.setAttribute('aria-expanded', 'false');
    },

    toggleDeliveryType() {
        const value = document.querySelector('input[name="deliveryType"]:checked').value;
        if (value === 'pickup') {
            alert('Самовывоз пока недоступен. Мы откроем пункт выдачи в ближайшее время! А пока воспользуйтесь доставкой.');
            document.querySelector('input[name="deliveryType"][value="delivery"]').checked = true;
            document.getElementById('labelDelivery').classList.add('active');
            document.getElementById('labelPickup').classList.remove('active');
            document.getElementById('deliveryFields').style.display = 'block';
            return;
        }
        document.getElementById('deliveryFields').style.display = 'block';
        document.getElementById('labelDelivery').classList.add('active');
        document.getElementById('labelPickup').classList.remove('active');
    },

    makeOrder() {
        const name = document.getElementById('orderName').value.trim();
        const phone = document.getElementById('orderPhone').value.trim();
        const deliveryType = document.querySelector('input[name="deliveryType"]:checked').value;
        const comment = document.getElementById('orderComment').value.trim();
        const payment = document.getElementById('orderPayment').value;

        // Валидация
        if (!name) {
            alert('Пожалуйста, укажите имя!');
            return;
        }
        if (!phone) {
            alert('Пожалуйста, укажите телефон!');
            return;
        }
        if (Cart.isEmpty()) {
            alert('Корзина пуста! Добавьте товары.');
            return;
        }

        // Сбор адреса
        let address = '';
        let zone = '';
        let city = '';
        let street = '';
        let house = '';
        let building = '';
        let structure = '';
        let letter = '';
        let entrance = '';
        let floor = '';
        let apartment = '';

        if (deliveryType === 'delivery') {
            zone = document.getElementById('orderZone').value;
            city = document.getElementById('orderCity').value.trim();
            street = document.getElementById('orderStreet').value.trim();
            house = document.getElementById('orderHouse').value.trim();
            building = document.getElementById('orderBuilding').value.trim();
            structure = document.getElementById('orderStructure').value.trim();
            letter = document.getElementById('orderLetter').value.trim();
            entrance = document.getElementById('orderEntrance').value.trim();
            floor = document.getElementById('orderFloor').value.trim();
            apartment = document.getElementById('orderApartment').value.trim();

            if (!street || !house) {
                alert('Пожалуйста, укажите улицу и дом!');
                return;
            }

            address = `${city}, ул. ${street}, д. ${house}`;
            if (building) address += `, корп. ${building}`;
            if (structure) address += `, стр. ${structure}`;
            if (letter) address += `, лит. ${letter}`;
            if (entrance) address += `, под. ${entrance}`;
            if (floor) address += `, эт. ${floor}`;
            if (apartment) address += `, кв. ${apartment}`;
        } else {
            address = 'Самовывоз';
        }

        const total = Cart.getTotal();
        const discount = Profile.getDiscount();
        const discountedTotal = Math.round(total * (1 - discount / 100));

        const orderItems = Cart.items.map(item => {
            const prod = Products.getById(item.id);
            return { id: prod.id, name: prod.name, volume: prod.volume, price: prod.price, qty: item.quantity };
        });

        // Получаем данные пользователя Telegram
        const tg = window.Telegram.WebApp;
        const user = tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
        const userName = name || (user ? ((user.first_name || '') + ' ' + (user.last_name || '')).trim() : 'Не указано');

        const order = {
            type: 'order',
            items: orderItems,
            total: discountedTotal,
            deliveryType: deliveryType,
            address: address,
            zone: zone,
            city: city,
            street: street,
            house: house,
            building: building,
            structure: structure,
            letter: letter,
            entrance: entrance,
            floor: floor,
            apartment: apartment,
            comment: comment,
            phone: phone,
            payment: payment,
            discount: discount,
            userName: userName,
            userId: user ? user.id : null,
            status: 'NEW',
            paymentStatus: 'PENDING',
            date: new Date().toLocaleDateString('ru-RU'),
            timestamp: Date.now()
        };

        // Отправляем на сервер ТОЛЬКО список товаров (без цены/итога — сервер рассчитает сам)
        const orderPayload = {
            items: Cart.items.map(item => ({
                productId: item.id,
                qty: item.quantity
            })),
            deliveryType: deliveryType,
            address: address,
            zone: zone,
            city: city,
            street: street,
            house: house,
            building: building,
            structure: structure,
            letter: letter,
            entrance: entrance,
            floor: floor,
            apartment: apartment,
            comment: comment,
            phone: phone,
            payment: payment,
            discountCode: (document.getElementById('orderReferral').value || '').trim(),
            useBonuses: !!(document.getElementById('orderUseBonuses') && document.getElementById('orderUseBonuses').checked),
            userName: userName,
            userId: user ? user.id : null,
            status: 'NEW',
            paymentStatus: 'PENDING',
            date: new Date().toLocaleDateString('ru-RU'),
            timestamp: Date.now()
        };

        // ВСЕГДА отправляем заказ через API для сохранения в БД
        const API_BASE = window.location.hostname === 'localhost'
            ? 'http://localhost:3000'
            : 'https://gulf-bot-production.up.railway.app';

        // Один ключ на одну попытку оформления: повтор того же запроса даст тот же заказ
        window._orderKey = window._orderKey || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
        fetch(`${API_BASE}/api/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Init-Data': (tg && tg.initData) || '',
                'Idempotency-Key': window._orderKey
            },
            body: JSON.stringify(orderPayload)
        })
        .then(async response => {
            if (response.status === 409) {
                const e = await response.json().catch(() => ({}));
                if (e.error === 'out_of_stock') {
                    alert(`К сожалению, товара${e.product ? ' «' + e.product + '»' : ''} уже нет в наличии. Уберите его из корзины или уменьшите количество и повторите заказ.`);
                } else if (e.error === 'bonus_insufficient') {
                    alert('Бонусов на балансе стало меньше, чем нужно для списания. Снимите галочку «Списать бонусы» или обновите приложение и повторите заказ.');
                } else {
                    alert('Не удалось применить промокод: лимит исчерпан. Уберите промокод и оформите заказ ещё раз.');
                }
                try { await Products.load(); this.renderProducts(); } catch (_) {}
                return;
            }
            if (response.status === 400) {
                const e = await response.json().catch(() => ({}));
                if (/own_referral_code/.test(String(e.error))) {
                    alert('Это ваш собственный код. Его вводит друг, а вы получите бонус за его заказ. Очистите поле «Код друга» и оформите заказ ещё раз.');
                    return;
                }
                throw new Error('Сервер отклонил заказ: ' + e.error);
            }
            if (!response.ok) throw new Error('Сервер вернул ошибку: ' + response.status);
            const data = await response.json();
            const serverTotal = data.total || discountedTotal;
            window._orderKey = null;
            // Заказ принят сервером: запоминаем его (для скидочной суммы) и подтягиваем историю с сервера
            order.orderNumber = data.orderId;
            order.total = serverTotal;
            Profile.addOrder(order);
            Profile.syncOrders();
            Profile.syncBonuses();
            let refText = '';
            if (orderPayload.discountCode) {
                refText = data.referralApplied ? '\nКод друга принят.'
                    : '\nКод друга не применён (' + ({ unknown_code: 'такого кода нет', own_phone: 'код привязан к вашему же телефону', bad_code: 'неверный формат' }[data.referralReason] || 'проверьте код') + '), заказ оформлен без него.';
            }
            const deliveryText = deliveryType === 'pickup' ? 'Самовывоз' : `Доставка: ${address}`;
            alert(`Заказ оформлен!\n\nНомер: #${data.orderId}\nСумма: ${serverTotal.toLocaleString()} руб.${(data.discount !== undefined ? data.discount : discount) > 0 ? ' (скидка ' + (data.discount !== undefined ? data.discount : discount) + '%)' : ''}${data.bonusUsed > 0 ? '\nСписано бонусов: ' + data.bonusUsed.toLocaleString('ru-RU') + ' ₽' : ''}${refText}\n${deliveryText}\nТелефон: ${phone}\n\nСпасибо за покупку!`);
            Cart.clear();
            this.updateCartBadge();
            Cart.render();
            this.switchScreen('main');
        })
        .catch(err => {
            console.error('Ошибка отправки заказа:', err);
            // Заказ НЕ принят: корзину не очищаем, ключ операции сохраняем, повтор не создаст дубль
            alert('Не удалось отправить заказ. Проверьте интернет и нажмите «Оформить» ещё раз. Корзина сохранена.');
        });

        // Единый механизм оформления: HTTP /api/order с проверкой initData на сервере.
        // tg.sendData не используем: он не работает при запуске из меню/инлайн-кнопки и дублировал бы заказ.

    },

    async openReferral() {
        await Profile.syncBonuses();
        const b = Profile.bonuses;
        const code = Profile.getReferralCode();
        if (!b || !code) {
            alert('Не удалось загрузить бонусы. Проверьте интернет и попробуйте ещё раз.');
            return;
        }
        const n = (v) => Number(v).toLocaleString('ru-RU');
        alert(`Ваш код: ${code}\n\nКод постоянный. Друг вводит его при заказе в поле «Код друга».\n` +
            `За каждый заказ друга, где товары дороже ${n(b.minOrder)} ₽, вы получите ${n(b.bonusPerOrder)} бонусов после доставки.\n` +
            `1 бонус = 1 ₽, бонусами можно оплатить до ${b.maxSharePct}% стоимости товаров в заказе.\n\n` +
            `Ваш баланс: ${n(b.balance)} бонусов\nЗаказов друзей с бонусом: ${b.invitedOrders}, начислено всего: ${n(b.earned)}`);
    },

    showOrderHistory() {
        this.previousScreen = this.currentScreen;
        document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('screen-orders');
        if (target) target.classList.add('active');
        document.querySelector('.bottom-nav').style.display = 'flex';
        document.querySelectorAll('.nav-item').forEach(n => {
            n.classList.remove('active');
            n.removeAttribute('aria-current');
        });
        document.getElementById('headerTitle').innerHTML = '<img src="img/logo.png" alt="АВТОПРОМОЙЛ" class="header-logo-img">';
        Profile.renderOrderHistory();
        Profile.syncOrders();
        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    contactSupport() {
        alert('Поддержка: напишите нам в Telegram @avtopromol_support или позвоните 8-800-555-35-35');
    },

    // Профиль: редактирование данных (имя берётся из Telegram, редактируется только телефон)
    editProfile() {
        const profile = Profile.getProfileData();
        document.getElementById('modalProfileName').value = Profile.getTelegramName() || profile.name || '';
        document.getElementById('modalProfilePhone').value = profile.phone || '';
        document.getElementById('modalProfile').classList.add('open');
    },

    async saveProfile() {
        const phone = document.getElementById('modalProfilePhone').value.trim();
        const result = await Profile.saveProfileData({ phone });
        if (!result.savedLocally) {
            alert('Не удалось сохранить данные профиля на этом устройстве.');
            return;
        }

        Profile.updateProfileUI();
        this.closeModal('modalProfile');

        if (result.synced) {
            alert('Данные профиля сохранены.');
        } else if (result.error) {
            alert('Данные сохранены на устройстве, но не синхронизированы с сервером. Попробуйте позже.');
        } else {
            alert('Данные сохранены на этом устройстве. Для синхронизации откройте магазин из Telegram.');
        }
    },

    // Модальные окна
    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('open');
    },

    // Выход
    logout() {
        if (confirm('Выйти из аккаунта? Данные корзины и избранного будут сохранены.')) {
            localStorage.removeItem('gulf_profile');
            Profile.updateProfileUI();
            alert('Вы вышли из аккаунта.');
        }
    }
};

window.App = App;
