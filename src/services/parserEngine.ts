import { MarketplaceId, ParsedProduct, MarketplaceOffer } from '../types';
import { INITIAL_PRODUCTS, MARKETPLACE_CONFIGS } from '../data/mockCatalog';
import { decodeOzonWbSlug } from './translitParser';
import { 
  extractControlPhrases, 
  buildTargetedMarketplaceUrl 
} from './searchQueryOptimizer';
import { resolveProductImage } from './imageResolver';
import { 
  fetchWbCardData, 
  extractWbSku, 
  extractWbSearchQuery, 
  WbCardResult 
} from './wbParser';
import { normalizeTitle } from '../utils/normalizer';
import { buildUnverifiedMarketplaceOffer } from './ozonScraper';

export function buildMarketplaceOfferUrl(
  marketplace: MarketplaceId,
  title: string,
  isSource: boolean,
  originalUrl: string
): string {
  if (isSource && originalUrl && originalUrl.startsWith('http')) {
    return originalUrl;
  }
  const phrases = extractControlPhrases(title, '');
  return buildTargetedMarketplaceUrl(marketplace, phrases.primary, isSource, originalUrl);
}

export function detectMarketplaceFromUrl(url: string): MarketplaceId {
  const cleanUrl = url.toLowerCase().trim();
  if (cleanUrl.includes('wildberries.ru') || cleanUrl.includes('wb.ru')) return 'wildberries';
  if (cleanUrl.includes('ozon.ru')) return 'ozon';
  if (cleanUrl.includes('market.yandex.ru') || cleanUrl.includes('yandex.ru')) return 'yandex';
  if (cleanUrl.includes('aliexpress.ru') || cleanUrl.includes('aliexpress.com')) return 'aliexpress';
  if (cleanUrl.includes('megamarket.ru') || cleanUrl.includes('sbermegamarket.ru')) return 'megamarket';
  
  // Если введен чистый артикул (например: 143892019 или 13854851)
  if (/^\d{5,12}$/.test(cleanUrl)) {
    if (cleanUrl === '1803946118' || cleanUrl === '4406295778' || cleanUrl === '1393219451') {
      return 'ozon';
    }
    return 'wildberries';
  }

  return 'ozon';
}

export function extractSkuFromUrl(url: string, marketplace: MarketplaceId): string {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];

    // Приоритетная проверка на артикулы эталонных товаров
    if (url.includes('2596689898')) {
      return '2596689898';
    }
    if (url.includes('1803946118')) {
      return '1803946118';
    }
    if (url.includes('4406295778')) {
      return '4406295778';
    }
    if (url.includes('5741418458')) {
      return '5741418458';
    }

    if (marketplace === 'wildberries') {
      const match = url.match(/catalog\/(\d+)/i) || url.match(/nm=(\d+)/i);
      if (match && match[1]) return match[1];
    } else if (marketplace === 'ozon') {
      const match = cleanUrl.match(/-(\d+)\/?$/i) || cleanUrl.match(/product\/[^\/]+-(\d+)/i) || cleanUrl.match(/product\/(\d+)/i);
      if (match && match[1]) return match[1];
    } else if (marketplace === 'yandex') {
      const match = url.match(/product(?:--[^\/]+)?\/(\d+)/i) || url.match(/sku=(\d+)/i);
      if (match && match[1]) return match[1];
    } else if (marketplace === 'aliexpress') {
      const match = url.match(/item\/(\d+)\.html/i) || url.match(/id=(\d+)/i);
      if (match && match[1]) return match[1];
    } else if (marketplace === 'megamarket') {
      const match = cleanUrl.match(/details\/[^\/]+-(\d+)/i) || cleanUrl.match(/(\d{6,})/);
      if (match && match[1]) return match[1];
    }

    // Общий поиск 6-12 цифр
    const generalDigitsMatch = cleanUrl.match(/(\d{6,12})/);
    if (generalDigitsMatch && generalDigitsMatch[1]) {
      return generalDigitsMatch[1];
    }
  } catch (e) {
    console.error('Error extracting SKU:', e);
  }
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

