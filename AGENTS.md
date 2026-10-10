# AGENTS.md

## Çalıştırma
- Geliştirme: `npm start` (proje kuralı: `start_dev_server` ile, `requires_localhost_flag=true`)
- Sunucu `127.0.0.1:3000` üzerinde dinler (config.js içinde `HOST`, varsayılan 127.0.0.1)
- Panel: `http://127.0.0.1:3000/dash` — kök `/` buraya yönlendirir
- Sağlık: `/health` · Odalar: `/api/rooms` · Liderlik: `/api/leaderboard/:username`

## Mimari
- `index.js` — giriş: helmet, cors, compression, static, router, zarif kapanma
- `src/config.js` — tüm env değişkenleri (dotenv)
- `src/logger.js` — winston (konsol + `logs/error.log`, `logs/combined.log`)
- `src/rooms.js` — oda deposu (`rooms` Map), SSE gönderimi, heartbeat, temizlik, istatistik
- `src/connection.js` — TikTokLiveConnection kurulumu, tüm Webcast olayları, yeniden bağlanma
- `src/routes.js` — API + `/dash` + `/events/:username` (SSE) + bellek içi rate limiter
- `public/dash.{html,css,js}` — mobil öncelikli panel

## Dikkat edilmesi gerekenler
- **Cluster/çoklu instance KULLANMA**: odalar bellekte (`Map`) tutulur, PM2 `cluster` modu SSE yayınını worker'lar arası bozar. `ecosystem.config.js` bilinçli olarak `instances: 1` + `fork`.
- Docker'da `HOST=0.0.0.0` zorunludur (container dışına açılmadan erişilemez); yerel geliştirmede 127.0.0.1 kalır.
- SSE yayını çift gönderir: adlandırılmış olay (`event: chat`) + genel akış (`event: event`). Panel yalnızca genel akışı dinler.
- `broadcast()` her olayı `pushHistory()` ile geçmişe yazar (son 200); geç bağlayan istemci `history` olayıyla birlikte alır.
- Rate limiter bellekte çalışır (`Map`), sunucu yeniden başlayınca sıfırlanır.
- `write_file` büyük içerikte argüman aktarımı kesilebiliyor — dosyaları modüler ve küçük tut.
