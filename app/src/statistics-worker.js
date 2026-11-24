'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { queryStatistics, statisticsCsv } = require('./statistics');
const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec('PRAGMA busy_timeout=1000');
parentPort.on('message', ({ id, input }) => {
  try {
    // One read snapshot keeps pages, totals and completeness counters consistent.
    db.exec('BEGIN');
    let result;
    try { result = queryStatistics(db, input); } finally { db.exec('ROLLBACK'); }
    parentPort.postMessage({ id, result: input.export ? statisticsCsv(result) : result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