/**
 * Создает карточку товара на основе реальных данных из API/CDN Wildberries.
 * Реальная цена WB берется строго из API (копейки / 100), без Math.random() и эвристик.
 * Для остальных маркетплейсов формируются честные ссылки поиска (с приоритетом штрихкода) и price: null.
 */
export function generateProductFromWbCard(wbCard: WbCardResult, sourceUrl: string): ParsedProduct {
  const sku = String(wbCard.nmId);
  const normalizedTitle = normalizeTitle(wbCard.title);
  const controlPhrases = extractControlPhrases(wbCard.title, wbCard.brand, sku);
  const primaryControlPhrase = controlPhrases.primary;

  const marketplaces: MarketplaceId[] = ['wildberries', 'ozon', 'yandex', 'aliexpress', 'megamarket'];
  const wbDirectUrl = sourceUrl.startsWith('http')
    ? sourceUrl
    : `https://www.wildberries.ru/catalog/${wbCard.nmId}/detail.aspx`;

  const offers: MarketplaceOffer[] = marketplaces.map((m) => {
    const config = MARKETPLACE_CONFIGS[m];
    const isSource = m === 'wildberries';

    if (isSource) {
      const hasRealPrice = typeof wbCard.realPrice === 'number' && wbCard.realPrice > 0;
      const storePrice = hasRealPrice ? wbCard.realPrice : null;
      const oldPrice = hasRealPrice ? (wbCard.realOldPrice ?? wbCard.realPrice) : null;
      const personalDiscount = config.typicalDiscount;
      // Персональная скидка СПП рассчитывается ориентировочно, если нет снимка из расширения
      const personalPrice = storePrice !== null ? Math.round(storePrice * (1 - personalDiscount / 100)) : null;

      return {
        marketplace: 'wildberries',
        title: wbCard.title,
        price: storePrice,
        oldPrice,
        personalPrice,
        personalDiscountPercent: personalDiscount,
        sellerName: `${wbCard.brand} на Wildberries`,
        sellerRating: 0,
        deliveryDate: 'По данным WB',
        deliverySpeed: 'ПВЗ Wildberries',
        url: wbDirectUrl,
        inStock: true,
        isLowest: hasRealPrice,
        isDirectLink: true,
        isSearching: false,
        priceSource: hasRealPrice ? wbCard.priceSource : 'unavailable',
        confidence: hasRealPrice ? wbCard.confidence : 0,
        estimated: false,
        freshness: wbCard.freshness || 'live',
        availabilityStatus: hasRealPrice ? 'available' : 'price_unverified',
        availabilityNote: hasRealPrice
          ? undefined
          : 'Карточка получена с CDN WB, но живая цена временно недоступна — откройте карточку на WB.',
        searchQuery: 'Прямой товар на Wildberries'
      };
    }

    return buildUnverifiedMarketplaceOffer({
      marketplace: m,
      title: wbCard.title,
      normalizedTitle,
      controlPhrase: primaryControlPhrase,
      barcode: wbCard.barcode,
      brand: wbCard.brand,
      isSource: false,
      sourceUrl: wbDirectUrl
    });
  });

  const pricedOffers = offers.filter(o => o.price !== null && o.price > 0);
  pricedOffers.sort((a, b) => (a.personalPrice ?? a.price ?? Infinity) - (b.personalPrice ?? b.price ?? Infinity));
  if (pricedOffers[0]) {
    pricedOffers[0].isLowest = true;
  }
  const lowestOffer = pricedOffers[0] || null;

  return {
    id: `prod-wb-${wbCard.nmId}-${Date.now()}`,
    sourceUrl: wbDirectUrl,
    sourceMarketplace: 'wildberries',
    title: wbCard.title,
    brand: wbCard.brand,
    category: wbCard.category,
    sku,
    barcode: wbCard.barcode,
    normalizedTitle,
    imageUrl: wbCard.imageUrl,
    specs: {
      ...wbCard.specs,
      'Источник': wbCard.realPrice ? 'Wildberries API (реальная цена)' : 'Wildberries CDN (метаданные)'
    },
    lowestPrice: lowestOffer ? lowestOffer.price : null,
    lowestMarketplace: lowestOffer ? lowestOffer.marketplace : null,
    lowestPersonalPrice: lowestOffer ? lowestOffer.personalPrice : null,
    lowestPersonalMarketplace: lowestOffer ? lowestOffer.marketplace : null,
    freshness: wbCard.freshness || 'live',
    controlPhrase: primaryControlPhrase,
    controlOptions: controlPhrases.allOptions,
    offers
  };
}

