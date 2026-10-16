import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { sql,db } from '../db.js';
import { HttpError } from './http.js';

export const TRAFFIC_SCOPES={business:'业务',internal:'内部测试',all:'全部'};
const context=new AsyncLocalStorage();
export function parseTrafficScope(value) {
  const scope=value || 'business';
  if(!Object.hasOwn(TRAFFIC_SCOPES,scope))throw new HttpError(400,'traffic 只能是 business / internal / all');
  return scope;
}
export const currentTrafficScope=()=>context.getStore() || 'business';
export const withTrafficScope=(scope,fn)=>{const parsed=parseTrafficScope(scope);initializeTrafficConfiguration();return context.run(parsed,fn);};
const tables=/\b(request_log|source_daily|stats_hourly|stats_daily|stats_limited|stats_day_meta|api_calls|user_calls_daily)\b/g;
export function trafficSql(text) {
  const scope=currentTrafficScope();
  return sql(scope==='all'?text:text.replace(tables,table=>`traffic_${scope}_${table}`));
}

let loaded=null,users=new Set(),keys=new Map(),invalidUsers=[],invalidKeys=[];
function ids(raw) {
  if(!raw?.trim())return [];
  const list=raw.split(/[\s,]+/).filter(Boolean);
  if(list.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<1))throw new Error('内部统计配置只接受正整数账号/Key ID');
  return [...new Set(list.map(Number))];
}
const fingerprint=k=>createHash('sha256').update(JSON.stringify([k.id,k.user_id,k.created_at,k.key_hash])).digest('hex');
export function initializeTrafficConfiguration({force=false}={}) {
  const input=JSON.stringify([process.env.STATS_INTERNAL_USER_IDS||'',process.env.STATS_INTERNAL_KEY_IDS||'']);
  if(!force&&loaded===input)return;
  const [userIds,keyIds]=JSON.parse(input).map(ids),nextUsers=new Set(),nextKeys=new Map(),badUsers=[],badKeys=[];
  db.exec('SAVEPOINT traffic_config');
  try {
    sql('DELETE FROM traffic_config_users').run();
    const selectedKeys=new Set(keyIds);
    for(const row of sql('SELECT key_id FROM traffic_key_bindings').all())if(!selectedKeys.has(row.key_id))sql('DELETE FROM traffic_key_bindings WHERE key_id=?').run(row.key_id);
    for(const id of userIds) {
      if(!sql('SELECT 1 FROM users WHERE id=?').get(id)){badUsers.push(id);continue;}
      nextUsers.add(id);sql('INSERT INTO traffic_config_users VALUES(?)').run(id);
    }
    for(const id of keyIds) {
      const k=sql('SELECT id,user_id,created_at,key_hash FROM api_keys WHERE id=?').get(id);
      if(!k){badKeys.push(id);continue;}
      const hash=fingerprint(k),bound=sql('SELECT * FROM traffic_key_bindings WHERE key_id=?').get(id);
      if(bound&&(bound.user_id!==k.user_id||bound.fingerprint!==hash)){badKeys.push(id);continue;}
      if(!bound)sql('INSERT INTO traffic_key_bindings VALUES(?,?,?)').run(id,k.user_id,hash);
      nextKeys.set(id,{userId:k.user_id,fingerprint:hash});
    }
    db.exec('RELEASE traffic_config');
  } catch(err){db.exec('ROLLBACK TO traffic_config');db.exec('RELEASE traffic_config');throw err;}
  users=nextUsers;keys=nextKeys;invalidUsers=badUsers;invalidKeys=badKeys;loaded=input;
}
export function classifyTraffic(user,keyId) {
  initializeTrafficConfiguration();
  if(!user?.id || !sql('SELECT 1 FROM users WHERE id=?').get(user.id))return {traffic:'business',basis:'not_configured'};
  if(users.has(user.id))return {traffic:'internal',basis:'configured_user'};
  const binding=keys.get(keyId);
  if(binding?.userId===user.id) {
    const k=sql('SELECT id,user_id,created_at,key_hash FROM api_keys WHERE id=? AND user_id=?').get(keyId,user.id);
    if(k&&fingerprint(k)===binding.fingerprint)return {traffic:'internal',basis:'configured_key'};
  }
  return {traffic:'business',basis:'not_configured'};
}
export function trafficMetadata() {
  initializeTrafficConfiguration();
  const scope=currentTrafficScope(),startedAt=sql('SELECT started_at FROM traffic_meta WHERE id=1').get().started_at;
  return {scope,label:TRAFFIC_SCOPES[scope],startedAt,legacyIncluded:scope!=='internal',history:'旧记录未分类，保留在业务和全部中；只排除记录时明确标记的内部测试。'};
}
export function trafficConfiguration() {
  initializeTrafficConfiguration();
  return {users:[...users].map(id=>sql('SELECT id,email FROM users WHERE id=?').get(id)).filter(Boolean),
    keys:[...keys].map(([id,b])=>{const k=sql('SELECT id,user_id,name,created_at,key_hash FROM api_keys WHERE id=?').get(id);return k&&fingerprint(k)===b.fingerprint?{id:k.id,userId:k.user_id,name:k.name}:null;}).filter(Boolean),
    inactiveUserIds:invalidUsers,inactiveKeyIds:[...new Set([...invalidKeys,...[...keys].filter(([id,b])=>{const k=sql('SELECT id,user_id,created_at,key_hash FROM api_keys WHERE id=?').get(id);return !k||fingerprint(k)!==b.fingerprint;}).map(([id])=>id)])],...trafficMetadata()};
}
export function registrationClause(column='id') {
  return currentTrafficScope()==='all'?'1':`${column} ${currentTrafficScope()==='internal'?'IN':'NOT IN'} (SELECT user_id FROM traffic_config_users)`;
}
