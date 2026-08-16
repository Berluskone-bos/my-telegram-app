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
            container.innerHTML = '<div class="empty-state"><p>История заказов пуста</p></div>';
            return;
        }

        let html = '';
        this.orderHistory.forEach((order, idx) => {
            html += `
                <div class="cart-item" style="flex-direction: column; align-items: flex-start;">
                    <div style="display: flex; justify-content: space-between; width: 100%; margin-bottom: 8px;">
                        <div style="font-weight: bold;">Заказ #${this.orderHistory.length - idx}</div>
                        <div style="color: #888; font-size: 12px;">${order.date}</div>
                    </div>
                    <div style="font-size: 13px; color: #bbb; margin-bottom: 4px;">${order.items.map(i => i.name + ' ×' + i.qty).join(', ')}</div>
                    <div style="font-weight: bold; color: #4a8bf5;">${order.total.toLocaleString()} ₽</div>
                </div>
            `;
        });
        container.innerHTML = html;
    }
};