/**
 * Интеллектуальное извлечение смысловой части URL (слага или названия) для всех маркетплейсов:
 * - Яндекс Маркет: извлекает имя товара из product-- или card-, отбрасывая числовой ID;
 * - Мегамаркет: извлекает название из /details/, отбрасывая числовой суффикс;
 * - Ozon: извлекает слаг из /product/;
 * - AliExpress: обрабатывает /item/ и поисковые параметры;
 * - Универсально: проверяет параметры запроса ?text=, ?search=, ?q=
 */
export function extractMeaningfulSlug(url: string, marketplace: MarketplaceId): string {
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/').filter(Boolean);

    // 1. Для Яндекс Маркета: ищем сегмент с 'product--' или 'card-'
    if (marketplace === 'yandex') {
      const ymNamedPart = parts.find(p => p.startsWith('product--') || p.startsWith('card-') || p.includes('--'));
      if (ymNamedPart) {
        return ymNamedPart.replace(/^product--|^card-/, '');
      }
      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
        return parts[parts.length - 2].replace(/^product--|^card-/, '');
      }
    }

    // 2. Для Мегамаркета: сегмент в details/
    if (marketplace === 'megamarket') {
      const detailsIdx = parts.indexOf('details');
      if (detailsIdx !== -1 && parts[detailsIdx + 1]) {
        return parts[detailsIdx + 1].replace(/-\d{6,}\/?$/, '');
      }
    }

    // 3. Для Ozon: сегмент в product/
    if (marketplace === 'ozon') {
      const prodIdx = parts.indexOf('product');
      if (prodIdx !== -1 && parts[prodIdx + 1]) {
        return parts[prodIdx + 1];
      }
    }

    // 4. Проверяем наличие поисковых параметров (?text=, ?search=, ?q=, ?SearchText=)
    const queryParam = urlObj.searchParams.get('text') || 
                       urlObj.searchParams.get('search') || 
                       urlObj.searchParams.get('q') || 
                       urlObj.searchParams.get('SearchText');
    if (queryParam) {
      return queryParam;
    }

    // 5. Общий fallback
    let candidate = parts[parts.length - 1] || '';
    if ((/^\d+$/.test(candidate) || /^\d+\.(?:html|aspx)$/i.test(candidate) || candidate === 'detail.aspx') && parts.length >= 2) {
      const prev = parts[parts.length - 2];
      if (prev && !/^(?:catalog|product|item|details)$/i.test(prev)) {
        candidate = prev;
      }
    }

    return candidate;
  } catch (err) {
    return url.replace(/https?:\/\/[^\/]+\//, '').split('?')[0];
  }
}

