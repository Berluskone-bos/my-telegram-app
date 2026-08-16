// Главный модуль приложения
const App = {
    currentScreen: 'main',
    currentCategory: 'all',
    currentSubcategory: null,
    currentSort: 'popular',
    searchQuery: '',
    previousScreen: null,

    async init() {
        // Загружаем данные
        await Products.load();
        Cart.load();
        Favorites.load();
        Profile.load();

        // Инициализация Telegram
        const tg = TelegramApp.init();
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
    },

    toggleSort() {
        document.getElementById('sortMenu').classList.toggle('open');
    },

    selectSort(value) {
        this.currentSort = value;
        document.querySelectorAll('#sortMenu .sort-option').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.value === value);
        });
        document.getElementById('sortMenu').classList.remove('open');
        this.renderProducts();
    },

    toggleCategoryFilter() {
        // removed — categories now use horizontal scroll
    },

    selectCategory(value) {
        this.currentCategory = value;
        document.querySelectorAll('.cat-badge').forEach(badge => {
            badge.classList.toggle('active', badge.dataset.cat === value);
        });
        this.renderProducts();
    },

    renderCategories() {
        const container = document.getElementById('categoriesScroll');
        let html = '<div class="cat-badge active" data-cat="all">Все товары</div>';
        Products.categories.forEach(cat => {
            html += `<div class="cat-badge" data-cat="${cat.id}">${cat.icon} ${cat.name}</div>`;
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
        let html = '<div class="filter-chip active" data-sub="all">Все</div>';
        subs.forEach(sub => {
            html += `<div class="filter-chip" data-sub="${sub}">${Products.getSubcategoryName(sub)}</div>`;
        });
        container.innerHTML = html;

        // Обработчик подкатегорий
        container.addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (chip) {
                container.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.currentSubcategory = chip.dataset.sub === 'all' ? null : chip.dataset.sub;
                this.renderProducts();
            }
        });
    },

    renderProducts() {
        const grid = document.getElementById('productGrid');
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

        // Сортировка
        products = Products.sort(products, this.currentSort);

        if (products.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#666; padding:30px;">Товары не найдены</div>';
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
        document.getElementById('headerTitle').innerHTML = `<span class="header-logo-text">${product.name}</span>`;

        // Скрываем нижнее меню
        document.querySelector('.bottom-nav').style.display = 'none';
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
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navBtn = document.getElementById('btn-nav-' + screenName);
        if (navBtn) navBtn.classList.add('active');

        // Меняем заголовок
        const titles = {
            main: '<span class="header-logo-text">АВТОПРОМОЙЛ</span>',
            favorites: '<span class="header-logo-text">ИЗБРАННОЕ</span>',
            cart: '<span class="header-logo-text">КОРЗИНА</span>',
            profile: '<span class="header-logo-text">ПРОФИЛЬ</span>'
        };
        document.getElementById('headerTitle').innerHTML = titles[screenName] || '<span class="header-logo-text">АВТОПРОМОЙЛ</span>';

        // Рендерим содержимое
        if (screenName === 'cart') Cart.render();
        if (screenName === 'favorites') Favorites.render();
        if (screenName === 'main') this.renderProducts();
        if (screenName === 'profile') Profile.updateUI();
    },

    addToCart(productId) {
        Cart.add(productId);
        this.updateCartBadge();

        // Визуальный фидбек
        const btns = document.querySelectorAll(`.btn-buy[onclick*="addToCart(${productId})"]`);
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
        if (open) {
            overlay.style.display = 'block';
            setTimeout(() => { overlay.style.opacity = '1'; menu.style.left = '0'; }, 10);
        } else {
            menu.style.left = '-300px';
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
        }
    },

    menuClick(pageName) {
        this.toggleMenu(false);
        // TODO: открыть страницу с информацией
        alert('Раздел: ' + pageName + '\n(информация будет добавлена позже)');
    },

    makeOrder() {
        const address = document.getElementById('address').value.trim();
        const phone = document.getElementById('phone').value.trim();
        const zone = document.getElementById('delivery-zone').value;

        if (!address || !phone) {
            alert('Пожалуйста, укажите адрес и телефон для доставки!');
            return;
        }
        if (Cart.isEmpty()) {
            alert('Корзина пуста! Добавьте товары.');
            return;
        }

        const total = Cart.getTotal();
        const discount = Profile.getDiscount();
        const discountedTotal = Math.round(total * (1 - discount / 100));

        const orderItems = Cart.items.map(item => {
            const prod = Products.getById(item.id);
            return { name: prod.name, volume: prod.volume, price: prod.price, qty: item.quantity };
        });

        // Получаем данные пользователя Telegram
        const tg = window.Telegram.WebApp;
        const user = tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
        const userName = user ? ((user.first_name || '') + ' ' + (user.last_name || '')).trim() : 'Не указано';

        const order = {
            type: 'order',
            items: orderItems,
            total: discountedTotal,
            address: address,
            phone: phone,
            zone: zone,
            discount: discount,
            userName: userName,
            userId: user ? user.id : null,
            date: new Date().toLocaleDateString('ru-RU'),
            timestamp: Date.now()
        };

        // Сохраняем заказ локально
        Profile.addOrder(order);

        // Отправляем данные в Telegram бот
        try {
            // Метод 1: Через Telegram.WebApp.sendData() (основной способ)
            const orderJson = JSON.stringify(order);
            tg.sendData(orderJson);
            console.log('Заказ отправлен через Telegram WebApp:', order);

            // Показываем подтверждение
            alert(`Заказ оформлен!\n\nСумма: ${discountedTotal.toLocaleString()} руб.${discount > 0 ? ' (скидка ' + discount + '%)' : ''}\nАдрес: ${address}\nТелефон: ${phone}\n\nСпасибо за покупку!`);
        } catch (e) {
            console.log('Telegram sendData не доступен, пробуем API:', e);

            fetch('/api/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(order)
            })
            .then(response => response.json())
            .then(data => {
                console.log('Заказ отправлен через API:', data);
                alert(`Заказ оформлен!\n\nСумма: ${discountedTotal.toLocaleString()} руб.${discount > 0 ? ' (скидка ' + discount + '%)' : ''}\nАдрес: ${address}\nТелефон: ${phone}\n\nСпасибо за покупку!`);
            })
            .catch(err => {
                console.error('Ошибка отправки через API:', err);
                alert(`Заказ оформлен локально!\n\nСумма: ${discountedTotal.toLocaleString()} руб.\nАдрес: ${address}\nТелефон: ${phone}\n\nМы свяжемся с вами для подтверждения.`);
            });
        }

        Cart.clear();
        this.updateCartBadge();
        Cart.render();
        this.switchScreen('main');
    },

    openReferral() {
        const code = Profile.getReferralCode();
        alert(`Ваш промокод: ${code}\n\nДайте его друзьям. За каждый заказ по вашему промокоду вы получите бонус 100 руб. на счёт!`);
    },

    showOrderHistory() {
        this.switchScreen('profile');
        Profile.renderOrderHistory();
    },

    contactSupport() {
        alert('Поддержка: напишите нам в Telegram @avtopromol_support или позвоните 8-800-555-35-35');
    }
};

// Запуск приложения
document.addEventListener('DOMContentLoaded', () => App.init());
