'use strict';
// Only the platform receives signed payloads. Queries/building still use rpcUrl.
function platformOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的平台 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('平台地址必须是 HTTPS 域名，不能包含路径、密码或参数');
  return url.origin;
}
class RentalClient {
  constructor(origin, token = '', { fetch: transport = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.origin = platformOrigin(origin); this.token = token; this.transport = transport; this.timeoutMs = timeoutMs;
  }
  async request(path, body) {
    const response = await this.transport(this.origin + '/api/energy/device/' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // No automatic retries: a lost response can already represent a supplier call.
    const text = await response.text();
    if (text.length > 262144) throw new Error('平台响应过大');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('平台返回了无效响应'); }
    if (!response.ok) {
      const detail = data.detail || data.error || '平台暂不可用';
      throw Object.assign(new Error(typeof detail === 'string' ? detail.slice(0, 500) : String(detail.message || detail.code || '平台请求被拒绝')),
        { status: response.status, code: data.code || detail.code, retryAfter: data.retry_after_seconds ?? detail.retry_after_seconds,
          broadcastStarted: data.broadcast_started ?? detail.broadcast_started,
          admissionId: data.admission_id ?? detail.admission_id, intentId: data.intent_id ?? detail.intent_id });
    }
    return data;
  }
  challenge(input) { return this.request('pair/challenge', input); }
  pair(input) { return this.request('pair', input); }
  policy() { return this.request('policy'); }
  ack(input) { return this.request('ack', input); }
  runtime(input) { return this.request('runtime', input); }
  claimCommand(id, input) { return this.request('commands/' + encodeURIComponent(id) + '/claim', input); }
  commandResult(id, input) { return this.request('commands/' + encodeURIComponent(id) + '/result', input); }
  admit(input) { return this.request('admit', input); }
  submit(input) { return this.request('submit', input); }
  order(id) { return this.request('orders/' + encodeURIComponent(id) + '?refresh_result=true'); }
  byIntent(id) { return this.request('orders/by-intent/' + encodeURIComponent(id) + '?refresh_result=true'); }
  registerDeliveryWallet(input) { return this.request('deliveries/wallet', input); }
  reportDeliveries(input) { return this.request('deliveries/report', input); }
  disconnect(intentIds = []) { return this.request('disconnect', { intent_ids: intentIds }); }
}
module.exports = { RentalClient, platformOrigin };
