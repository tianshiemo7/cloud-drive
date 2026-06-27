// 极简 Service Worker — 离线时显示缓存的页面
const CACHE = 'cloud-drive-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => {
      return cache.addAll([
        '/cloud/',
        '/cloud/index.html',
        '/cloud/style.css',
        '/cloud/app.js',
        '/cloud/manifest.json'
      ]);
    })
  );
});

self.addEventListener('fetch', (e) => {
  // API 请求不缓存，直通网络
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((response) => {
        if (response.ok && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});

// 清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    })
  );
});
