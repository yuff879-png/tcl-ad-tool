'use strict';
// Only the parent IPC channel can control the desktop lifecycle. Browser pages
// still use the authenticated, same-origin API and never receive Node access.
function attachDesktopControl(application, channel = process) {
  let shutdown = null;
  const send = message => { if (channel.connected) channel.send(message, () => {}); };
  const stop = () => shutdown ||= application.close().then(() => {
    send({ type: 'closed' });
    if (channel.connected) channel.disconnect();
  });
  const receive = async message => {
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type === 'shutdown') await stop();
      else if (message.type === 'pause') {
        await application.pause('桌面界面暂不可用，已暂停后续投放');
        send({ type: 'paused', id: message.id });
      }
    } catch { send({ type: 'control-error', id: message.id }); }
  };
  channel.on('message', receive);
  channel.once('disconnect', () => { stop().catch(() => { channel.exitCode = 1; }); });
  if (channel.connected === false) stop().catch(() => { channel.exitCode = 1; });
  return { stop, send };
}
module.exports = { attachDesktopControl };
