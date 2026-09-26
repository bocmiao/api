import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const TTL_MS = 10 * 60_000;
const GEO_TTL_MS = 7 * 86_400_000;
const SEARCH_TTL_MS = 86_400_000;
const CANDIDATES = 5; // 按城市名查询时额外返回的重名候选数
const ID_RE = /^[A-Za-z0-9]{1,20}$/;

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
  return omLocation(r);
}
function omLocation(r) {
  return {
    ...(r.id == null ? {} : { id: String(r.id) }),
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
      code: c.weather_code == null ? null : String(c.weather_code),
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
      code: d.weather_code?.[i] == null ? null : String(d.weather_code[i]),
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

// 城市搜索的统一候选结构（两种数据源字段一致，缺的为 null）
const str = (v) => (v == null || v === '' ? null : String(v));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export function parseOpenMeteoSearch(raw) {
  return (raw?.results ?? []).map((r) => ({
    id: String(r.id),
    name: r.name,
    adm1: str(r.admin1),
    adm2: str(r.admin2),
    adm3: str(r.admin3),
    country: str(r.country),
    countryCode: str(r.country_code),
    lat: numOrNull(r.latitude),
    lon: numOrNull(r.longitude),
    timezone: str(r.timezone),
    type: str(r.feature_code),
    population: numOrNull(r.population),
  }));
}
export function parseQWeatherSearch(raw) {
  return (raw?.location ?? []).map((r) => ({
    id: String(r.id),
    name: r.name,
    adm1: str(r.adm1),
    adm2: str(r.adm2),
    adm3: null,
    country: str(r.country),
    countryCode: null,
    lat: numOrNull(r.lat),
    lon: numOrNull(r.lon),
    timezone: str(r.tz),
    type: str(r.type),
    population: null,
  }));
}
// 重名候选：除第一个外最多 CANDIDATES 个
const toCandidates = (items) => items.slice(1, 1 + CANDIDATES).map(({ id, name, adm1, adm2, country }) => ({ id, name, adm1, adm2, country }));

// Open-Meteo /v1/get 直接返回地点对象（兼容包在 results 里的情况）
export function parseOpenMeteoGet(raw) {
  const r = raw?.results?.[0] ?? raw;
  if (!r || r.error || r.latitude == null || r.longitude == null) return null;
  return omLocation(r);
}

async function openMeteoGeocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=${1 + CANDIDATES}&language=zh&format=json`;
  const res = await cache.wrap(`weather:geo:om:${city}`, GEO_TTL_MS, async () => {
    const raw = await fetchJSON(url);
    const location = parseOpenMeteoGeo(raw);
    return location && { location, candidates: toCandidates(parseOpenMeteoSearch(raw)) };
  });
  if (!res.data) throw new HttpError(404, `找不到城市：${city}`);
  return res.data;
}

async function openMeteoById(id) {
  const url = `https://geocoding-api.open-meteo.com/v1/get?id=${encodeURIComponent(id)}&language=zh&format=json`;
  const res = await cache.wrap(`weather:geoid:om:${id}`, GEO_TTL_MS, async () => parseOpenMeteoGet(await fetchJSON(url)));
  if (!res.data) throw new HttpError(404, `找不到该城市编号：${id}`);
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
  const res = await cache.wrap(`weather:geo:qw:${city}`, GEO_TTL_MS, async () => {
    const raw = await qweatherGet(geo, '/geo/v2/city/lookup', { location: city, number: String(1 + CANDIDATES) });
    const location = parseQWeatherGeo(raw);
    return location && { location, candidates: toCandidates(parseQWeatherSearch(raw)) };
  });
  if (!res.data) throw new HttpError(404, `找不到城市：${city}`);
  return res.data;
}

// 和风 GeoAPI 的 location 参数也接受 LocationID，用来补全地点名称、行政区和时区
async function qweatherById(id) {
  const { geo } = qweatherHosts();
  const res = await cache.wrap(`weather:geoid:qw:${id}`, GEO_TTL_MS, async () =>
    parseQWeatherGeo(await qweatherGet(geo, '/geo/v2/city/lookup', { location: id, number: '1' })));
  if (!res.data) throw new HttpError(404, `找不到该城市编号：${id}`);
  return res.data;
}

// 城市搜索：配置和风时用和风 GeoAPI，否则用 Open-Meteo geocoding；结果缓存 1 天
export async function searchCity(q, limit = 10) {
  const useQ = Boolean(process.env.QWEATHER_KEY);
  const provider = useQ ? 'qweather' : 'open-meteo';
  return cache.wrap(`weather:search:${useQ ? 'qw' : 'om'}:${limit}:${q}`, SEARCH_TTL_MS, async () => {
    let items;
    if (useQ) {
      try {
        items = parseQWeatherSearch(await qweatherGet(qweatherHosts().geo, '/geo/v2/city/lookup', { location: q, number: String(limit) }));
      } catch (err) {
        if (err.status !== 404) throw err;
        items = [];
      }
    } else {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${limit}&language=zh&format=json`;
      items = parseOpenMeteoSearch(await fetchJSON(url));
    }
    return { provider, query: q, count: Math.min(items.length, limit), items: items.slice(0, limit) };
  });
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

function gridLoc(lat, lon) {
  const la = Math.round(lat * 100) / 100;
  const lo = Math.round(lon * 100) / 100;
  return { name: `${la},${lo}`, admin: '', country: null, lat: la, lon: lo, timezone: null };
}

// 供推送复用：loadWeather({ city })、loadWeather({ id }) 或 loadWeather({ lat, lon })
// 返回的 data 总带 candidates（按城市名查询时为其他重名候选，其余情况为空数组）
export async function loadWeather({ city, id, lat, lon }) {
  const useQ = Boolean(process.env.QWEATHER_KEY);
  // 经纬度按 2 位小数（约 1 公里）取整后查询和缓存，同一网格内的请求返回一致的坐标
  const coordLoc = lat != null ? gridLoc(lat, lon) : null;
  const target = coordLoc ? coordLoc.name : id != null ? `id:${id}` : city;
  const key = `weather:${useQ ? 'qw' : 'om'}:${target}`;
  return cache.wrap(key, TTL_MS, async () => {
    let location = coordLoc;
    let candidates = [];
    if (!location && id != null) location = useQ ? await qweatherById(id) : await openMeteoById(id);
    if (!location) ({ location, candidates } = useQ ? await qweatherGeocode(city) : await openMeteoGeocode(city));
    const w = useQ ? await qweatherWeather(location) : await openMeteoWeather(location);
    return { ...w, candidates };
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
        { name: 'city', default: '北京', desc: '城市名（city / id / lat+lon 三选一）。重名时取地理编码的第一个结果，其他候选见返回的 candidates', example: '上海' },
        { name: 'id', desc: '城市编号（city / id / lat+lon 三选一），取自 /api/weather/city 的 items[].id：配置和风天气时为和风 LocationID，否则为 Open-Meteo（GeoNames）编号。编号只在对应数据源有效，服务端切换数据源后需重新搜索', example: '1816670' },
        { name: 'lat', desc: '纬度，-90~90（与 lon 同时提供）', example: '31.23' },
        { name: 'lon', desc: '经度，-180~180（与 lat 同时提供）', example: '121.47' },
      ],
      fields: [
        { name: 'provider', type: 'string', desc: '实际使用的数据源：open-meteo（默认）或 qweather（服务端配置了和风天气 Key 时）。两者输出结构相同，个别字段只有其中一方有值，见各字段说明' },
        { name: 'location', type: 'object', desc: '查询地点' },
        { name: 'location.id', type: 'string', desc: '城市编号，可作为下次请求的 id 参数：qweather 为和风天气 LocationID（如 101010100），open-meteo 为 GeoNames 编号（如 1816670）。按城市名或 id 查询时有；按经纬度查询时没有此字段' },
        { name: 'location.name', type: 'string', desc: '地点名称（如 北京市）；按经纬度查询时为 "纬度,经度" 形式的字符串（保留 2 位小数）' },
        { name: 'location.admin', type: 'string', desc: '上级行政区，空格分隔、已去重（如 "北京市 北京"）；按经纬度查询或上游未提供时为空字符串' },
        { name: 'location.country', type: 'string|null', desc: '国家名称（如 中国）；按经纬度查询时为 null' },
        { name: 'location.lat', type: 'number', desc: '纬度（十进制度，北纬为正）。按城市查询时为地理编码得到的城市坐标，按经纬度查询时为传入值四舍五入到 2 位小数（约 1 公里精度）' },
        { name: 'location.lon', type: 'number', desc: '经度（十进制度，东经为正）' },
        { name: 'location.timezone', type: 'string|null', desc: '地点所在时区（IANA 名称，如 Asia/Shanghai），current.time 与 daily 的日期、日出日落都按该时区。open-meteo 总有值；qweather 按经纬度查询时为 null' },
        { name: 'current', type: 'object', desc: '实时天气' },
        { name: 'current.time', type: 'string', desc: '观测/数据时间，当地时间。open-meteo 为 YYYY-MM-DDTHH:mm，不带时区偏移（时区见 location.timezone）；qweather 为带偏移的 YYYY-MM-DDTHH:mm+08:00' },
        { name: 'current.temp', type: 'number|null', desc: '气温，单位 ℃' },
        { name: 'current.feelsLike', type: 'number|null', desc: '体感温度，单位 ℃' },
        { name: 'current.humidity', type: 'number|null', desc: '相对湿度，单位 %（0–100）' },
        { name: 'current.weather', type: 'string', desc: '天气现象中文描述（如 多云、小雨）。open-meteo 由 WMO 代码换算，遇到未收录的代码为"未知"；qweather 为上游原文' },
        { name: 'current.code', type: 'string|null', desc: '天气代码（字符串，上游缺失时为 null）。open-meteo 为 WMO 代码：0 晴、1 晴间多云、2 多云、3 阴、45 雾、48 雾凇、51 小毛毛雨、53 毛毛雨、55 大毛毛雨、56 冻毛毛雨、57 强冻毛毛雨、61 小雨、63 中雨、65 大雨、66 冻雨、67 强冻雨、71 小雪、73 中雪、75 大雪、77 雪粒、80 小阵雨、81 阵雨、82 强阵雨、85 阵雪、86 强阵雪、95 雷阵雨、96 雷阵雨伴有冰雹、99 强雷阵雨伴有冰雹。qweather 为和风天气图标代码：1xx 晴/云（100 晴、101 多云、102 少云、103 晴间多云、104 阴，150–153 为对应的夜间图标），3xx 雨，4xx 雪，5xx 雾/霾/沙尘，900 热、901 冷、999 未知' },
        { name: 'current.isDay', type: 'boolean|null', desc: '仅 open-meteo 有值：true 为白天、false 为夜间（按当地日出日落）；qweather 恒为 null' },
        { name: 'current.windDir', type: 'string|null', desc: '风向（风的来向）。open-meteo 由风向角换算为 8 个方位之一：北风、东北风、东风、东南风、南风、西南风、西风、西北风，缺少数据时为 null；qweather 为上游原文（如 西南风，也可能是"无持续风向""旋转风"）' },
        { name: 'current.windScale', type: 'string|null', desc: '风力等级（蒲福风级），字符串。open-meteo 由风速换算为 "0"–"12"，缺少数据时为 null；qweather 为上游原值（如 "2"）' },
        { name: 'current.windSpeed', type: 'number|null', desc: '风速，单位 km/h（公里/小时，两种数据源相同）' },
        { name: 'current.precip', type: 'number|null', desc: '降水量，单位 mm。open-meteo 为最近一个数据间隔（通常 15 分钟）的累计值；qweather 为过去 1 小时的累计值' },
        { name: 'current.pressure', type: 'number|null', desc: '气压，单位 hPa（百帕）。open-meteo 为海平面气压；qweather 为上游大气压。上游缺失时为 null' },
        { name: 'daily', type: 'array', desc: '未来 7 天逐日预报（第一项为今天，按日期升序）' },
        { name: 'daily[].date', type: 'string', desc: '日期，YYYY-MM-DD（当地日期）' },
        { name: 'daily[].weather', type: 'string', desc: '当天天气中文描述。open-meteo 为当天最严重的天气现象，由 WMO 代码换算；qweather 为白天天气' },
        { name: 'daily[].weatherNight', type: 'string|null', desc: '仅 qweather 有值：夜间天气中文描述；open-meteo 恒为 null' },
        { name: 'daily[].code', type: 'string|null', desc: '天气代码，含义同 current.code，上游缺失时为 null。open-meteo 为当天的 WMO 代码；qweather 为白天天气图标代码' },
        { name: 'daily[].tempMax', type: 'number|null', desc: '最高气温，单位 ℃' },
        { name: 'daily[].tempMin', type: 'number|null', desc: '最低气温，单位 ℃' },
        { name: 'daily[].precip', type: 'number|null', desc: '当天总降水量，单位 mm；上游缺失时为 null' },
        { name: 'daily[].precipProb', type: 'number|null', desc: '仅 open-meteo 有值：当天最大降水概率，单位 %（0–100）；qweather 恒为 null' },
        { name: 'daily[].windDir', type: 'string|null', desc: '风向（风的来向）。open-meteo 为当天主导风向，取值同 current.windDir 的 8 个方位；qweather 为白天风向' },
        { name: 'daily[].windScale', type: 'string|null', desc: '风力等级（蒲福风级），字符串。open-meteo 由当天最大风速换算为 "0"–"12"；qweather 为白天风力，通常是范围（如 "1-3"）' },
        { name: 'daily[].uvIndex', type: 'number|null', desc: '紫外线指数。open-meteo 为当天最大值（可带小数）；qweather 为整数。上游缺失时为 null' },
        { name: 'daily[].sunrise', type: 'string|null', desc: '日出时间，HH:mm（当地时间）；极昼、极夜等没有日出或上游未提供时为 null' },
        { name: 'daily[].sunset', type: 'string|null', desc: '日落时间，HH:mm（当地时间）；没有日落或上游未提供时为 null' },
        { name: 'candidates', type: 'array', desc: `按城市名查询时，除已采用的第一个结果外的其他同名/相近地点（最多 ${CANDIDATES} 个），用于发现重名，可用其 id 重新查询；无重名或按 id、经纬度查询时为空数组` },
        { name: 'candidates[].id', type: 'string', desc: '城市编号，与 location.id 属于同一数据源（见 provider），可作为 id 参数' },
        { name: 'candidates[].name', type: 'string', desc: '地点名称' },
        { name: 'candidates[].adm1', type: 'string|null', desc: '一级行政区（省/直辖市/州），上游未提供时为 null' },
        { name: 'candidates[].adm2', type: 'string|null', desc: '二级行政区（地级市），上游未提供时为 null' },
        { name: 'candidates[].country', type: 'string|null', desc: '国家名称，上游未提供时为 null' },
      ],
      async handler({ query }) {
        const latRaw = query.get('lat');
        const lonRaw = query.get('lon');
        const idRaw = query.get('id');
        const given = [query.get('city'), idRaw, latRaw || lonRaw].filter(Boolean).length;
        if (given > 1) throw new HttpError(400, 'city、id、lat/lon 只能提供其中一种');
        if (idRaw) {
          const id = idRaw.trim();
          if (!ID_RE.test(id)) throw new HttpError(400, 'id 须为 1~20 位字母或数字');
          return loadWeather({ id });
        }
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
    {
      method: 'GET',
      path: '/api/weather/city',
      summary: '搜索城市，获取可用于天气查询的城市编号',
      params: [
        { name: 'q', required: true, desc: '城市/地区名称关键字，1~30 字（和风天气支持拼音、区县名）', example: '汝阳' },
        { name: 'limit', default: '10', desc: '返回候选数量，1~20', example: '10' },
      ],
      fields: [
        { name: 'provider', type: 'string', desc: '搜索使用的数据源，也是 items[].id 所属的服务：qweather（服务端配置了和风天气 Key，id 为和风 LocationID）或 open-meteo（默认，id 为 GeoNames 编号）。id 只能在同一数据源下传给 /api/weather' },
        { name: 'query', type: 'string', desc: '实际搜索的关键字（已去除首尾空白）' },
        { name: 'count', type: 'number', desc: '返回的候选数量；没有匹配时为 0' },
        { name: 'items', type: 'array', desc: '候选地点，按上游相关度排序（第一项即 /api/weather?city= 采用的结果）' },
        { name: 'items[].id', type: 'string', desc: '城市编号，传给 /api/weather 的 id 参数可精确查询：qweather 为 LocationID（如 101180309），open-meteo 为 GeoNames 编号（如 1786640）' },
        { name: 'items[].name', type: 'string', desc: '地点名称' },
        { name: 'items[].adm1', type: 'string|null', desc: '一级行政区（省/直辖市/州，如 河南省）；上游未提供时为 null' },
        { name: 'items[].adm2', type: 'string|null', desc: '二级行政区（地级市，如 洛阳）；上游未提供时为 null' },
        { name: 'items[].adm3', type: 'string|null', desc: '仅 open-meteo 可能有值：三级行政区（区县）；qweather 恒为 null（区县级地点本身就是 name）' },
        { name: 'items[].country', type: 'string|null', desc: '国家名称（如 中国）；上游未提供时为 null' },
        { name: 'items[].countryCode', type: 'string|null', desc: '仅 open-meteo 有值：ISO 3166-1 二位国家代码（如 CN）；qweather 恒为 null' },
        { name: 'items[].lat', type: 'number|null', desc: '纬度（十进制度，北纬为正）' },
        { name: 'items[].lon', type: 'number|null', desc: '经度（十进制度，东经为正）' },
        { name: 'items[].timezone', type: 'string|null', desc: '时区（IANA 名称，如 Asia/Shanghai）；上游未提供时为 null' },
        { name: 'items[].type', type: 'string|null', desc: '地点类型。qweather 为上游 type（如 city）；open-meteo 为 GeoNames 要素代码（如 PPLA 省会、PPLA2 地级市驻地、PPLA3 区县驻地、PPL 居民点、ADM3 区县级行政区）' },
        { name: 'items[].population', type: 'number|null', desc: '仅 open-meteo 可能有值：人口数；qweather 或上游未提供时为 null' },
      ],
      async handler({ query }) {
        const q = param(query, 'q', { required: true, max: 30 }).trim();
        if (!q) throw new HttpError(400, 'q 不能为空');
        const limit = param(query, 'limit', { default: 10, int: true, min: 1, max: 20 });
        return searchCity(q, limit);
      },
    },
  ],
};