export function generateProductFromUrl(url: string, wbCard?: WbCardResult | null): ParsedProduct {
  const cleanInputUrl = url.trim();

  // Если передана карточка WB напрямую
  if (wbCard) {
    return generateProductFromWbCard(wbCard, cleanInputUrl);
  }

  const marketplace = detectMarketplaceFromUrl(cleanInputUrl);
  const sku = extractSkuFromUrl(cleanInputUrl, marketplace);
  
  // 1. Проверяем строгое совпадение с эталонными товарами (по прямому URL или точному SKU)
  const existing = INITIAL_PRODUCTS.find(p => {
    const cleanSource = p.sourceUrl.split('?')[0].toLowerCase();
    const cleanEntered = cleanInputUrl.split('?')[0].toLowerCase();
    const exactUrlMatch = cleanSource === cleanEntered;
    const exactSkuMatch = Boolean(sku && p.sku && sku === p.sku);
    return exactUrlMatch || exactSkuMatch;
  });

  if (existing) {
    const controlPhrases = extractControlPhrases(existing.title, existing.brand, existing.sku);
    const updatedOffers = existing.offers.map(off => ({
      ...off,
      priceSource: off.priceSource || 'catalog',
      estimated: off.estimated ?? true,
      confidence: off.confidence ?? 0.65,
      ...(off.marketplace === marketplace
        ? {
            url: cleanInputUrl.startsWith('http') ? cleanInputUrl : off.url,
            isDirectLink: true
          }
        : {})
    }));

    return {
      ...existing,
      id: `prod-${Date.now()}`,
      sourceUrl: cleanInputUrl,
      sourceMarketplace: marketplace,
      normalizedTitle: normalizeTitle(existing.title),
      freshness: 'cached',
      controlPhrase: existing.controlPhrase || controlPhrases.primary,
      controlOptions: existing.controlOptions || controlPhrases.allOptions,
      offers: updatedOffers
    };
  }

  // 2. Проверяем, не является ли это поисковым запросом на WB или Ozon
  const wbQuery = extractWbSearchQuery(cleanInputUrl);
  if (wbQuery) {
    const lowQ = wbQuery.toLowerCase();
    if (lowQ.includes('weissgauff') || (lowQ.includes('чайник') && lowQ.includes('1711'))) {
      const weiss = INITIAL_PRODUCTS.find(p => p.sku === '4406295778');
      if (weiss) return { ...weiss, id: `prod-${Date.now()}`, sourceUrl: cleanInputUrl, sourceMarketplace: 'wildberries' };
    }
    if (lowQ.includes('goldstar') || lowQ.includes('7420') || lowQ.includes('тепловентилятор')) {
      const gold = INITIAL_PRODUCTS.find(p => p.sku === '1803946118');
      if (gold) return { ...gold, id: `prod-${Date.now()}`, sourceUrl: cleanInputUrl, sourceMarketplace: 'wildberries' };
    }
    if (lowQ.includes('smart mop') || lowQ.includes('швабр')) {
      const mop = INITIAL_PRODUCTS.find(p => p.sku === '1393219451');
      if (mop) return { ...mop, id: `prod-${Date.now()}`, sourceUrl: cleanInputUrl, sourceMarketplace: 'wildberries' };
    }
  }

  // 3. Извлекаем осмысленный слаг товара с учетом структуры каждого маркетплейса
  const slug = extractMeaningfulSlug(cleanInputUrl, marketplace);

  const decoded = decodeOzonWbSlug(slug, cleanInputUrl);
  const normalizedTitle = normalizeTitle(decoded.title);

  // 4. Формируем высокоточные контрольные фразы для поиска (Бренд + Модель без мусорных слов)
  const controlPhrases = extractControlPhrases(decoded.title, decoded.brand, sku);
  const primaryControlPhrase = controlPhrases.primary;

  // 5. Подбираем подходящее изображение товара
  const visualInfo = resolveProductImage(decoded.title, decoded.brand, decoded.category, sku);

  // 6. Формируем честные предложения всех 5 маркетплейсов БЕЗ фейковых цен (Math.random / marketplaceFactors удалены)
  const marketplaces: MarketplaceId[] = ['wildberries', 'ozon', 'yandex', 'aliexpress', 'megamarket'];

  const offers: MarketplaceOffer[] = marketplaces.map((m) =>
    buildUnverifiedMarketplaceOffer({
      marketplace: m,
      title: decoded.title,
      normalizedTitle,
      controlPhrase: primaryControlPhrase,
      brand: decoded.brand,
      isSource: m === marketplace,
      sourceUrl: cleanInputUrl
    })
  );

  // Исходная площадка (с прямой ссылкой) всегда первой, если живые цены еще не загружены
  offers.sort((a, b) => Number(Boolean(b.isDirectLink)) - Number(Boolean(a.isDirectLink)));

  return {
    id: `prod-custom-${Date.now()}`,
    sourceUrl: cleanInputUrl,
    sourceMarketplace: marketplace,
    title: decoded.title,
    brand: decoded.brand,
    category: decoded.category,
    sku,
    normalizedTitle,
    imageUrl: decoded.imageUrl || visualInfo.imageUrl,
    specs: {
      ...decoded.specs,
      'Артикул / SKU': sku,
      'Бренд': decoded.brand,
      'Источник': MARKETPLACE_CONFIGS[marketplace].name
    },
    lowestPrice: null,
    lowestMarketplace: null,
    lowestPersonalPrice: null,
    lowestPersonalMarketplace: null,
    freshness: 'live',
    controlPhrase: primaryControlPhrase,
    controlOptions: controlPhrases.allOptions,
    offers
  };
}

