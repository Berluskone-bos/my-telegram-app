// Telegram WebApp инициализация
const TelegramApp = {
    init() {
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();
        return tg;
    },

    getUser(tg) {
        if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
            return tg.initDataUnsafe.user;
        }
        return null;
    },

    getUserName(user) {
        if (!user) return 'Покупатель';
        return ((user.first_name || '') + ' ' + (user.last_name || '')).trim() || 'Покупатель';
    },

    getUserInitial(user) {
        if (user && user.first_name) {
            return user.first_name.charAt(0).toUpperCase();
        }
        return 'U';
    },

    // Отправка заказа через Telegram WebApp
    sendOrder(orderData) {
        const tg = window.Telegram.WebApp;
        tg.sendData(JSON.stringify(orderData));
    },

    // Закрытие приложения
    close() {
        window.Telegram.WebApp.close();
    }
};
