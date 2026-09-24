import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const TTL_MS = 10 * 60_000;
const GEO_TTL_MS = 7 * 86_400_000;

// WMO 天气代码 → 中文
export const WMO_TEXT = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴有冰雹', 99: '强雷阵雨伴有冰雹',
};
export const wmoText = (code) => WMO_TEXT[code] ?? '未知';

const DIRS = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];
export const windDirText = (deg) => (deg == null ? null : DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);
// km/h → 蒲福风级
const BEAUFORT_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
export function windScale(kmh) {
  if (kmh == null) return null;
  const i = BEAUFORT_KMH.findIndex((v) => kmh < v);
  return String(i === -1 ? 12 : i);
}

// ---------- Open-Meteo ----------
export function parseOpenMeteoGeo(raw) {
  const r = raw?.results?.[0];
  if (!r) return null;
  return {
    name: r.name,
    admin: [r.admin1, r.admin2].filter(Boolean).join(' '),
    country: r.country ?? null,
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone ?? null,
  };
}

export function parseOpenMeteoForecast(raw, location) {
  const c = raw?.current;
  const d = raw?.daily;
  if (!c || !d || !Array.isArray(d.time)) throw new HttpError(502, 'Open-Meteo 返回的数据格式无法识别');
  return {
    provider: 'open-meteo',
    location: { ...location, timezone: raw.timezone ?? location.timezone ?? null },
    current: {
      time: c.time,
      temp: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      weather: wmoText(c.weather_code),
      code: String(c.weather_code),
      isDay: c.is_day == null ? null : c.is_day === 1,
      windDir: windDirText(c.wind_direction_10m),
      windScale: windScale(c.wind_speed_10m),
      windSpeed: c.wind_speed_10m,
      precip: c.precipitation,
      pressure: c.pressure_msl ?? null,
    },
    daily: d.time.map((date, i) => ({
      date,
      weather: wmoText(d.weather_code?.[i]),
      weatherNight: null,
      code: String(d.weather_code?.[i]),
      tempMax: d.temperature_2m_max?.[i],
      tempMin: d.temperature_2m_min?.[i],
      precip: d.precipitation_sum?.[i] ?? null,
      precipProb: d.precipitation_probability_max?.[i] ?? null,
      windDir: windDirText(d.wind_direction_10m_dominant?.[i]),
      windScale: windScale(d.wind_speed_10m_max?.[i]),
      uvIndex: d.uv_index_max?.[i] ?? null,
      sunrise: d.sunrise?.[i]?.slice(11) ?? null,
      sunset: d.sunset?.[i]?.slice(11) ?? null,
    })),
  };
}

async function openMeteoGeocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const res = await cache.wrap(`weather:geo:om:${city}`, GEO_TTL_MS, async () => parseOpenMeteoGeo(await fetchJSON(url)));
  if (!res.data) throw new HttpError(404, `找不到城市：${city}`);
  return res.data;
}

async function openMeteoWeather(location) {
  const qs = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '7',
  });
  return parseOpenMeteoForecast(await fetchJSON(`https://api.open-meteo.com/v1/forecast?${qs}`), location);
}

// ---------- 和风天气 QWeather ----------
// 新账号使用专属 API Host（形如 xxx.re.qweatherapi.com，同时提供 geo 与 v7）；未配置时使用旧公共域名
function qweatherHosts() {
  const custom = process.env.QWEATHER_HOST?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return custom ? { geo: custom, api: custom } : { geo: 'geoapi.qweather.com', api: 'devapi.qweather.com' };
}
async function qweatherGet(host, path, params) {
  const key = process.env.QWEATHER_KEY;
  const qs = new URLSearchParams({ ...params, key, lang: 'zh' });
  const raw = await fetchJSON(`https://${host}${path}?${qs}`, { headers: { 'X-QW-Api-Key': key } });
  if (raw?.code !== '200') {
    if (raw?.code === '404' || raw?.code === '204') throw new HttpError(404, '和风天气：未找到该地区');
    throw new HttpError(502, `和风天气返回错误码 ${raw?.code ?? '未知'}`);
  }
  return raw;
}

export function parseQWeatherGeo(raw) {
  const r = raw?.location?.[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    admin: [r.adm1, r.adm2].filter((x, i, a) => x && a.indexOf(x) === i).join(' '),
    country: r.country ?? null,
    lat: Number(r.lat),
    lon: Number(r.lon),
    timezone: r.tz ?? null,
  };
}