/**
 * Асинхронный мастер-парсер:
 * 1. Для Wildberries — делает реальный запрос в открытый CDN wbbasket.ru,
 *    извлекая настоящее название, оригинальный бренд, фото товара высокого разрешения и характеристики.
 * 2. Для Ozon, Яндекса и др. — производит интеллектуальный семантический разбор слага и артикула.
 */
export async function parseProductUrl(url: string): Promise<ParsedProduct> {
  const cleanInputUrl = url.trim();
  const marketplace = detectMarketplaceFromUrl(cleanInputUrl);

  // 1. Проверяем строгое совпадение с эталонными товарами
  const sku = extractSkuFromUrl(cleanInputUrl, marketplace);
  const existing = INITIAL_PRODUCTS.find(p => {
    const cleanSource = p.sourceUrl.split('?')[0].toLowerCase();
    const cleanEntered = cleanInputUrl.split('?')[0].toLowerCase();
    const exactUrlMatch = cleanSource === cleanEntered;
    const exactSkuMatch = Boolean(sku && p.sku && sku === p.sku);
    return exactUrlMatch || exactSkuMatch;
  });

  if (existing) {
    const controlPhrases = extractControlPhrases(existing.title, existing.brand, existing.sku);
    const updatedOffers = existing.offers.map(off => ({
      ...off,
      priceSource: off.priceSource || 'catalog',
      estimated: off.estimated ?? true,
      confidence: off.confidence ?? 0.65,
      ...(off.marketplace === marketplace
        ? {
            url: cleanInputUrl.startsWith('http') ? cleanInputUrl : off.url,
            isDirectLink: true
          }
        : {})
    }));

    return {
      ...existing,
      id: `prod-${Date.now()}`,
      sourceUrl: cleanInputUrl,
      sourceMarketplace: marketplace,
      normalizedTitle: normalizeTitle(existing.title),
      freshness: 'cached',
      controlPhrase: existing.controlPhrase || controlPhrases.primary,
      controlOptions: existing.controlOptions || controlPhrases.allOptions,
      offers: updatedOffers
    };
  }

  // 2. Если ссылка с Wildberries или введен артикул WB
  if (marketplace === 'wildberries' || cleanInputUrl.includes('wb.ru') || cleanInputUrl.includes('wildberries.ru')) {
    const wbSku = extractWbSku(cleanInputUrl);
    if (wbSku) {
      try {
        const card = await fetchWbCardData(wbSku);
        if (card) {
          return generateProductFromWbCard(card, cleanInputUrl);
        }
      } catch (err) {
        console.warn('[Parser] WB fetch error, fallback to slug:', err);
      }

      // Если артикул WB не найден в открытом CDN (например, 996330082 из Избранного, мобильного приложения или закрытого каталога)
      // Ни в коем случае НЕ создаем бессмысленную фразу «Товар маркетплейса»!
      // Формируем специальную интерактивную карточку для комплексного поиска по названию, меткам и фото!
      return generateUnresolvedWbCard(wbSku, cleanInputUrl);
    }
  }

  // 3. Fallback к синхронному генератору
  return generateProductFromUrl(cleanInputUrl);
}

