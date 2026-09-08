// Service Worker 缓存配置（仅同源资源，跨域 CDN 资源不缓存避免 opaque response 问题）
var CACHE_NAME = 'dormitory-cache-v2';
var urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// 安装：预缓存核心同源资源
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function(cache) {
                return cache.addAll(urlsToCache);
            })
            .then(function() {
                return self.skipWaiting();
            })
    );
});

// 激活：清理旧版本缓存，立即接管页面
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(function() {
            return self.clients.claim();
        })
    );
});

// 拦截请求：同源 GET 优先缓存（cache-first），跨域请求直接放行
self.addEventListener('fetch', function(event) {
    // 非 GET 请求直接放行
    if (event.request.method !== 'GET') return;
    // 跨域请求（第三方 CDN）直接放行，不缓存避免 opaque response 导致失败
    var url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(event.request)
            .then(function(cached) {
                if (cached) return cached;
                return fetch(event.request)
                    .then(function(response) {
                        // 只缓存成功的同源响应
                        if (response && response.status === 200 && response.type === 'basic') {
                            var responseClone = response.clone();
                            caches.open(CACHE_NAME).then(function(cache) {
                                cache.put(event.request, responseClone);
                            });
                        }
                        return response;
                    });
            })
    );
});
