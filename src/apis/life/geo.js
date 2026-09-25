import { HttpError, param } from '../../lib/http.js';
import { num, round } from './calc-util.js';

export const EARTH_RADIUS_M = 6371008.8; // IUGG 地球平均半径（米）
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

// Haversine 大圆距离（米）
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 起点到终点的初始方位角（度，正北为 0，顺时针）
export function initialBearing(lat1, lon1, lat2, lon2) {
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const compassOf = (bearing) => COMPASS[Math.round(bearing / 45) % 8];

export function geoDistance(lat1, lon1, lat2, lon2, withBearing = true) {
  const meters = haversine(lat1, lon1, lat2, lon2);
  const same = meters < 1e-6;
  const b = withBearing && !same ? initialBearing(lat1, lon1, lat2, lon2) : null;
  return {
    from: { lat: lat1, lon: lon1 },
    to: { lat: lat2, lon: lon2 },
    meters: round(meters, 1),
    kilometers: round(meters / 1000, 3),
    miles: round(meters / 1609.344, 3),
    nauticalMiles: round(meters / 1852, 3),
    bearing: b == null ? null : round(b, 2),
    direction: b == null ? null : compassOf(b),
  };
}

export default {
  name: 'geo',
  category: 'life',
  title: '经纬度距离',
  description: '用 Haversine 公式计算两个经纬度坐标之间的球面距离，可附带起点到终点的方位角',
  source: '本地计算（Haversine 公式，地球平均半径 6371.0088 km）',
  routes: [
    {
      method: 'GET',
      path: '/api/geo/distance',
      summary: '两点经纬度球面距离与方位角',
      params: [
        { name: 'lat1', required: true, desc: '起点纬度（-90~90，北纬为正，WGS-84）', example: '39.9042' },
        { name: 'lon1', required: true, desc: '起点经度（-180~180，东经为正）', example: '116.4074' },
        { name: 'lat2', required: true, desc: '终点纬度（-90~90）', example: '31.2304' },
        { name: 'lon2', required: true, desc: '终点经度（-180~180）', example: '121.4737' },
        { name: 'bearing', default: '1', desc: '是否计算方位角：1 计算（默认），0 不计算（bearing、direction 返回 null）', example: '1' },
      ],
      fields: [
        { name: 'from', type: 'object', desc: '起点坐标' },
        { name: 'from.lat', type: 'number', desc: '起点纬度' },
        { name: 'from.lon', type: 'number', desc: '起点经度' },
        { name: 'to', type: 'object', desc: '终点坐标' },
        { name: 'to.lat', type: 'number', desc: '终点纬度' },
        { name: 'to.lon', type: 'number', desc: '终点经度' },
        { name: 'meters', type: 'number', desc: '球面距离（米，保留 1 位小数）。把地球视为球体，与椭球大地线距离的误差一般在 0.5% 以内' },
        { name: 'kilometers', type: 'number', desc: '球面距离（千米，保留 3 位小数）' },
        { name: 'miles', type: 'number', desc: '球面距离（英里，保留 3 位小数）' },
        { name: 'nauticalMiles', type: 'number', desc: '球面距离（海里，保留 3 位小数）' },
        { name: 'bearing', type: 'number|null', desc: '起点到终点的初始方位角（度，0~360，正北为 0、顺时针，保留 2 位小数）；bearing=0 或两点重合时为 null' },
        { name: 'direction', type: 'string|null', desc: '方位角对应的八方位中文，如 东南；bearing 为 null 时为 null' },
      ],
      async handler({ query }) {
        const lat = (n) => num(query, n, { required: true, min: -90, max: 90, unit: '纬度' });
        const lon = (n) => num(query, n, { required: true, min: -180, max: 180, unit: '经度' });
        const withBearing = param(query, 'bearing', { default: '1', oneOf: ['0', '1', 'true', 'false'] });
        if (!query.get('lat1') && query.get('lat')) throw new HttpError(400, '请使用 lat1、lon1、lat2、lon2 四个参数');
        return { data: geoDistance(lat('lat1'), lon('lon1'), lat('lat2'), lon('lon2'), withBearing === '1' || withBearing === 'true') };
      },
    },
  ],
};
