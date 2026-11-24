'use strict';
// Validate one immutable 1.3.8 candidate and the original 1.3.7 online path.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const { sha256, verifyManifest } = require('../app/src/updater');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const version = '1.3.8', from = '1.3.7';
const pkg = read('verification/package-verification-1.3.8.json');
const data = read('verification/upgrade-verification-1.3.8-from-1.3.7.json');
const online = read('verification/electron-self-update-verification-1.3.8-from-1.3.7.json');
const release = verifyManifest(read('publish/v1.3.8/update.json'));
const baseline = verifyManifest(read('publish/v1.3.7/update.json'));
const filename = `tcl-ad-tool-${version}-win-x64.zip`;
const bytes = fs.readFileSync(path.join(root, 'publish/v1.3.8', filename));
const hash = sha256(bytes);
assert.equal(release.version, version);
assert.equal(release.url, `https://github.com/yuff879-png/tcl-ad-tool/releases/download/v${version}/${filename}`);
assert.equal(release.sha256, hash); assert.equal(release.size, bytes.length);
assert.equal(pkg.sha256, hash); assert.equal(pkg.size, bytes.length);
assert.equal(fs.readFileSync(path.join(root, 'publish/v1.3.8/SHA256SUMS.txt'), 'utf8'), `${hash}  ${filename}\n`);
assert.equal(pkg.updaterUnchangedFrom, from);
assert.ok(pkg.tests.tests > 353); assert.equal(pkg.tests.pass, pkg.tests.tests);
assert.equal(pkg.removedFiles.length, 0);
assert.ok(pkg.addedFiles.includes('TCL广告投放工具/src/runtime-control.js'));
assert.ok(pkg.actualChangedFiles.includes('src/engine.js'));
assert.ok(pkg.actualChangedFiles.includes('src/server.js'));
assert.equal(pkg.dependenciesUnchangedFrom, from);
assert.equal(pkg.testStartManifestCaptured, true);
for (const report of [data, online]) {
  assert.equal(report.from, from); assert.equal(report.version, version);
  assert.equal(report.packageSha256, hash); assert.equal(report.baselineSha256, baseline.sha256);
  assert.equal(report.realBroadcasts, 0);
}
for (const flag of ['originalReleasedUpdater', 'originalReleasedWorker', 'temporaryWorkerMatchesBaseline',
  'installedStartupSourcesMatchCandidate', 'signedCandidateVerified', 'configUnchanged', 'encryptedVaultUnchanged', 'backupVerified']) assert.equal(data[flag], true, flag);
assert.equal(data.originalWorkerHash, data.installedWorkerHash);
assert.equal(data.installedWorkerHash, pkg.startupSourceHashes['src/update-worker.js']);
for (const flag of ['startsPaused', 'autoResumeFlagDoesNotAutoStart', 'defaultIndependentLocal', 'encryptedPoolUnlocks',
  'poolStartsLocked', 'durableRetryMarkerPreserved', 'archivedRetryHistoryPreserved', 'legacyMarkerAllowsFreshReview',
  'manualRetryReviewPreserved', 'recipientDedupePreserved', 'originalSubmissionErrorsPreserved',
  'receiptRetryPlaceholderPreserved', 'receiptRetryPlaceholderAllowsFreshReview',
  'originalTableSchemasPreserved', 'reportingOutboxMigrationVerified', 'originalRowsUnchangedAfterReporting',
  'unboundReportingMakesNoRequests', 'syntheticPublicFactsOnly', 'syntheticReporterRestartAndBackoffVerified']) assert.equal(data.installedSmoke[flag], true, flag);
for (const field of ['signatures', 'platformRequests', 'realBroadcasts']) assert.equal(data.installedSmoke[field], 0);
for (const flag of ['genuineReleasedBaseline', 'originalSourcesUnmodifiedBeforeInstall', 'signedDownloadAndInstallThroughOriginalHttpApi',
  'originalWorkerExited', 'oldBackendExited', 'oldElectronExited', 'originalWorkerReportedReopened',
  'originalProgressSourcesUnmodified', 'progressVisibleBeforeOriginalProcessesExit', 'progressRemainedVisibleAfterOldProcessesExit',
  'progressStayedAliveUntilNewVersionHealth', 'progressSuccessMatchesRunningInstance', 'progressWindowClosedItselfAfterSuccess',
  'actualExtractionProgressObserved', 'indeterminateStagesDoNotFakePercent', 'newVersionHealthAndElectronEnvironmentVerified',
  'singleBackendAndElectron', 'repeatedStartsReuseSameInstance', 'startsPaused', 'vaultStartsLocked', 'noPrivateKey',
  'configAndEncryptedVaultPreserved', 'databaseRowsPreserved', 'backupsVerified', 'installedStartupSourcesMatchSignedCandidate',
  'newProcessesExitedCleanly', 'originalTableSchemasPreserved', 'reportingOutboxMigrationVerified', 'unboundReportingMakesNoRequests']) assert.equal(online[flag], true, flag);
assert.equal(online.progressDisplayError, null);
assert.equal(online.personalInstallationChanged, false);
assert.equal(online.passedOriginalOwnerPid, online.oldBackendPid);
assert.equal(online.passedOriginalDesktopPid, online.oldElectronPid);
for (const source of ['src/updater.js', 'src/update-worker.js', 'src/startup.js', 'src/instance.js', 'src/update-progress.js']) {
  assert.equal(online.originalWorkerHashes[source], online.originalSourceHashes[source], source);
}
const result = { version, from, sha256: hash, size: bytes.length, signatureValid: true,
  runtimeControlFeaturePackaged: true, reportingSchemaPreserved: true, updaterUnchanged: true, dataAndRetryHistoryPreserved: true,
  original137OnlineUpgradeWithVisibleProgressPassed: true,
  progressSurvivesOldDesktopExit: true, successConfirmedAfterNewWindowHealth: true,
  personalInstallationChanged: false, realBroadcasts: 0 };
fs.writeFileSync(path.join(__dirname, 'release-inputs-1.3.8.json'), JSON.stringify(result, null, 2) + '\n');
fs.copyFileSync(path.join(__dirname, 'package-verification-1.3.8.json'), path.join(root, 'package-verification-1.3.8.json'));
fs.copyFileSync(path.join(__dirname, 'upgrade-verification-1.3.8-from-1.3.7.json'), path.join(root, 'upgrade-verification-1.3.8.json'));
console.log(JSON.stringify(result));
