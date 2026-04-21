// EF Workshop service worker
// Handles web push notifications and updates the home screen app badge.

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Receive push from server
self.addEventListener('push', event => {
  let data = { title: 'EF Workshop', body: 'New inquiry', badge: 1 };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* ignore parse errors, use defaults */ }

  const tasks = [];

  // Update home screen badge
  if ('setAppBadge' in self.navigator) {
    if (data.badge && data.badge > 0) {
      tasks.push(self.navigator.setAppBadge(data.badge).catch(() => {}));
    } else {
      tasks.push(self.navigator.clearAppBadge().catch(() => {}));
    }
  }

  // iOS requires a visible notification with each push or it will revoke permission.
  // Keep it minimal so the badge is the primary signal.
  tasks.push(self.registration.showNotification(data.title || 'EF Workshop', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'ef-inquiry',
    renotify: false,
    silent: false,
    data: { url: '/' }
  }));

  event.waitUntil(Promise.all(tasks));
});

// Tap the notification → open the app (or focus if already open) and go to Inquiries
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        client.postMessage({ type: 'open-inquiries' });
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow('/#inquiries');
    }
  })());
});
