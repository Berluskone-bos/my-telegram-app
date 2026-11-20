// Картограф: генерация ссылок на навигаторы
// Яндекс.Карты, Google Maps, 2GIS

class MapLinks {
    // Ссылка на конкретный адрес в Яндекс.Карты
    static yandex(address, lat, lon) {
        const encoded = encodeURIComponent(address);
        if (lat && lon) {
            return `https://yandex.ru/maps/?text=${encoded}&rtext=${lat},${lon}`;
        }
        return `https://yandex.ru/maps/?text=${encoded}`;
    }

    // Ссылка на точку в Google Maps
    static google(lat, lon) {
        return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    }

    // Ссылка на точку в 2GIS (формат lon,lat — обратный порядок!)
    static gis2(lat, lon) {
        return `https://2gis.ru/geo/${lon},${lat}`;
    }

    // Маршрут начинается от текущего местоположения пользователя.
    // Первая координата — уже точка доставки, а не фиктивная точка отправления.
    static yandexRoute(stops) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://yandex.ru/maps/';
        const destinations = stops.map(s => `${s.lat},${s.lon}`).join('~');
        return `https://yandex.ru/maps/?rtext=~${destinations}&rtt=auto`;
    }

    // Google Maps без origin использует текущее местоположение устройства.
    // Все адреса клиентов сохраняются: промежуточные — waypoints, последний — destination.
    static googleRoute(stops) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://www.google.com/maps/';
        const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lon}`;
        const waypoints = stops.slice(0, -1).map(s => `${s.lat},${s.lon}`);
        let url = `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
        if (waypoints.length) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
        return url;
    }

    // 2GIS: пустая начальная точка означает старт от текущего местоположения.
    static gis2Route(stops) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://2gis.ru/';
        const destinations = stops.map(s => `${s.lon},${s.lat}`).join('~');
        return `https://2gis.ru/directions/tab/car?r=~${destinations}`;
    }

    // Все три навигатора для одной точки
    static all(address, lat, lon) {
        return {
            yandex: MapLinks.yandex(address, lat, lon),
            google: MapLinks.google(lat, lon),
            gis2: MapLinks.gis2(lat, lon)
        };
    }

    // Все три навигатора для маршрута
    static allRoute(stops) {
        return {
            yandex: MapLinks.yandexRoute(stops),
            google: MapLinks.googleRoute(stops),
            gis2: MapLinks.gis2Route(stops)
        };
    }
}

module.exports = MapLinks;
