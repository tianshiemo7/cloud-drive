// Service Worker — 离线缓存（v3，网络优先策略，支持一键连接新版）
const CACHE = 'cloud-drive-v3';

self.addEventListener('install', (e) => {
  // skipWaiting 确保新版 SW 立即激活
  self.skipWaiting();
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
    // 网络优先：先尝试网络，失败时回退到缓存
    fetch(e.request).then((response) => {
      if (response.ok && e.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(e.request);
    })
  );
});

// 清理所有旧版本缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});
