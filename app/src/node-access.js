'use strict';
const crypto = require('node:crypto');
const { nodeReason } = require('./delivery-retry');
const PUBLIC_RPC = 'https://api.trongrid.io';
const COOLDOWN_MS = 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isPublicRpc(url) {
  try { const parsed = new URL(url); return parsed.origin === PUBLIC_RPC && parsed.pathname === '/'; }
  catch { return false; }
}
function isRateLimitError(value) {
  if (value?.code === 'NODE_CAPACITY' || Number(value?.response?.status || value?.status) === 429) return true;
  const messages = [nodeReason(value), typeof value === 'string' ? value : '', nodeReason(value?.result)];
  return messages.some(message => /\b429\b|too many requests|rate[ _-]?limit|exceed\w*[^.\n]{0,80}(?:frequency|daily|usage|request)\s*(?:limit|quota)?|(?:quota|daily (?:usage|limit)|request limit)[^.\n]{0,80}(?:exceed|exhaust|used up|reach)|限流|配额(?:已)?(?:耗尽|用完|超出)/i.test(message));
}
class NodeCapacityError extends Error {
  constructor(retryAt = Date.now() + COOLDOWN_MS, message = '节点限流，等待恢复后自动继续；不计入投放失败') {
    super(message); this.name = 'NodeCapacityError'; this.code = 'NODE_CAPACITY'; this.retryAt = retryAt;
  }
}
function retryDelay(error, now) {
  const headers = error?.response?.headers;
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const delay = /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(COOLDOWN_MS, Math.min(delay, 24 * 60 * 60 * 1000)) : COOLDOWN_MS;
}

// Requests from scanning, delivery and reconciliation share a queue and cooldown.
// Capacity failures are handled by NodeAccess, never retried here in a tight loop.
class RequestQueue {
  constructor(delay = 350) { this.tail = Promise.resolve(); this.delay = delay; }
  run(fn, retryRead = true) {
    const task = this.tail.catch(() => {}).then(async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await fn(); }
          catch (error) {
            if (!retryRead || isRateLimitError(error) || attempt >= 2 || ![502, 503, 504].includes(error.response?.status)) throw error;
            await sleep(1500 * 2 ** attempt);
          }
        }
      } finally { if (this.delay) await sleep(this.delay); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
function initialNodeStatus(config) {
  const source = isPublicRpc(config.rpcUrl) ? config.apiKey ? 'primary' : 'public' : 'custom';
  return { source, state: 'ready', fallback: false, retryAt: 0 };
}
class NodeAccess {
  constructor(config, { sessions = new Map(), onEvent = () => {}, now = Date.now, delay = 350, publicDelay = 1000, queueGroup = 'foreground' } = {}) {
    this.onEvent = onEvent; this.now = now; this.publicDelay = publicDelay;
    // Unknown/custom RPCs may be another network. Never send their transactions
    // to mainnet automatically. This fallback is for TronGrid mainnet only.
    this.canFallback = isPublicRpc(config.rpcUrl) && Boolean(config.apiKey);
    const key = crypto.createHash('sha256').update(JSON.stringify([config.rpcUrl.replace(/\/$/, ''), config.apiKey])).digest('hex');
    if (!sessions.has(key)) {
      const status = initialNodeStatus(config);
      sessions.set(key, { ...status, queues: new Map() });
    }
    this.session = sessions.get(key);
    if (!this.session.queues.has(queueGroup)) this.session.queues.set(queueGroup,
      new RequestQueue(this.source === 'public' ? publicDelay : delay));
    this.queue = this.session.queues.get(queueGroup);
  }
  get source() { return this.session.source; }
  snapshot() {
    const { source, fallback, retryAt } = this.session;
    return { source, fallback, retryAt, state: retryAt ? 'cooldown' : 'ready' };
  }
  run(fn, retryRead = true) {
    return this.queue.run(async () => {
      const state = this.session;
      for (;;) {
        if (state.retryAt > this.now()) throw new NodeCapacityError(state.retryAt);
        const requestedSource = state.source, previousCooldown = state.retryAt;
        try {
          const result = await fn();
          if (isRateLimitError(result)) throw result;
          // A delayed statistics response from the old client cannot clear a
          // newer cooldown or be mistaken for the public node's rate response.
          if (state.retryAt && state.retryAt === previousCooldown && state.source === requestedSource) {
            state.retryAt = 0; this.onEvent('info', '节点请求已恢复，继续扫描、投放及后台核查');
          }
          return result;
        } catch (error) {
          if (!isRateLimitError(error)) throw error;
          if (requestedSource !== state.source) continue;
          if (this.canFallback && state.source === 'primary') {
            state.source = 'public'; state.fallback = true; state.retryAt = 0;
            for (const queue of state.queues.values()) queue.delay = this.publicDelay;
            this.onEvent('warn', 'TronGrid API 限流或额度耗尽，已切换公共节点（不带 API Key）；不消耗投放重试次数');
            // A broadcast callback always retains the exact same signed payload.
            continue;
          }
          state.retryAt = this.now() + retryDelay(error, this.now());
          this.onEvent('warn', `${state.source === 'public' ? '公共节点' : '配置节点'}也暂时限流，等待 ${Math.ceil((state.retryAt - this.now()) / 1000)} 秒后自动重试；不计入投放失败`);
          throw new NodeCapacityError(state.retryAt);
        }
      }
    }, retryRead);
  }
}
module.exports = { NodeAccess, NodeCapacityError, RequestQueue, isRateLimitError, initialNodeStatus, isPublicRpc, PUBLIC_RPC, COOLDOWN_MS };
