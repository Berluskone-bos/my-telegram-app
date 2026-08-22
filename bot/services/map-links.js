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

    // Маршрут через несколько точек в Яндекс.Карты
    static yandexRoute(stops) {
        const rtext = stops.map(s => `${s.lat},${s.lon}`).join('~');
        return `https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`;
    }

    // Маршрут через несколько точек в Google Maps
    static googleRoute(stops) {
        if (stops.length < 2) {
            return MapLinks.google(stops[0].lat, stops[0].lon);
        }
        const origin = `${stops[0].lat},${stops[0].lon}`;
        const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lon}`;
        const waypoints = stops.slice(1, -1).map(s => `${s.lat},${s.lon}`).join('|');

        let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`;
        if (waypoints) url += `&waypoints=${waypoints}`;
        return url;
    }

    // Маршрут через несколько точек в 2GIS
    static gis2Route(stops) {
        const rtext = stops.map(s => `${s.lon},${s.lat}`).join('~');
        return `https://2gis.ru/directions/tab/car?r=${rtext}`;
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
