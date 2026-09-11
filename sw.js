// Service Worker 缓存配置
// 同源业务资源 cache-first；第三方 CDN 资源预缓存 + cache-first（cors 模式可校验）；
// Supabase 数据接口仅网络不缓存；页面导航请求离线时回退缓存的 index.html
//
// 【版本管理约定】每次修改任意 JS（或其他被缓存的静态资源）后，必须把下面的版本号 +1，
// 否则客户端会继续使用旧缓存，导致"代码已改但不生效"。例如 v20 → v21。
var CACHE_NAME = 'dormitory-cache-v20';

// 同源核心资源（任一失败都会阻断安装，保证离线可用的最小集合）
var LOCAL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    // 业务逻辑已模块化拆分为外部 JS，必须预缓存才能保证离线可用
    './config.js',
    './data.js',
    './sync.js',
    './ui.js',
    './app.js'
];

// 第三方 CDN 资源（版本号与 index.html 引用一致）；单独容错，单个失败不阻断 SW 安装
// flatpickr 已内联在 index.html 中，无外部资源需要缓存
var CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js'
];

// 判断是否为 Supabase 云端数据接口（实时数据，禁止缓存）
function isSupabaseApi(url) {
    // 跨域的 supabase 项目域名（*.supabase.co），以及同源代理场景下的接口路径
    return /\.supabase\.co$/i.test(url.hostname)
        || url.pathname.indexOf('/rest/v1/') === 0
        || url.pathname.indexOf('/auth/v1/') === 0
        || url.pathname.indexOf('/realtime/') === 0;
}

// 判断响应是否可缓存（200 且类型为 basic/cors；opaque 作为跨域兜底也允许）
function isCacheableResponse(res) {
    if (!res) return false;
    if (res.type === 'opaque') return true; // no-cors 跨域兜底，状态码不可读
    return res.status === 200 && (res.type === 'basic' || res.type === 'cors');
}

// 安装：本地核心资源全部预缓存；CDN 资源逐个缓存、失败仅告警
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(LOCAL_ASSETS).then(function() {
                return Promise.all(CDN_ASSETS.map(function(u) {
                    // 字符串 URL 默认以 cors 模式请求；jsDelivr 返回 CORS 头，可得到可校验的 cors 响应
                    return cache.add(u).catch(function(e) {
                        console.warn('[SW] CDN 资源预缓存失败（不影响本地资源离线）:', u, e && e.message);
                    });
                }));
            });
        }).then(function() {
            return self.skipWaiting();
        })
    );
});

// 页面可通过 postMessage({type:'SKIP_WAITING'}) 立即激活等待中的新版本
self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
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

// 拦截请求
self.addEventListener('fetch', function(event) {
    // 非 GET 请求直接放行（POST/PUT/DELETE 等数据写操作不缓存）
    if (event.request.method !== 'GET') return;

    var url = new URL(event.request.url);

    // 1) Supabase 数据接口：仅网络，不拦截（保证实时性；离线时由页面错误处理提示）
    if (isSupabaseApi(url)) return;

    // 2) 页面导航请求：网络优先，离线时回退缓存的 index.html（保证断网能打开应用）
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(function() {
                return caches.match('./index.html').then(function(cached) {
                    return cached || caches.match('./');
                });
            })
        );
        return;
    }

    // 3) 同源静态资源 + 第三方 CDN：Cache First
    var isSameOrigin = url.origin === self.location.origin;
    event.respondWith(
        caches.match(event.request).then(function(cached) {
            if (cached) return cached;
            // 跨域 CDN 显式使用 cors 模式：jsDelivr 支持 CORS，可得到 status=200/type=cors 的可校验响应
            var networkPromise = isSameOrigin
                ? fetch(event.request)
                : fetch(event.request.url, { mode: 'cors' });
            return networkPromise.then(function(res) {
                if (isCacheableResponse(res)) {
                    var clone = res.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(event.request, clone);
                    }).catch(function() {});
                }
                return res;
            }).catch(function() {
                // 跨域 cors 失败（环境不支持/无 CORS 头）时兜底 no-cors：opaque 响应也可缓存
                if (!isSameOrigin) {
                    return fetch(event.request.url, { mode: 'no-cors' }).then(function(res2) {
                        if (isCacheableResponse(res2)) {
                            var clone2 = res2.clone();
                            caches.open(CACHE_NAME).then(function(cache) {
                                cache.put(event.request, clone2);
                            }).catch(function() {});
                        }
                        return res2;
                    }).catch(function() {
                        return Response.error();
                    });
                }
                return Response.error();
            });
        })
    );
});
