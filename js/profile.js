// Профиль и бонусная система
const Profile = {
    totalSpent: 0,
    orderHistory: [],

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

    getDiscount() {
        if (this.totalSpent >= 40000) return 12;
        if (this.totalSpent >= 15000) return 8;
        if (this.totalSpent >= 5000) return 5;
        return 3;
    },

    getStatus() {
        if (this.totalSpent >= 40000) return 'Платиновый';
        if (this.totalSpent >= 15000) return 'Золотой';
        if (this.totalSpent >= 5000) return 'Серебряный';
        return 'Начальный';
    },

    getNextLevelAmount() {
        if (this.totalSpent >= 40000) return 0;
        if (this.totalSpent >= 15000) return 40000;
        if (this.totalSpent >= 5000) return 15000;
        return 5000;
    },

    getProgress() {
        if (this.totalSpent >= 40000) return 100;
        if (this.totalSpent >= 15000) return ((this.totalSpent - 15000) / 25000) * 100;
        if (this.totalSpent >= 5000) return ((this.totalSpent - 5000) / 10000) * 100;
        return (this.totalSpent / 5000) * 100;
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
        document.getElementById('cardDiscountValue').textContent = this.getDiscount() + '%';
        document.getElementById('loyaltyStatus').textContent = this.getStatus();
        const next = this.getNextLevelAmount();
        document.getElementById('loyaltyNext').textContent = next > 0 ? next.toLocaleString() + ' ₽' : 'MAX';
        document.getElementById('loyaltyProgress').style.width = Math.min(this.getProgress(), 100) + '%';
    },

    renderOrderHistory() {
        const container = document.getElementById('orderHistoryList');
        if (!container) return;

        if (this.orderHistory.length === 0) {
            container.innerHTML = '<div class="empty-state"><i data-lucide="package" style="width:48px;height:48px;color:#ccc;"></i><p>У вас пока нет заказов</p><p style="font-size:13px;color:var(--text-muted);">Оформите первый заказ в каталоге</p></div>';
            if (typeof lucide !== 'undefined') lucide.createIcons();
            return;
        }

        let html = '';
        this.orderHistory.forEach((order, idx) => {
            const orderNum = this.orderHistory.length - idx;
            const itemsSummary = order.items.map(i => i.name).join(', ');
            const statusClass = 'order-status-new';
            const statusText = 'Новый';

            html += `
                <div class="order-card">
                    <div class="order-header">
                        <div class="order-number">Заказ #AP-${String(orderNum).padStart(6, '0')}</div>
                        <span class="${statusClass}">${statusText}</span>
                    </div>
                    <div class="order-date">${order.date}</div>
                    <div class="order-items">${itemsSummary}</div>
                    <div class="order-footer">
                        <div class="order-total">${order.total.toLocaleString()} руб.</div>
                        <div class="order-count">${order.items.length} ${order.items.length === 1 ? 'товар' : 'товара'}</div>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
};
