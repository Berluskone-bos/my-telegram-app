// Экранирование HTML
// esc() объявлена в products.js (грузится первой)

// Профиль и бонусная система
const Profile = {
    totalSpent: 0,
    orderHistory: [],
    editMode: false,
    selectedOrders: new Set(),

    // Статусы заказов
    ORDER_STATUSES: {
        NEW: { text: 'Новый', class: 'order-status-new' },
        CONFIRMED: { text: 'Подтверждён', class: 'order-status-confirmed' },
        ASSEMBLING: { text: 'Собирается', class: 'order-status-assembling' },
        SHIPPING: { text: 'В доставке', class: 'order-status-shipped' },
        DELIVERY_FAILED: { text: 'Не доставлен — свяжемся с вами', class: 'order-status-cancelled' },
        SHIPPED: { text: 'В доставке', class: 'order-status-shipped' },
        DELIVERED: { text: 'Доставлен', class: 'order-status-delivered' },
        COMPLETED: { text: 'Завершён', class: 'order-status-delivered' },
        CANCELLED: { text: 'Отменён', class: 'order-status-cancelled' }
    },

    // Статусы оплаты
    PAYMENT_STATUSES: {
        PENDING: 'Ожидает оплаты',
        PAID: 'Оплачен',
        FAILED: 'Ошибка оплаты',
        REFUNDED: 'Возврат'
    },

    getStatusText(status) {
        return this.ORDER_STATUSES[status] || { text: status, class: 'order-status-new' };
    },

    getPaymentStatusText(status) {
        return this.PAYMENT_STATUSES[status] || status;
    },

    load() {
        try {
            const savedSpent = localStorage.getItem('gulf_spent');
            if (savedSpent) this.totalSpent = parseFloat(savedSpent) || 0;
            const savedHistory = localStorage.getItem('gulf_orders');
            if (savedHistory) this.orderHistory = JSON.parse(savedHistory);
            const savedLoyalty = localStorage.getItem('gulf_loyalty');
            if (savedLoyalty) this.loyalty = JSON.parse(savedLoyalty);
        } catch (e) {
            this.totalSpent = 0;
            this.orderHistory = [];
        }
    },

    save() {
        localStorage.setItem('gulf_spent', String(this.totalSpent));
        localStorage.setItem('gulf_orders', JSON.stringify(this.orderHistory));
    },

    // История заказов с сервера: сервер — источник правды, localStorage — только запас на случай отсутствия связи.
    async syncOrders() {
        const initData = this.getTelegramInitData();
        if (!initData) return false;
        try {
            const r = await fetch(this.getApiBase() + '/api/orders/my', { headers: { 'X-Telegram-Init-Data': initData } });
            if (!r.ok) return false;
            const data = await r.json();
            if (!data.success || !Array.isArray(data.orders)) return false;
            this.orderHistory = data.orders.map(o => ({
                orderNumber: o.orderNumber,
                status: o.status,
                paymentStatus: o.paymentStatus,
                deliveryType: o.deliveryType,
                address: o.address,
                items: o.items,
                total: o.total,
                discount: o.discount,
                date: new Date(o.createdAt).toLocaleDateString('ru-RU'),
                timestamp: Date.parse(o.createdAt) || 0
            }));
            this.selectedOrders.clear();
            this.save();
            this.renderOrderHistory();
            return true;
        } catch (e) {
            console.warn('[Profile] История заказов не обновлена:', e && e.message);
            return false;
        }
    },

    addOrder(order) {
        this.orderHistory.unshift(order);
        this.totalSpent += order.total;
        this.save();
    },

    reorder(idx) {
        const order = this.orderHistory[idx];
        if (!order) return;

        let addedCount = 0;
        let missingItems = [];
        let priceChanges = [];

        order.items.forEach(item => {
            const product = Products.getById(item.id);
            if (product) {
                if (product.price !== item.price) {
                    priceChanges.push(`${product.name}: было ${item.price} ₽, стало ${product.price} ₽`);
                }
                for (let q = 0; q < Math.min(Math.max(parseInt(item.qty) || 1, 1), 20); q++) Cart.add(product.id);
                addedCount++;
            } else {
                missingItems.push(item.name);
            }
        });

        let message = `Добавлено в корзину: ${addedCount} товар(ов)`;

        if (priceChanges.length > 0) {
            message += '\n\n⚠️ Цены изменились:\n' + priceChanges.join('\n');
        }

        if (missingItems.length > 0) {
            message += '\n\n❌ Нет в наличии:\n' + missingItems.join(', ');
        }

        alert(message);
        App.updateCartBadge();
        App.switchScreen('cart');
    },

    // Номер карты = Telegram ID: уникален, не хранится и не угадывается из случайного числа.
    getCardNumber() {
        const tg = window.Telegram && window.Telegram.WebApp;
        const user = tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
        try { localStorage.removeItem('gulf_card'); } catch (e) {}   // старый номер AR-… больше не используется
        return user && user.id ? 'TG-' + user.id : 'TG-—';
    },

    // Скидка и уровень приходят с сервера (GET /api/loyalty); считает только сервер, здесь лишь показ.
    // Пока ответа нет, показываем базовую скидку 3 %, она положена каждому покупателю.
    loyalty: null,

    async syncLoyalty() {
        const initData = this.getTelegramInitData();
        if (!initData) return false;
        try {
            const r = await fetch(this.getApiBase() + '/api/loyalty', { headers: { 'X-Telegram-Init-Data': initData } });
            if (!r.ok) return false;
            const data = await r.json();
            if (!data.success || !data.loyalty) return false;
            this.loyalty = data.loyalty;
            try { localStorage.setItem('gulf_loyalty', JSON.stringify(this.loyalty)); } catch (e) {}
            this.updateUI();
            return true;
        } catch (e) {
            console.warn('[Profile] Скидка не обновлена:', e && e.message);
            return false;
        }
    },

    getLevel() {
        const l = this.loyalty;
        if (!l || !Array.isArray(l.tiers)) return 1;
        const idx = l.tiers.findIndex(t => t.at === l.from);
        return idx >= 0 ? idx + 1 : 1;
    },

    getDiscount() {
        return this.loyalty ? Number(this.loyalty.percent) || 0 : 3;
    },

    getStatus() {
        return this.loyalty && this.loyalty.name ? this.loyalty.name : 'Железный';
    },

    // Сколько оборота осталось до следующего уровня (0 — уровень максимальный)
    getNextLevelAmount() {
        const l = this.loyalty;
        if (!l || !l.next) return 0;
        return Math.max(Math.round(l.next.at - l.turnover), 0);
    },

    getProgress() {
        const l = this.loyalty;
        if (!l) return 0;
        if (!l.next) return 100;
        const span = l.next.at - l.from;
        return span > 0 ? ((l.turnover - l.from) / span) * 100 : 0;
    },

    // Реферальный код постоянный и привязан к Telegram ID: REF-<ID>. Баланс и правила — только с сервера.
    getReferralCode() {
        if (this.bonuses && this.bonuses.referralCode) return this.bonuses.referralCode;
        const tg = window.Telegram && window.Telegram.WebApp;
        const user = tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
        return user && user.id ? 'REF-' + user.id : '';
    },

    async syncBonuses() {
        const initData = this.getTelegramInitData();
        if (!initData) return false;
        try {
            const r = await fetch(this.getApiBase() + '/api/bonuses', { headers: { 'X-Telegram-Init-Data': initData } });
            if (!r.ok) return false;
            const data = await r.json();
            if (!data.success) return false;
            this.bonuses = data;
            return true;
        } catch (e) {
            console.warn('[Profile] Бонусы не обновлены:', e && e.message);
            return false;
        }
    },

    getBonusBalance() {
        return this.bonuses ? Number(this.bonuses.balance) || 0 : 0;
    },

    // Сколько бонусов можно списать в заказе на эту сумму товаров (то же правило, что на сервере)
    getBonusSpendable(goodsTotal) {
        const b = this.bonuses;
        if (!b) return 0;
        const cap = Math.floor(Math.max(goodsTotal, 0) * (Number(b.maxSharePct) || 0) / 100);
        return Math.max(0, Math.min(this.getBonusBalance(), cap));
    },

    updateUI() {
        const level = this.getLevel();
        const card = document.querySelector('.loyalty-card');
        if (card) {
            card.className = 'loyalty-card loyalty-level-' + level;
        }
        document.getElementById('cardNumber').textContent = this.getCardNumber();
        document.getElementById('cardDiscountValue').textContent = this.getDiscount() + '%';
        document.getElementById('loyaltyStatus').textContent = this.getStatus();
        const next = this.getNextLevelAmount();
        document.getElementById('loyaltyNext').textContent = this.loyalty ? (next > 0 ? next.toLocaleString() + ' руб.' : 'MAX') : '—';
        document.getElementById('loyaltyProgress').style.width = Math.min(this.getProgress(), 100) + '%';

        this.updateProfileUI();
    },

    // Данные профиля. JSON в localStorage хранится в UTF-8 без btoa,
    // который бросает InvalidCharacterError на кириллице.
    getProfileData() {
        try {
            try { localStorage.removeItem('gulf_car'); } catch (e) {}   // автомобиль в профиле больше не хранится
            const saved = localStorage.getItem('gulf_profile');
            if (!saved) return {};
            let data;
            try { data = JSON.parse(saved); } catch { data = JSON.parse(atob(saved)); }
            // старые версии хранили здесь адрес: оставляем только имя и телефон
            if (data && Object.keys(data).some(k => k !== 'name' && k !== 'phone')) {
                data = { name: data.name || '', phone: data.phone || '' };
                try { localStorage.setItem('gulf_profile', JSON.stringify(data)); } catch (e) {}
            }
            return data || {};
        } catch (e) {
            console.warn('[Profile] Не удалось прочитать локальный профиль:', e);
            return {};
        }
    },

    getApiBase() {
        return window.location.hostname === 'localhost'
            ? 'http://localhost:3000'
            : 'https://gulf-bot-production.up.railway.app';
    },

    getTelegramInitData() {
        return window.Telegram && window.Telegram.WebApp
            ? window.Telegram.WebApp.initData || ''
            : '';
    },

    // Имя пользователя из Telegram (подписанные данные запуска)
    getTelegramName() {
        const u = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe
            ? window.Telegram.WebApp.initDataUnsafe.user : null;
        return u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : '';
    },

    // В профиле только имя (из Telegram) и телефон. Адрес не хранится ни на сервере, ни на устройстве.
    saveProfileData(data) {
        const profile = {
            name: this.getTelegramName() || String(data.name || '').trim(),
            phone: String(data.phone || '').trim()
        };

        try {
            localStorage.setItem('gulf_profile', JSON.stringify(profile));
        } catch (e) {
            console.error('[Profile] Локальное сохранение не удалось:', e);
            return Promise.resolve({ savedLocally: false, synced: false, error: e });
        }

        const initData = this.getTelegramInitData();
        if (!initData) return Promise.resolve({ savedLocally: true, synced: false });

        return fetch(this.getApiBase() + '/api/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Init-Data': initData
            },
            body: JSON.stringify(profile)
        }).then(async response => {
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'HTTP ' + response.status);
            }
            if (result.profile) {
                localStorage.setItem('gulf_profile', JSON.stringify(result.profile));
            }
            return { savedLocally: true, synced: true };
        }).catch(error => {
            console.error('[Profile] Ошибка синхронизации с сервером:', error);
            return { savedLocally: true, synced: false, error };
        });
    },

    async loadFromServer(tg) {
        const initData = tg && tg.initData ? tg.initData : '';
        if (!initData) return false;

        try {
            const response = await fetch(this.getApiBase() + '/api/profile', {
                method: 'GET',
                headers: { 'X-Telegram-Init-Data': initData }
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'HTTP ' + response.status);
            }

            if (result.profile) {
                localStorage.setItem('gulf_profile', JSON.stringify(result.profile));
            } else {
                const localProfile = this.getProfileData();
                const hasLocalData = Object.values(localProfile).some(value => String(value || '').trim());
                if (hasLocalData) {
                    const sync = await this.saveProfileData(localProfile);
                    if (!sync.synced) console.warn('[Profile] Локальный профиль пока не синхронизирован с сервером');
                }
            }
            return true;
        } catch (error) {
            console.warn('[Profile] Не удалось загрузить профиль с сервера:', error);
            return false;
        }
    },

    updateProfileUI() {
        const profile = this.getProfileData();
        const nameEl = document.getElementById('profileName');
        const phoneEl = document.getElementById('profilePhone');
        if (nameEl) nameEl.textContent = this.getTelegramName() || profile.name || '—';
        if (phoneEl) phoneEl.textContent = profile.phone || '—';
    },


    toggleEditMode() {
        this.editMode = !this.editMode;
        this.selectedOrders.clear();
        const actionsBar = document.getElementById('ordersActions');
        if (actionsBar) actionsBar.style.display = this.editMode ? 'flex' : 'none';
        this.renderOrderHistory();
    },

    toggleOrderSelection(idx) {
        if (this.selectedOrders.has(idx)) {
            this.selectedOrders.delete(idx);
        } else {
            this.selectedOrders.add(idx);
        }
        this.renderOrderHistory();
    },

    selectAllOrders() {
        if (this.selectedOrders.size === this.orderHistory.length) {
            this.selectedOrders.clear();
        } else {
            this.orderHistory.forEach((_, idx) => this.selectedOrders.add(idx));
        }
        this.renderOrderHistory();
    },

    async deleteSelectedOrders() {
        if (this.selectedOrders.size === 0) return;
        const count = this.selectedOrders.size;
        const msg = count === this.orderHistory.length
            ? 'Удалить все заказы из истории?'
            : `Удалить выбранные заказы (${count})?`;
        if (!confirm(msg)) return;

        const picked = [...this.selectedOrders].map(i => this.orderHistory[i]).filter(Boolean);
        const serverNums = picked.map(o => o.orderNumber).filter(Boolean);
        let hidden = new Set(serverNums);
        let skipped = [];
        if (serverNums.length) {
            // Заказы хранятся на сервере: из истории скрываются только завершённые и отменённые
            try {
                const r = await fetch(this.getApiBase() + '/api/orders/my/hide', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': this.getTelegramInitData() },
                    body: JSON.stringify({ orderNumbers: serverNums })
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const d = await r.json();
                hidden = new Set(d.hidden || []);
                skipped = d.skipped || [];
            } catch (e) {
                alert('Не удалось удалить заказы: нет связи с сервером. Попробуйте позже.');
                return;
            }
        }
        this.orderHistory = this.orderHistory.filter(o => !picked.includes(o) || (o.orderNumber && !hidden.has(o.orderNumber)));
        this.save();
        this.selectedOrders.clear();
        this.editMode = false;
        const actionsBar = document.getElementById('ordersActions');
        if (actionsBar) actionsBar.style.display = 'none';
        this.renderOrderHistory();
        if (skipped.length) alert('Заказы в работе нельзя удалить из истории, пока они не доставлены или не отменены:\n' + skipped.join(', '));
    },

    renderOrderHistory() {
        const container = document.getElementById('orderHistoryList');
        if (!container) return;

        if (this.orderHistory.length === 0) {
            container.innerHTML = '<div class="empty-state"><i data-lucide="package" style="width:48px;height:48px;color:#ccc;"></i><p>У вас пока нет заказов</p><p style="font-size:13px;color:var(--text-muted);">Оформите первый заказ в каталоге</p></div>';
            const actionsBar = document.getElementById('ordersActions');
            if (actionsBar) actionsBar.style.display = 'none';
            if (typeof lucide !== 'undefined') lucide.createIcons();
            return;
        }

        const hasSelected = this.selectedOrders.size > 0;
        let html = '';

        if (this.editMode) {
            html += `<div class="orders-edit-bar">
                <button class="orders-edit-btn" onclick="Profile.toggleEditMode()">
                    <i data-lucide="x" style="width:16px;height:16px;"></i> Готово
                </button>
            </div>`;
        } else {
            html += `<div class="orders-edit-bar">
                <button class="orders-edit-btn" onclick="Profile.toggleEditMode()">
                    <i data-lucide="edit-3" style="width:16px;height:16px;"></i> Выбрать
                </button>
            </div>`;
        }

        this.orderHistory.forEach((order, idx) => {
            const orderNum = this.orderHistory.length - idx;
            const itemsCount = (order.items || []).reduce((n, i) => n + (parseInt(i.qty) || 1), 0);
            const itemsSummary = (order.items || []).map(i => esc(i.name) + ((i.qty || 1) > 1 ? ' × ' + (parseInt(i.qty) || 1) : '')).join(', ');
            const checked = this.selectedOrders.has(idx);
            const status = this.getStatusText(order.status || 'NEW');
            const paymentStatus = order.paymentStatus || 'PENDING';
            const deliveryType = order.deliveryType || 'delivery';
            const deliveryLabel = deliveryType === 'pickup' ? 'Самовывоз' : 'Доставка';

            html += `
                <div class="order-card ${this.editMode ? 'order-card-edit' : ''}" ${this.editMode ? `onclick="Profile.toggleOrderSelection(${idx})"` : ''}>
                    ${this.editMode ? `<div class="order-checkbox">${checked ? '<i data-lucide="check-circle" style="width:22px;height:22px;color:var(--accent);"></i>' : '<i data-lucide="circle" style="width:22px;height:22px;color:var(--border);"></i>'}</div>` : ''}
                    <div class="order-header">
                        <div class="order-number">Заказ #${order.orderNumber ? esc(order.orderNumber) : 'AP-' + String(orderNum).padStart(6, '0')}</div>
                        <span class="order-status ${esc(status.class)}">${esc(status.text)}</span>
                    </div>
                    <div class="order-date">${esc(order.date || '')} · ${esc(deliveryLabel)}</div>
                    <div class="order-items">${itemsSummary}</div>
                    <div class="order-payment-status">${this.getPaymentStatusText(paymentStatus)}</div>
                    <div class="order-footer">
                        <div>
                            <div class="order-total">${order.total.toLocaleString()} руб.</div>
                            <div class="order-count">${itemsCount} ${itemsCount === 1 ? 'товар' : 'товара'}</div>
                        </div>
                        ${!this.editMode ? `<button class="order-reorder-btn" onclick="event.stopPropagation(); Profile.reorder(${idx})">
                            <i data-lucide="repeat" style="width:14px;height:14px;"></i> Заказать повторно
                        </button>` : ''}
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
};
