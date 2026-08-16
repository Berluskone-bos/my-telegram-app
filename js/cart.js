// Корзина
const Cart = {
    items: [],

    load() {
        try {
            const saved = localStorage.getItem('gulf_cart');
            if (saved) this.items = JSON.parse(saved);
        } catch (e) {
            this.items = [];
        }
    },

    save() {
        localStorage.setItem('gulf_cart', JSON.stringify(this.items));
    },

    add(productId) {
        const existing = this.items.find(item => item.id === productId);
        if (existing) {
            existing.quantity += 1;
        } else {
            this.items.push({ id: productId, quantity: 1 });
        }
        this.save();
    },

    remove(productId) {
        const idx = this.items.findIndex(item => item.id === productId);
        if (idx !== -1) {
            if (this.items[idx].quantity > 1) {
                this.items[idx].quantity -= 1;
            } else {
                this.items.splice(idx, 1);
            }
            this.save();
        }
    },

    clear() {
        this.items = [];
        this.save();
    },

    getCount() {
        return this.items.reduce((sum, item) => sum + item.quantity, 0);
    },

    getTotal() {
        return this.items.reduce((sum, item) => {
            const prod = Products.getById(item.id);
            return sum + (prod ? prod.price * item.quantity : 0);
        }, 0);
    },

    isEmpty() {
        return this.items.length === 0;
    },

    render() {
        const container = document.getElementById('cartList');
        const totalEl = document.getElementById('cartTotal');

        if (this.isEmpty()) {
            container.innerHTML = '<div class="empty-state"><p>Корзина пуста</p></div>';
            totalEl.textContent = 'Итого: 0 ₽';
            return;
        }

        let html = '';
        this.items.forEach(item => {
            const prod = Products.getById(item.id);
            if (!prod) return;
            html += `
                <div class="cart-item">
                    <div class="cart-item-info">
                        <div class="cart-item-title">${prod.name}</div>
                        <div class="cart-item-volume">${prod.volume}</div>
                        <div class="cart-item-price">${(prod.price * item.quantity).toLocaleString()} ₽</div>
                    </div>
                    <div class="cart-item-actions">
                        <button onclick="App.removeFromCart(${item.id})">−</button>
                        <span class="qty">${item.quantity}</span>
                        <button onclick="App.addToCart(${item.id})">+</button>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
        totalEl.textContent = `Итого: ${this.getTotal().toLocaleString()} ₽`;
    }
};
