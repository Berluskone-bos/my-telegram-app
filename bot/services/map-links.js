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
    static yandexRoute(stops, origin = null) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://yandex.ru/maps/';
        const destinations = stops.map(s => `${s.lat},${s.lon}`);
        if (origin !== null && origin !== undefined && String(origin).trim()) {
            const start = typeof origin === 'object' ? `${origin.lat},${origin.lon}` : String(origin).trim();
            return `https://yandex.ru/maps/?rtext=${[start, ...destinations].map(encodeURIComponent).join('~')}&rtt=auto`;
        }
        return `https://yandex.ru/maps/?rtext=~${destinations.join('~')}&rtt=auto`;
    }

    // Google Maps без origin использует текущее местоположение устройства.
    // Все адреса клиентов сохраняются: промежуточные — waypoints, последний — destination.
    static googleRoute(stops, origin = null) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://www.google.com/maps/';
        const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lon}`;
        const waypoints = stops.slice(0, -1).map(s => `${s.lat},${s.lon}`);
        let url = 'https://www.google.com/maps/dir/?api=1';
        if (origin !== null && origin !== undefined && String(origin).trim()) {
            const start = typeof origin === 'object' ? `${origin.lat},${origin.lon}` : String(origin).trim();
            url += `&origin=${encodeURIComponent(start)}`;
        }
        url += `&destination=${destination}`;
        if (waypoints.length) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
        return url;
    }

    // Актуальный deeplink 2GIS: пустая точка A — старт с текущей геопозиции.
    // Каждая следующая пара координат — адрес доставки, порядок lon,lat.
    static gis2Route(stops, origin = null) {
        if (!Array.isArray(stops) || stops.length === 0) return 'https://2gis.ru/directions/tab/car';
        const destinations = stops.map(s => `${s.lon},${s.lat}`);
        if (origin && typeof origin === 'object' && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lon))) {
            destinations.unshift(`${origin.lon},${origin.lat}`);
        }
        return `https://2gis.ru/directions/points/|${destinations.join('|')}`;
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
    static allRoute(stops, origin = null) {
        return {
            yandex: MapLinks.yandexRoute(stops, origin),
            google: MapLinks.googleRoute(stops, origin),
            gis2: MapLinks.gis2Route(stops, origin)
        };
    }
}

module.exports = MapLinks;
