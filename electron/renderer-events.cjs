// Notifications may arrive after the window closes while the worker is flushing.
// Dropping a view notification must never prevent the app from finishing shutdown.
function publishRenderer(window, event) {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  if (!contents || contents.isDestroyed()) return false;
  try { contents.send('storydesk:event', event); return true; }
  catch { return false; }
}
module.exports = { publishRenderer };
