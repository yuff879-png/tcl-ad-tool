'use strict';
const MAX_RETRIES = 3;
const MAX_ATTEMPTS = 1 + MAX_RETRIES;
const FAILURE_LIMIT = 3;
// Legacy versions stored a hash but not its signed payload/expiration. TRON's
// maximum transaction lifetime is 24 hours; never infer absence from one lookup.
const LEGACY_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const FINALITY_MARGIN_MS = 60000;
function nodeReason(value) {
  const data = value?.response?.data || value || {};
  let message = data.message || data.Error || data.error || value?.message || '';
  if (typeof message !== 'string') message = '';
  if (/^(?:[a-f\d]{2}){3,}$/i.test(message)) message = Buffer.from(message, 'hex').toString('utf8');
  const code = typeof data.code === 'string' ? data.code : '';
  const http = value?.response?.status;
  return [http ? `HTTP ${http}` : '', code, message].filter(Boolean).join(' · ').replace(/[\r\n\t]+/g, ' ').slice(0, 600) || '节点未返回明确结果';
}
module.exports = { MAX_RETRIES, MAX_ATTEMPTS, FAILURE_LIMIT, LEGACY_EXPIRATION_MS, FINALITY_MARGIN_MS, nodeReason };
