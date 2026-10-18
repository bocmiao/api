import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mock } from 'node:test';

// 将已有 fixture fetch 转为原生 request 响应；不访问真实上游。
export function mockCustomUpstream(fetchFixture) {
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      queueMicrotask(async () => {
        try {
          const response = await fetchFixture(String(url), { ...options, body });
          const res = Readable.from([Buffer.from(await response.arrayBuffer())]);
          res.statusCode = response.status;
          res.headers = Object.fromEntries(response.headers.entries());
          callback(res);
        } catch (err) { req.emit('error', err); }
      });
    };
    return req;
  };
  mock.method(http, 'request', request);
  mock.method(https, 'request', request);
}