const num = (v) => (v == null || v === '' ? null : Number(v));
export function parseQWeather(now, daily, location) {
  const n = now?.now;
  if (!n || !Array.isArray(daily?.daily)) throw new HttpError(502, '和风天气返回的数据格式无法识别');
  return {
    provider: 'qweather',
    location,
    current: {
      time: n.obsTime,
      temp: num(n.temp),
      feelsLike: num(n.feelsLike),
      humidity: num(n.humidity),
      weather: n.text,
      code: n.icon,
      isDay: null,
      windDir: n.windDir,
      windScale: n.windScale,
      windSpeed: num(n.windSpeed),
      precip: num(n.precip),
      pressure: num(n.pressure),
    },
    daily: daily.daily.map((d) => ({
      date: d.fxDate,
      weather: d.textDay,
      weatherNight: d.textNight,
      code: d.iconDay,
      tempMax: num(d.tempMax),
      tempMin: num(d.tempMin),
      precip: num(d.precip),
      precipProb: null,
      windDir: d.windDirDay,
      windScale: d.windScaleDay,
      uvIndex: num(d.uvIndex),
      sunrise: d.sunrise || null,
      sunset: d.sunset || null,
    })),
  };
}

async function qweatherGeocode(city) {
  const { geo } = qweatherHosts();
  const res = await cache.wrap(`weather:geo:qw:${city}`, GEO_TTL_MS, async () =>
    parseQWeatherGeo(await qweatherGet(geo, '/geo/v2/city/lookup', { location: city, number: '1' })));
  if (!res.data) throw new HttpError(404, `找不到城市：${city}`);
  return res.data;
}

async function qweatherWeather(location) {
  const { api } = qweatherHosts();
  const loc = location.id ?? `${location.lon.toFixed(2)},${location.lat.toFixed(2)}`;
  const [now, daily] = await Promise.all([
    qweatherGet(api, '/v7/weather/now', { location: loc }),
    qweatherGet(api, '/v7/weather/7d', { location: loc }),
  ]);
  return parseQWeather(now, daily, location);
}

// 供推送复用：loadWeather({ city }) 或 loadWeather({ lat, lon })
export async function loadWeather({ city, lat, lon }) {
  const useQ = Boolean(process.env.QWEATHER_KEY);
  const coordLoc = lat != null ? { name: `${lat},${lon}`, admin: '', country: null, lat, lon, timezone: null } : null;
  const key = `weather:${useQ ? 'qw' : 'om'}:${coordLoc ? `${lat.toFixed(2)},${lon.toFixed(2)}` : city}`;
  return cache.wrap(key, TTL_MS, async () => {
    if (useQ) return qweatherWeather(coordLoc ?? (await qweatherGeocode(city)));
    return openMeteoWeather(coordLoc ?? (await openMeteoGeocode(city)));
  });
}

export default {
  name: 'weather',
  category: 'life',
  title: '天气预报',
  description: '实时天气与未来 7 天预报，默认 Open-Meteo，配置和风天气 Key 后自动切换',
  source: 'Open-Meteo / 和风天气',
  env: [{ name: 'QWEATHER_KEY', optional: true }],
  routes: [
    {
      method: 'GET',
      path: '/api/weather',
      summary: '查询实时天气与 7 天预报',
      params: [
        { name: 'city', default: '北京', desc: '城市名（与 lat/lon 二选一）', example: '上海' },
        { name: 'lat', desc: '纬度，-90~90', example: '31.23' },
        { name: 'lon', desc: '经度，-180~180', example: '121.47' },
      ],
      async handler({ query }) {
        const latRaw = query.get('lat');
        const lonRaw = query.get('lon');
        if (latRaw || lonRaw) {
          const lat = Number(latRaw);
          const lon = Number(lonRaw);
          if (!latRaw || !lonRaw || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            throw new HttpError(400, 'lat/lon 须同时提供且为有效经纬度');
          }
          return loadWeather({ lat, lon });
        }
        const city = param(query, 'city', { default: '北京', max: 30 }).trim();
        if (!city) throw new HttpError(400, 'city 不能为空');
        return loadWeather({ city });
      },
    },
  ],
};
