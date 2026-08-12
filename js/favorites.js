// Избранное
const Favorites = {
    items: new Set(),

    load() {
        try {
            const saved = localStorage.getItem('gulf_favorites');
            if (saved) this.items = new Set(JSON.parse(saved));
        } catch (e) {
            this.items = new Set();
        }
    },

    save() {
        localStorage.setItem('gulf_favorites', JSON.stringify([...this.items]));
    },

    toggle(productId) {
        if (this.items.has(productId)) {
            this.items.delete(productId);
        } else {
            this.items.add(productId);
        }
        this.save();
    },

    has(productId) {
        return this.items.has(productId);
    },

    isEmpty() {
        return this.items.size === 0;
    },

    render() {
        const container = document.getElementById('favoritesContainer');
        const favProducts = Products.getAll().filter(p => this.items.has(p.id));

        if (favProducts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span>🖤</span>
                    <p>У вас пока нет избранных товаров</p>
                </div>
            `;
            return;
        }

        let html = '<div class="products-grid" style="padding: 20px;">';
        favProducts.forEach(p => {
            html += Products.renderCard(p, true);
        });
        html += '</div>';
        container.innerHTML = html;
    }
};