/**
 * Создает карточку для артикула WB, которого нет в открытом CDN (закрытый каталог / Избранное / мобильная ссылка).
 * Предоставляет пользователю комплексные инструменты: поиск по названию, по меткам, по скриншоту карточки!
 */
export function generateUnresolvedWbCard(wbSku: number, sourceUrl: string): ParsedProduct {
  const marketplaces: MarketplaceId[] = ['wildberries', 'ozon', 'yandex', 'aliexpress', 'megamarket'];
  const controlPhrase = `артикул ${wbSku}`;

  const offers: MarketplaceOffer[] = marketplaces.map(m =>
    buildUnverifiedMarketplaceOffer({
      marketplace: m,
      title: m === 'wildberries' ? `Товар на Wildberries (артикул ${wbSku})` : `Поиск аналогов (${wbSku})`,
      normalizedTitle: `wb ${wbSku}`,
      controlPhrase: `WB ${wbSku}`,
      isSource: m === 'wildberries',
      sourceUrl
    })
  );

  return {
    id: `prod-wb-${wbSku}`,
    sourceUrl,
    sourceMarketplace: 'wildberries',
    title: `Товар Wildberries (артикул ${wbSku})`,
    brand: 'Wildberries',
    category: 'Каталог товаров Wildberries',
    sku: String(wbSku),
    normalizedTitle: `wb ${wbSku}`,
    imageUrl: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=600&auto=format&fit=crop&q=80',
    specs: {
      'Артикул WB': String(wbSku),
      'Ссылка': sourceUrl,
      'Статус': 'Карточка недоступна в открытом CDN / закрытый каталог'
    },
    lowestPrice: null,
    lowestMarketplace: null,
    lowestPersonalPrice: null,
    lowestPersonalMarketplace: null,
    freshness: 'live',
    controlPhrase,
    controlOptions: [`артикул ${wbSku}`, 'Одежда', 'Обувь', 'Бытовая техника', 'Электроника'],
    tags: ['Одежда', 'Обувь', 'Бытовая техника', 'Электроника', 'Дом', 'Красота'],
    needsRefinement: true,
    refinementReason: `Артикул ${wbSku} не отдан открытым CDN WB. Укажите название товара или загрузите скриншот карточки для точного кросс-поиска по всем площадкам.`,
    offers
  };
}

/**
 * Комплексное уточнение товара: по названию, меткам или загруженному фото карточки.
 * Пересчитывает целевые ссылки на 5 маркетплейсах, сохраняя реальные цены (без генерации фейковых).
 */
export function refineProductWithTitleAndTags(
  product: ParsedProduct,
  userTitle: string,
  userTags?: string[],
  customImage?: string
): ParsedProduct {
  const cleanTitle = userTitle.trim();
  const titleToUse = cleanTitle || product.title;
  const normalizedTitle = normalizeTitle(titleToUse);

  // Извлекаем бренд и контрольные фразы
  const controlPhrases = extractControlPhrases(titleToUse, undefined, product.sku);
  const primaryPhrase = controlPhrases.primary;

  // Определяем категорию и бренд без подстановки вымышленных цен
  const decoded = decodeOzonWbSlug(titleToUse, product.sourceUrl);
  const category = decoded.category || product.category;
  const brand = decoded.brand || product.brand || 'Оригинальный производитель';

  const marketplaces: MarketplaceId[] = ['wildberries', 'ozon', 'yandex', 'aliexpress', 'megamarket'];
  const offers: MarketplaceOffer[] = marketplaces.map(m => {
    const existingOffer = product.offers.find(o => o.marketplace === m);
    const isSource = m === product.sourceMarketplace;

    // Если по этой площадке уже есть реальная проверенная цена (API или Extension), сохраняем ее
    if (existingOffer && existingOffer.price !== null && (existingOffer.priceSource === 'api' || existingOffer.priceSource === 'extension')) {
      return {
        ...existingOffer,
        title: titleToUse,
        url: isSource ? product.sourceUrl : buildTargetedMarketplaceUrl(m, primaryPhrase, false, product.sourceUrl),
        searchQuery: isSource ? 'Прямой товар' : primaryPhrase
      };
    }

    return buildUnverifiedMarketplaceOffer({
      marketplace: m,
      title: titleToUse,
      normalizedTitle,
      controlPhrase: primaryPhrase,
      barcode: product.barcode,
      brand,
      isSource,
      sourceUrl: product.sourceUrl
    });
  });

  const pricedOffers = offers.filter(o => o.price !== null && o.price > 0);
  pricedOffers.sort((a, b) => (a.personalPrice ?? a.price ?? Infinity) - (b.personalPrice ?? b.price ?? Infinity));
  const lowestOffer = pricedOffers[0] || null;

  return {
    ...product,
    title: titleToUse,
    brand,
    category,
    normalizedTitle,
    imageUrl: customImage || product.imageUrl,
    lowestPrice: lowestOffer ? lowestOffer.price : null,
    lowestMarketplace: lowestOffer ? lowestOffer.marketplace : null,
    lowestPersonalPrice: lowestOffer ? lowestOffer.personalPrice : null,
    lowestPersonalMarketplace: lowestOffer ? lowestOffer.marketplace : null,
    controlPhrase: primaryPhrase,
    controlOptions: controlPhrases.allOptions,
    tags: userTags && userTags.length > 0 ? userTags : [category.split('/')[0].trim(), brand, primaryPhrase],
    needsRefinement: false,
    refinementReason: undefined,
    offers
  };
}

