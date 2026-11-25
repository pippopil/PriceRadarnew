// Модуль прямого взаимодействия с Wildberries API и CDN (wbbasket.ru)
// Извлекает реальные цены в рублях (копейки / 100) и штрихкод товара без хардкод-эвристик

import { resilientFetch, TTLCache } from '../utils/resilience';

export interface WbCardResult {
  nmId: number;
  title: string;
  brand: string;
  category: string;
  subjName: string;
  subjRoot: string;
  description: string;
  vendorCode: string;
  barcode?: string;
  imageUrl: string;
  specs: Record<string, string>;
  realPrice: number | null;
  realOldPrice: number | null;
  priceSource: 'api' | 'cdn' | 'unavailable';
  confidence: number;
  freshness?: 'live' | 'cached';
}

const wbCardCache = new TTLCache<WbCardResult>(15 * 60 * 1000, 300);

export function extractWbSku(urlOrSku: string): number | null {
  const clean = urlOrSku.trim();

  // Прямой ввод артикула (5-12 цифр)
  if (/^\d{5,12}$/.test(clean)) {
    return Number(clean);
  }

  // /catalog/XXXXXX/detail.aspx или /catalog/XXXXXX/
  const catalogMatch = clean.match(/catalog\/(\d{5,12})/i);
  if (catalogMatch && catalogMatch[1]) {
    return Number(catalogMatch[1]);
  }

  // /product/XXXXXX (mobile / global WB)
  const productMatch = clean.match(/product\/(\d{5,12})/i);
  if (productMatch && productMatch[1]) {
    return Number(productMatch[1]);
  }

  // ?nm=XXXXXX или ?nmId=XXXXXX или ?card=XXXXXX
  const nmMatch = clean.match(/[?&](?:nm|nmId|card|article)=(\d{5,12})/i);
  if (nmMatch && nmMatch[1]) {
    return Number(nmMatch[1]);
  }

  // Общий поиск 6-11 цифр в URL WB
  if (clean.includes('wildberries.ru') || clean.includes('wb.ru')) {
    const generalDigits = clean.match(/\/(\d{6,11})(?:[/?#]|$)/);
    if (generalDigits && generalDigits[1]) {
      return Number(generalDigits[1]);
    }
  }

  return null;
}

export function extractWbSearchQuery(url: string): string | null {
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    const search = urlObj.searchParams.get('search');
    if (search && search.trim()) {
      return decodeURIComponent(search.trim());
    }
  } catch {
    const match = url.match(/[?&]search=([^&]+)/i);
    if (match && match[1]) {
      return decodeURIComponent(match[1].replace(/\+/g, ' '));
    }
  }
  return null;
}

export function getPredictedBasket(vol: number): number {
  if (vol <= 143) return 1;
  if (vol <= 287) return 2;
  if (vol <= 431) return 3;
  if (vol <= 719) return 4;
  if (vol <= 1007) return 5;
  if (vol <= 1061) return 6;
  if (vol <= 1115) return 7;
  if (vol <= 1169) return 8;
  if (vol <= 1313) return 9;
  if (vol <= 1601) return 10;
  if (vol <= 1655) return 11;
  if (vol <= 1919) return 12;
  if (vol <= 2045) return 13;
  if (vol <= 2189) return 14;
  if (vol <= 2405) return 15;
  if (vol <= 2621) return 16;
  if (vol <= 2837) return 17;
  if (vol <= 3053) return 18;
  if (vol <= 3269) return 19;
  if (vol <= 3485) return 20;
  if (vol <= 3701) return 21;
  if (vol <= 3917) return 22;
  if (vol <= 4133) return 23;
  if (vol <= 4349) return 24;
  if (vol <= 4565) return 25;
  if (vol <= 4781) return 26;
  if (vol <= 4997) return 27;
  return 28;
}

/**
 * Извлекает штрихкод (EAN-13 / barcode / sku) из ответа Wildberries API или CDN card.json
 */
function extractBarcodeFromWbPayload(data: any): string | undefined {
  if (!data || typeof data !== 'object') return undefined;

  // 1. В массиве sizes (объекты с полем barcode / skus / sku)
  if (Array.isArray(data.sizes)) {
    for (const s of data.sizes) {
      if (typeof s?.barcode === 'string' && /^\d{8,14}$/.test(s.barcode.trim())) {
        return s.barcode.trim();
      }
      if (typeof s?.sku === 'string' && /^\d{8,14}$/.test(s.sku.trim())) {
        return s.sku.trim();
      }
      if (Array.isArray(s?.skus)) {
        const validSku = s.skus.find((x: unknown) => typeof x === 'string' && /^\d{8,14}$/.test(x.trim()));
        if (validSku) return validSku.trim();
      }
    }
  }

  // 2. В характеристиках imt_chars или options
  const charArrays = [data.imt_chars, data.options, data.grouped_options?.flatMap((g: any) => g.options || [])];
  for (const arr of charArrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const name = String(item?.name || '').toLowerCase();
      const val = String(item?.value || '').trim();
      if ((name.includes('штрихкод') || name.includes('barcode') || name.includes('ean')) && /^\d{8,14}$/.test(val)) {
        return val;
      }
    }
  }

  return undefined;
}

/**
 * Извлекает реальные цены Wildberries в рублях (копейки / 100).
 * Поддерживает оба формата WB: salePriceU/priceU и v2 sizes[].price.{product,total,basic}.
 */
function extractRealWbPrices(data: any): { realPrice: number | null; realOldPrice: number | null } {
  if (!data || typeof data !== 'object') {
    return { realPrice: null, realOldPrice: null };
  }

  const sizePrice = Array.isArray(data.sizes)
    ? data.sizes.find((s: any) => s?.price && (s.price.product > 0 || s.price.total > 0 || s.price.basic > 0))?.price
    : undefined;

  let rawSaleKopecks: number | null = null;
  let rawBaseKopecks: number | null = null;

  if (sizePrice) {
    rawSaleKopecks = sizePrice.product || sizePrice.total || sizePrice.basic || null;
    rawBaseKopecks = sizePrice.basic || rawSaleKopecks;
  } else if (typeof data.salePriceU === 'number' && data.salePriceU > 0) {
    rawSaleKopecks = data.salePriceU;
    rawBaseKopecks = typeof data.priceU === 'number' && data.priceU > 0 ? data.priceU : data.salePriceU;
  } else if (typeof data.priceU === 'number' && data.priceU > 0) {
    rawSaleKopecks = data.priceU;
    rawBaseKopecks = data.priceU;
  }

  const realPrice = rawSaleKopecks ? Math.round(rawSaleKopecks / 100) : null;
  const realOldPrice = rawBaseKopecks ? Math.round(rawBaseKopecks / 100) : realPrice;

  return { realPrice, realOldPrice };
}

/**
 * Прямой асинхронный опрос Wildberries Detail API и CDN wbbasket.ru.
 * Защищен кэшем (TTL 15 мин), таймаутом, экспоненциальным backoff (до 3 попыток) и Circuit Breaker.
 * НИКОГДА не подставляет фейковые/эвристические цены — если реальная цена недоступна, возвращает realPrice: null.
 */
export async function fetchWbCardData(nmId: number): Promise<WbCardResult | null> {
  const cacheKey = `wb:${nmId}`;
  const cached = wbCardCache.get(cacheKey);
  if (cached) {
    return { ...cached.value, freshness: 'cached' };
  }

  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  const predicted = getPredictedBasket(vol);
  const predictedPad = predicted < 10 ? `0${predicted}` : String(predicted);
  const defaultImageUrl = `https://basket-${predictedPad}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/big/1.webp`;

  let apiResult: WbCardResult | null = null;

  // 1. Официальный Detail API Wildberries (живые цены в копейках / 100 и остатки)
  const wbApiUrl = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nmId}`;
  const apiRes = await resilientFetch(wbApiUrl, {
    timeoutMs: 2500,
    maxRetries: 2,
    baseDelayMs: 250,
    circuitKey: 'wildberries'
  });

  if (apiRes && apiRes.ok) {
    try {
      const apiJson = await apiRes.json();
      const product = apiJson?.data?.products?.[0];
      if (product) {
        const { realPrice, realOldPrice } = extractRealWbPrices(product);
        const barcode = extractBarcodeFromWbPayload(product);
        const title = product.name || `Товар WB ${nmId}`;
        const brand = product.brand || 'Wildberries';
        const subjName = product.entity || 'Каталог WB';
        const rating = product.rating || product.reviewRating;
        const feedbacks = product.feedbacks;

        const specs: Record<string, string> = {
          'Артикул WB': String(nmId),
          'Бренд': brand,
          'Статус': (product.totalQuantity ?? 1) > 0 ? 'В наличии на складе WB' : 'Нет в наличии на складе WB',
          'Поставщик': product.supplier || 'Wildberries'
        };

        if (rating) {
          specs['Рейтинг покупателей'] = `${rating} ★${feedbacks ? ` (${feedbacks} отзывов)` : ''}`;
        }
        if (barcode) {
          specs['Штрихкод (EAN)'] = barcode;
        }
        if (product.colors?.[0]?.name) {
          specs['Цвет'] = product.colors[0].name;
        }

        apiResult = {
          nmId,
          title,
          brand,
          category: `Каталог WB / ${subjName}`,
          subjName,
          subjRoot: 'Каталог WB',
          description: title,
          vendorCode: String(nmId),
          barcode,
          imageUrl: defaultImageUrl,
          specs,
          realPrice,
          realOldPrice,
          priceSource: realPrice ? 'api' : 'unavailable',
          confidence: realPrice ? 0.75 : 0,
          freshness: 'live'
        };
      }
    } catch {
      // Переходим к CDN-карточке
    }
  }

  // Если уже есть API-результат с ценой и штрихкодом, кэшируем и возвращаем сразу
  if (apiResult && apiResult.realPrice && apiResult.barcode) {
    wbCardCache.set(cacheKey, apiResult);
    return apiResult;
  }

  // 2. Опрос CDN корзин wbbasket.ru (карточка товара JSON: метаданные, характеристики, штрихкод)
  const candidateBaskets: number[] = [predicted];
  for (let offset = 1; offset <= 3; offset++) {
    if (predicted - offset >= 1) candidateBaskets.push(predicted - offset);
    if (predicted + offset <= 30) candidateBaskets.push(predicted + offset);
  }

  for (let i = 0; i < candidateBaskets.length; i += 3) {
    const chunk = candidateBaskets.slice(i, i + 3);
    const promises = chunk.map(async basket => {
      const pad = basket < 10 ? `0${basket}` : String(basket);
      const url = `https://basket-${pad}.wbbasket.ru/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
      const res = await resilientFetch(url, {
        timeoutMs: 2200,
        maxRetries: 1,
        circuitKey: 'wildberries_cdn'
      });
      if (res && res.ok) {
        try {
          const data = await res.json();
          return { basket, data };
        } catch {
          return null;
        }
      }
      return null;
    });

    const results = await Promise.all(promises);
    const match = results.find(Boolean);

    if (match && match.data) {
      const { basket, data } = match;
      const pad = basket < 10 ? `0${basket}` : String(basket);
      const imageUrl = `https://basket-${pad}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/big/1.webp`;

      const title = apiResult?.title || data.imt_name || data.description || data.subj_name || `Товар WB ${nmId}`;
      const brand = apiResult?.brand || data.selling?.brand_name || 'Wildberries';
      const subjName = data.subj_name || apiResult?.subjName || 'Товары';
      const subjRoot = data.subj_root_name || 'Каталог';
      const category = `${subjRoot} / ${subjName}`;
      const description = data.description || title;
      const vendorCode = data.vendor_code || String(nmId);
      const barcode = apiResult?.barcode || extractBarcodeFromWbPayload(data);

      // Извлекаем реальную цену из ответа CDN (если присутствует salePriceU/priceU), иначе берем из Detail API
      const cdnPrices = extractRealWbPrices(data);
      const realPrice = apiResult?.realPrice ?? cdnPrices.realPrice;
      const realOldPrice = apiResult?.realOldPrice ?? cdnPrices.realOldPrice;

      const specs: Record<string, string> = {
        ...(apiResult?.specs || {}),
        'Артикул WB': String(nmId),
        'Бренд': brand,
        'Категория': subjName,
        'Артикул поставщика': vendorCode,
        'Проверка качества': data.certificate?.verified ? 'Официально подтвержден' : 'Проверен WB'
      };

      if (barcode) {
        specs['Штрихкод (EAN)'] = barcode;
      }

      if (data.sizes_table?.details_props && data.sizes_table?.values?.[0]?.details) {
        const props: string[] = data.sizes_table.details_props;
        const vals: string[] = data.sizes_table.values[0].details;
        props.slice(0, 3).forEach((propName, idx) => {
          if (vals[idx]) {
            specs[propName] = vals[idx];
          }
        });
      }

      const mergedResult: WbCardResult = {
        nmId,
        title,
        brand,
        category,
        subjName,
        subjRoot,
        description,
        vendorCode,
        barcode,
        imageUrl,
        specs,
        realPrice,
        realOldPrice,
        priceSource: apiResult?.realPrice ? 'api' : (cdnPrices.realPrice ? 'cdn' : 'unavailable'),
        confidence: apiResult?.realPrice ? 0.75 : (cdnPrices.realPrice ? 0.7 : 0),
        freshness: 'live'
      };

      wbCardCache.set(cacheKey, mergedResult);
      return mergedResult;
    }
  }

  if (apiResult) {
    wbCardCache.set(cacheKey, apiResult);
    return apiResult;
  }

  // При сбое/открытом Circuit Breaker возвращаем stale-кэш, если он есть
  const stale = wbCardCache.getStale(cacheKey);
  if (stale) {
    return { ...stale.value, freshness: 'cached' };
  }

  return null;
}
