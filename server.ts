import http from 'http';
import express, { Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { fetchWbCardData, extractWbSku } from './src/services/wbParser';
import { generateProductFromUrl, parseProductUrl, detectMarketplaceFromUrl } from './src/services/parserEngine';
import { TTLCache, marketplaceCircuitBreaker } from './src/utils/resilience';
import { MarketplaceId, ParsedProduct } from './src/types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SSE clients pool for real-time broadcasts
const sseClients = new Set<Response>();
let totalDispatchedAlerts = 0;
const serverStartTime = Date.now();

// In-memory TTL cache (3 часа = 10800 сек) как безопасная замена Redis в standalone-среде
const parsedUrlCache = new TTLCache<ParsedProduct>(3 * 60 * 60 * 1000, 400);

// Хранилище снимков цен из Browser Extension (приоритет 1, не кэшируется как stale)
interface ExtensionPriceSnapshot {
  marketplace: MarketplaceId;
  productUrl: string;
  normalizedKey: string;
  finalPrice: number;
  rawPrice?: number;
  currency: string;
  discounts: Array<{ name: string; value: number }>;
  capturedAt: string;
  extensionVersion?: string;
  confidence: number;
}
const extensionSnapshots = new Map<string, ExtensionPriceSnapshot>();

// Append-only журнал обратной связи «Это не тот товар»
interface MatchFeedbackRecord {
  id: string;
  productId: string;
  marketplace: string;
  query: string;
  correct: boolean;
  comment?: string;
  timestamp: string;
}
const matchFeedbackLog: MatchFeedbackRecord[] = [];

// Счетчики метрик мониторинга
const metricsState = {
  priceFetchSuccessTotal: {} as Record<string, number>,
  priceParseFailedTotal: {} as Record<string, number>,
  extensionSnapshotsTotal: 0,
  matchFeedbackTotal: 0,
  matchFeedbackNegativeTotal: 0
};

function incMetric(bucket: Record<string, number>, key: string) {
  bucket[key] = (bucket[key] || 0) + 1;
}

const EXTENSION_ALLOWED_DOMAINS = [
  'ozon.ru',
  'wildberries.ru',
  'wb.ru',
  'market.yandex.ru',
  'aliexpress.ru',
  'aliexpress.com',
  'megamarket.ru',
  'sbermegamarket.ru',
  'dns-shop.ru'
];

function normalizeUrlCacheKey(rawUrl: string): string {
  return rawUrl.trim().split('#')[0].replace(/\/+$/, '').toLowerCase();
}

function applyExtensionSnapshot(product: ParsedProduct, normalizedKey: string): ParsedProduct {
  const snap = extensionSnapshots.get(normalizedKey) || extensionSnapshots.get(normalizedKey.split('?')[0]);
  if (!snap) return product;

  const updatedOffers = product.offers.map(off => {
    if (off.marketplace === snap.marketplace) {
      return {
        ...off,
        price: snap.rawPrice && snap.rawPrice > snap.finalPrice ? snap.rawPrice : snap.finalPrice,
        oldPrice: snap.rawPrice ?? off.oldPrice,
        personalPrice: snap.finalPrice,
        priceSource: 'extension' as const,
        confidence: 0.95,
        estimated: false,
        freshness: 'live' as const,
        availabilityStatus: 'available' as const,
        availabilityNote: undefined
      };
    }
    return off;
  });

  const priced = updatedOffers.filter(o => o.price !== null && o.price > 0);
  priced.sort((a, b) => (a.personalPrice ?? a.price ?? Infinity) - (b.personalPrice ?? b.price ?? Infinity));
  const best = priced[0] || null;

  return {
    ...product,
    freshness: 'live',
    lowestPrice: best ? best.price : product.lowestPrice,
    lowestMarketplace: best ? best.marketplace : product.lowestMarketplace,
    lowestPersonalPrice: best ? best.personalPrice : product.lowestPersonalPrice,
    lowestPersonalMarketplace: best ? best.marketplace : product.lowestPersonalMarketplace,
    offers: updatedOffers.map(o => ({ ...o, isLowest: best ? o.marketplace === best.marketplace : false }))
  };
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'PriceRadar RF Real-Time Backend',
      version: '1.2.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
      activeSSEClients: sseClients.size,
      totalDispatchedAlerts
    });
  });

  // Real-Time Server-Sent Events (SSE) Stream
  app.get('/api/stream/price-alerts', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for nginx / GCP Cloud Run
    res.flushHeaders?.();

    // Initial handshake
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    sseClients.add(res);

    // Heartbeat every 20 seconds to keep connection alive through cloud proxies
    const heartbeatTimer = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (e) {
        clearInterval(heartbeatTimer);
        sseClients.delete(res);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeatTimer);
      sseClients.delete(res);
    });
  });

  // Broadcast alert endpoint (called internally or by monitor worker)
  app.post('/api/monitor/broadcast-alert', (req, res) => {
    try {
      const { alert } = req.body;
      if (!alert) {
        return res.status(400).json({ success: false, error: 'Missing alert payload' });
      }

      totalDispatchedAlerts++;
      const payload = JSON.stringify({ type: 'price_drop', alert, timestamp: new Date().toISOString() });
      
      sseClients.forEach((client) => {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch (e) {
          sseClients.delete(client);
        }
      });

      return res.json({ success: true, broadcastCount: sseClients.size });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Monitor status endpoint
  app.get('/api/monitor/status', (_req, res) => {
    res.json({
      success: true,
      status: 'active',
      activeSubscribers: sseClients.size,
      totalAlertsSent: totalDispatchedAlerts,
      uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000)
    });
  });

  // Wildberries card lookup proxy endpoint
  app.get('/api/wb/:sku', async (req, res) => {
    try {
      const sku = Number(req.params.sku);
      if (!sku || isNaN(sku)) {
        return res.status(400).json({ success: false, error: 'Invalid SKU' });
      }
      const data = await fetchWbCardData(sku);
      if (data) {
        return res.json({ success: true, data });
      }
      return res.status(404).json({ success: false, error: 'WB Card not found on CDN' });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Universal parse endpoint с TTL-кэшированием (3 часа), поддержкой снимков расширения и graceful degradation
  app.post('/api/parse-url', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ success: false, error: 'Missing url parameter' });
    }

    const cleanUrl = url.trim();
    const cacheKey = normalizeUrlCacheKey(cleanUrl);
    const mkt = detectMarketplaceFromUrl(cleanUrl);

    const storeNames: Record<string, string> = {
      wildberries: 'Wildberries',
      ozon: 'Ozon',
      yandex: 'Яндекс Маркет',
      aliexpress: 'AliExpress',
      megamarket: 'Мегамаркет'
    };

    const buildResponsePayload = (product: ParsedProduct, freshness: 'live' | 'cached') => {
      const hasSnap = extensionSnapshots.has(cacheKey) || extensionSnapshots.has(cacheKey.split('?')[0]);
      const enriched = applyExtensionSnapshot(product, cacheKey);
      const effectiveFreshness: 'live' | 'cached' = hasSnap ? 'live' : freshness;
      const offer = enriched.offers.find(o => o.marketplace === mkt);
      const price = offer?.price ?? enriched.lowestPrice ?? null;
      const oldPrice = offer?.oldPrice ?? null;
      return {
        success: true,
        freshness: effectiveFreshness,
        marketplace: mkt,
        storeName: storeNames[mkt] || 'Интернет-магазин',
        price,
        oldPrice,
        title: enriched.title,
        imageUrl: enriched.imageUrl,
        category: enriched.category,
        sku: enriched.sku,
        barcode: enriched.barcode,
        normalizedTitle: enriched.normalizedTitle,
        product: { ...enriched, freshness: effectiveFreshness }
      };
    };

    // 1. Проверяем наличие свежего снимка из Browser Extension (кэш не применяется — всегда свежие данные)
    const hasExtensionSnap = extensionSnapshots.has(cacheKey) || extensionSnapshots.has(cacheKey.split('?')[0]);

    // 2. Проверяем TTL-кэш (3 часа)
    if (!hasExtensionSnap) {
      const cached = parsedUrlCache.get(cacheKey);
      if (cached) {
        incMetric(metricsState.priceFetchSuccessTotal, `${mkt}:cache`);
        return res.json(buildResponsePayload(cached.value, 'cached'));
      }
    }

    try {
      // 3. Асинхронный парсинг (реальный WB API/CDN с таймаутами и Circuit Breaker или семантический разбор слага)
      const sku = extractWbSku(cleanUrl);
      if (sku && (mkt === 'wildberries' || cleanUrl.includes('wb.ru') || cleanUrl.includes('wildberries.ru'))) {
        const card = await fetchWbCardData(sku);
        if (card) {
          const product = generateProductFromUrl(cleanUrl, card);
          parsedUrlCache.set(cacheKey, product);
          incMetric(metricsState.priceFetchSuccessTotal, `wildberries:${card.priceSource}`);
          return res.json({
            ...buildResponsePayload(product, card.freshness || 'live'),
            card
          });
        }
      }

      const product = await parseProductUrl(cleanUrl);
      parsedUrlCache.set(cacheKey, product);
      incMetric(metricsState.priceFetchSuccessTotal, `${mkt}:parser`);
      return res.json(buildResponsePayload(product, 'live'));
    } catch (err: any) {
      incMetric(metricsState.priceParseFailedTotal, `${mkt}:${err?.name || 'error'}`);

      // Не отдаем 500 при сбое парсера — возвращаем stale-кэш или безопасную деградированную карточку с дисклеймером
      const stale = parsedUrlCache.getStale(cacheKey);
      if (stale) {
        return res.json({
          ...buildResponsePayload(stale.value, 'cached'),
          disclaimer: 'Данные взяты из резервного кэша и могут быть устаревшими.'
        });
      }

      const fallbackProduct = generateProductFromUrl(cleanUrl);
      return res.json({
        ...buildResponsePayload(fallbackProduct, 'cached'),
        disclaimer: 'Площадка временно недоступна для автопарсинга — перейдите по прямой ссылке для проверки цены.'
      });
    }
  });

  // Приемник снимков цен от Browser Extension (Уровень A, приоритет 1, confidence = 0.95)
  app.post('/api/v1/prices/from-extension', (req, res) => {
    try {
      const { marketplace, product_url, final_price, raw_price, currency, discounts, captured_at, extension_version } = req.body || {};

      if (typeof final_price !== 'number' || !Number.isFinite(final_price) || final_price <= 0) {
        return res.status(400).json({ success: false, error: 'final_price must be a positive number' });
      }

      if (typeof product_url !== 'string' || !product_url.startsWith('http')) {
        return res.status(400).json({ success: false, error: 'Invalid product_url' });
      }

      let hostname = '';
      try {
        hostname = new URL(product_url).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        return res.status(400).json({ success: false, error: 'Malformed product_url' });
      }

      const isAllowedDomain = EXTENSION_ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
      if (!isAllowedDomain) {
        return res.status(400).json({ success: false, error: 'product_url domain is not in allow-list' });
      }

      const capturedTs = captured_at ? Date.parse(captured_at) : Date.now();
      if (Number.isNaN(capturedTs) || Math.abs(Date.now() - capturedTs) > 5 * 60 * 1000) {
        return res.status(400).json({ success: false, error: 'captured_at must not be older than 5 minutes' });
      }

      const normalizedKey = normalizeUrlCacheKey(product_url);
      const detectedMkt = (['wb', 'wildberries'].includes(String(marketplace).toLowerCase())
        ? 'wildberries'
        : ['ym', 'yandex'].includes(String(marketplace).toLowerCase())
        ? 'yandex'
        : detectMarketplaceFromUrl(product_url)) as MarketplaceId;

      const snapshot: ExtensionPriceSnapshot = {
        marketplace: detectedMkt,
        productUrl: product_url,
        normalizedKey,
        finalPrice: Math.round(final_price),
        rawPrice: typeof raw_price === 'number' && raw_price > 0 ? Math.round(raw_price) : undefined,
        currency: typeof currency === 'string' ? currency : 'RUB',
        discounts: Array.isArray(discounts) ? discounts.slice(0, 10) : [],
        capturedAt: new Date(capturedTs).toISOString(),
        extensionVersion: typeof extension_version === 'string' ? extension_version : undefined,
        confidence: 0.95
      };

      extensionSnapshots.set(normalizedKey, snapshot);
      extensionSnapshots.set(normalizedKey.split('?')[0], snapshot);
      parsedUrlCache.delete(normalizedKey);
      metricsState.extensionSnapshotsTotal++;
      incMetric(metricsState.priceFetchSuccessTotal, `${detectedMkt}:extension`);

      return res.json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err?.message || 'Invalid payload' });
    }
  });

  // Feedback loop: кнопка «Это не тот товар» (append-only журнал)
  app.post('/api/v1/matches/feedback', (req, res) => {
    const { productId, marketplace, query, correct, comment } = req.body || {};
    if (!productId || !marketplace) {
      return res.status(400).json({ success: false, error: 'Missing productId or marketplace' });
    }

    const record: MatchFeedbackRecord = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId: String(productId).slice(0, 120),
      marketplace: String(marketplace).slice(0, 40),
      query: String(query || '').slice(0, 200),
      correct: Boolean(correct),
      comment: comment ? String(comment).slice(0, 500) : undefined,
      timestamp: new Date().toISOString()
    };

    matchFeedbackLog.push(record);
    metricsState.matchFeedbackTotal++;
    if (!record.correct) {
      metricsState.matchFeedbackNegativeTotal++;
    }

    return res.json({
      success: true,
      id: record.id,
      message: 'Спасибо, мы перепроверим'
    });
  });

  // Метрики работы парсеров, кэша, Circuit Breaker и обратной связи
  app.get('/api/metrics', (_req, res) => {
    res.json({
      uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
      price_fetch_success_total: metricsState.priceFetchSuccessTotal,
      price_parse_failed_total: metricsState.priceParseFailedTotal,
      extension_snapshots_total: metricsState.extensionSnapshotsTotal,
      match_feedback_total: metricsState.matchFeedbackTotal,
      match_feedback_negative_total: metricsState.matchFeedbackNegativeTotal,
      cache: {
        entries: parsedUrlCache.size(),
        hits: parsedUrlCache.hits,
        misses: parsedUrlCache.misses
      },
      circuit_breakers: marketplaceCircuitBreaker.getSnapshot()
    });
  });

  // Telegram direct dispatch endpoint
  app.post('/api/telegram/send', async (req, res) => {
    try {
      const { botToken, chatId, message } = req.body;
      if (!botToken || !chatId || !message) {
        return res.status(400).json({ success: false, error: 'Missing botToken, chatId, or message' });
      }

      const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: false
        })
      });

      const data = await response.json();
      if (data.ok) {
        return res.json({ success: true, result: data.result });
      } else {
        return res.status(400).json({ success: false, error: data.description });
      }
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Vite middleware in dev or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[PriceRadar RF] Server running with SSE & Realtime Engine on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