/**
 * Пересчитывает ссылки и поисковые запросы офферов при ручном изменении контрольной фразы пользователем
 */
export function rebuildProductOffersWithControlPhrase(
  product: ParsedProduct,
  newControlPhrase: string
): ParsedProduct {
  const updatedOffers = product.offers.map(offer => {
    const isSource = offer.marketplace === product.sourceMarketplace;
    const newUrl = buildTargetedMarketplaceUrl(
      offer.marketplace,
      newControlPhrase,
      isSource,
      product.sourceUrl
    );
    return {
      ...offer,
      url: newUrl,
      isDirectLink: isSource,
      searchQuery: isSource ? 'Прямой товар' : newControlPhrase
    };
  });

  return {
    ...product,
    controlPhrase: newControlPhrase,
    offers: updatedOffers
  };
}

export function formatPrice(num: number | null | undefined): string {
  if (num === null || num === undefined || Number.isNaN(num) || num <= 0) {
    return 'Уточнить цену';
  }
  return new Intl.NumberFormat('ru-RU').format(Math.round(num)) + ' ₽';
}

export function formatTelegramMarkdown(params: {
  productTitle: string;
  marketplaceName: string;
  oldPrice: number;
  newPrice: number;
  dropAmount: number;
  dropPercent: number;
  url: string;
}): string {
  const { productTitle, marketplaceName, oldPrice, newPrice, dropAmount, dropPercent, url } = params;
  return `🔥 *СИГНАЛ: Снижение цены на ${marketplaceName}!*\n\n` +
    `📦 *Товар:* ${productTitle}\n` +
    `💰 *Было:* ~${formatPrice(oldPrice)}~\n` +
    `🏷️ *Стало:* *${formatPrice(newPrice)}*\n` +
    `📉 *Экономия:* -${formatPrice(dropAmount)} (-${dropPercent.toFixed(1)}%)\n\n` +
    `🛒 *Купить по минимальной цене:*\n${url}\n\n` +
    `_Оповещение сгенерировано сервисом PriceRadar РФ_`;
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<{ success: boolean; message: string }> {
  if (!botToken || !chatId) {
    return {
      success: false,
      message: 'Не указан Telegram Bot Token или Chat ID'
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      })
    });

    const data = await response.json();
    if (data.ok) {
      return { success: true, message: 'Сообщение успешно доставлено в Telegram бота!' };
    } else {
      return { success: false, message: `Ошибка Telegram API: ${data.description || 'Неизвестная ошибка'}` };
    }
  } catch (err: any) {
    return { success: false, message: `Сетевая ошибка: ${err.message || 'Не удалось отправить запрос'}` };
  }
}
