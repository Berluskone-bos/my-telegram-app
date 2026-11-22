const NOT_REGISTERED = 'Вы ещё не зарегистрированы как курьер. Для подачи заявки отправьте /start.';
const ARCHIVED = 'Ваш аккаунт курьера отключён. Доступ к маршрутам закрыт. Для восстановления доступа обратитесь к администратору.';
const INACTIVE = 'Ваш аккаунт курьера ещё не активирован или временно отключён. Обратитесь к администратору.';

function getCourierAccessMessage(courier) {
    if (!courier) return NOT_REGISTERED;
    if (courier.archived_at) return ARCHIVED;
    if (!courier.is_active) return INACTIVE;
    return null;
}

module.exports = { getCourierAccessMessage };
