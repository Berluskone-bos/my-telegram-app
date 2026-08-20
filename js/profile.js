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
        SHIPPED: { text: 'В доставке', class: 'order-status-shipped' },
        DELIVERED: { text: 'Доставлен', class: 'order-status-delivered' },
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
        } catch (e) {
            this.totalSpent = 0;
            this.orderHistory = [];
        }
    },

    save() {
        localStorage.setItem('gulf_spent', String(this.totalSpent));
        localStorage.setItem('gulf_orders', JSON.stringify(this.orderHistory));
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
                Cart.add(product.id);
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

    getCardNumber() {
        let num = localStorage.getItem('gulf_card');
        if (!num) {
            const digits = String(Math.floor(100000 + Math.random() * 900000));
            num = 'AR-' + digits;
            localStorage.setItem('gulf_card', num);
        }
        return num;
    },

    getLevel() {
        if (this.totalSpent >= 120000) return 4;
        if (this.totalSpent >= 80000) return 3;
        if (this.totalSpent >= 40000) return 2;
        return 1;
    },

    getDiscount() {
        const level = this.getLevel();
        if (level === 4) return 7;
        if (level === 3) return 5;
        if (level === 2) return 3;
        return 0;
    },

    getStatus() {
        const level = this.getLevel();
        if (level === 4) return 'Золотой';
        if (level === 3) return 'Серебряный';
        if (level === 2) return 'Бронзовый';
        return 'Железный';
    },

    getNextLevelAmount() {
        const level = this.getLevel();
        if (level === 4) return 0;
        if (level === 3) return 120000;
        if (level === 2) return 80000;
        return 40000;
    },

    getProgress() {
        const level = this.getLevel();
        if (level === 4) return 100;
        if (level === 3) return ((this.totalSpent - 80000) / 40000) * 100;
        if (level === 2) return ((this.totalSpent - 40000) / 40000) * 100;
        return (this.totalSpent / 40000) * 100;
    },

    getReferralCode() {
        let code = localStorage.getItem('gulf_referral');
        if (!code) {
            code = 'GULF-' + Math.floor(1000 + Math.random() * 9000);
            localStorage.setItem('gulf_referral', code);
        }
        return code;
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
        document.getElementById('loyaltyNext').textContent = next > 0 ? next.toLocaleString() + ' руб.' : 'MAX';
        document.getElementById('loyaltyProgress').style.width = Math.min(this.getProgress(), 100) + '%';

        // Обновляем данные профиля и автомобиля
        this.updateProfileUI();
        this.updateCarUI();
    },

    // Данные профиля
    getProfileData() {
        try {
            const saved = localStorage.getItem('gulf_profile');
            return saved ? JSON.parse(saved) : {};
        } catch (e) {
            return {};
        }
    },

    saveProfileData(data) {
        localStorage.setItem('gulf_profile', JSON.stringify(data));
    },

    updateProfileUI() {
        const profile = this.getProfileData();
        const nameEl = document.getElementById('profileName');
        const phoneEl = document.getElementById('profilePhone');
        const addressEl = document.getElementById('profileAddress');

        if (nameEl) nameEl.textContent = profile.name || '—';
        if (phoneEl) phoneEl.textContent = profile.phone || '—';
        if (addressEl) addressEl.textContent = profile.address || '—';
    },

    // Данные автомобиля
    getCarData() {
        try {
            const saved = localStorage.getItem('gulf_car');
            return saved ? JSON.parse(saved) : {};
        } catch (e) {
            return {};
        }
    },

    saveCarData(data) {
        if (data) {
            localStorage.setItem('gulf_car', JSON.stringify(data));
        } else {
            localStorage.removeItem('gulf_car');
        }
    },

    updateCarUI() {
        const car = this.getCarData();
        const container = document.getElementById('profileCarCard');
        if (!container) return;

        if (car && car.brand && car.model) {
            const yearText = car.year ? `, ${car.year}` : '';
            const engineText = car.engine ? ` · ${car.engine}` : '';
            container.innerHTML = `
                <div class="profile-car-info">
                    <div class="profile-car-name">${car.brand} ${car.model}</div>
                    <div class="profile-car-details">${yearText}${engineText}</div>
                </div>
                <div class="profile-car-actions">
                    <button class="profile-car-action-btn" onclick="App.addCar()">
                        <i data-lucide="edit-3" style="width:14px;height:14px;"></i> Изменить
                    </button>
                    <button class="profile-car-action-btn delete" onclick="App.removeCar()">
                        <i data-lucide="trash-2" style="width:14px;height:14px;"></i> Удалить
                    </button>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="profile-car-empty">
                    <i data-lucide="car" style="width:32px;height:32px;color:var(--text-muted);opacity:0.4;"></i>
                    <p>Автомобиль не добавлен</p>
                    <button class="profile-add-car-btn" onclick="App.addCar()">
                        <i data-lucide="plus" style="width:16px;height:16px;"></i> Добавить автомобиль
                    </button>
                </div>
            `;
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
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

    deleteSelectedOrders() {
        if (this.selectedOrders.size === 0) return;
        const count = this.selectedOrders.size;
        const msg = count === this.orderHistory.length
            ? 'Удалить все заказы из истории?'
            : `Удалить выбранные заказы (${count})?`;
        if (!confirm(msg)) return;

        const sorted = [...this.selectedOrders].sort((a, b) => b - a);
        sorted.forEach(idx => {
            this.orderHistory.splice(idx, 1);
        });
        this.save();
        this.selectedOrders.clear();
        this.editMode = false;
        const actionsBar = document.getElementById('ordersActions');
        if (actionsBar) actionsBar.style.display = 'none';
        this.renderOrderHistory();
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
            const itemsSummary = order.items.map(i => i.name).join(', ');
            const checked = this.selectedOrders.has(idx);
            const status = this.getStatusText(order.status || 'NEW');
            const paymentStatus = order.paymentStatus || 'PENDING';
            const deliveryType = order.deliveryType || 'delivery';
            const deliveryLabel = deliveryType === 'pickup' ? 'Самовывоз' : 'Доставка';

            html += `
                <div class="order-card ${this.editMode ? 'order-card-edit' : ''}" ${this.editMode ? `onclick="Profile.toggleOrderSelection(${idx})"` : ''}>
                    ${this.editMode ? `<div class="order-checkbox">${checked ? '<i data-lucide="check-circle" style="width:22px;height:22px;color:var(--accent);"></i>' : '<i data-lucide="circle" style="width:22px;height:22px;color:var(--border);"></i>'}</div>` : ''}
                    <div class="order-header">
                        <div class="order-number">Заказ #AP-${String(orderNum).padStart(6, '0')}</div>
                        <span class="order-status ${status.class}">${status.text}</span>
                    </div>
                    <div class="order-date">${order.date} · ${deliveryLabel}</div>
                    <div class="order-items">${itemsSummary}</div>
                    <div class="order-payment-status">${this.getPaymentStatusText(paymentStatus)}</div>
                    <div class="order-footer">
                        <div>
                            <div class="order-total">${order.total.toLocaleString()} руб.</div>
                            <div class="order-count">${order.items.length} ${order.items.length === 1 ? 'товар' : 'товара'}</div>
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
