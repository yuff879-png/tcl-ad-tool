'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { statisticsOptions } = require('./statistics');
class StatisticsService {
  constructor(file) { this.file = file; this.worker = null; this.pending = new Map(); this.sequence = 0; this.closed = false; }
  query(input = {}) {
    input = { ...input, export: input.export === true };
    statisticsOptions(input);
    if (this.closed) return Promise.reject(new Error('统计服务已关闭'));
    if (this.pending.size >= 4) return Promise.reject(new Error('统计正在计算，请稍后刷新'));
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, 'statistics-worker.js'), { workerData: { file: this.file } });
      worker.on('message', ({ id, result, error }) => {
        const task = this.pending.get(id); if (!task) return;
        this.pending.delete(id); error ? task.reject(new Error(error)) : task.resolve(result);
      });
      const fail = () => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const task of this.pending.values()) task.reject(new Error('统计暂不可用，请稍后刷新'));
        this.pending.clear();
      };
      worker.on('error', fail); worker.on('exit', fail);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, input });
    });
  }
  async close() {
    this.closed = true;
    if (this.worker) await this.worker.terminate();
  }
}
module.exports = { StatisticsService };
