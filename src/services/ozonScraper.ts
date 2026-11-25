// Модуль кросс-поиска для внешних маркетплейсов (Ozon, Яндекс Маркет, AliExpress, Мегамаркет)
// Строго без генерации случайных или вымышленных цен (Math.random / хардкод-коэффициенты запрещены)

import { MarketplaceId, MarketplaceOffer } from '../types';
import { MARKETPLACE_CONFIGS } from '../data/mockCatalog';
import { buildTargetedMarketplaceUrl } from './searchQueryOptimizer';

export interface ExternalMarketplaceLookupParams {
  marketplace: MarketplaceId;
  title: string;
  normalizedTitle: string;
  controlPhrase: string;
  barcode?: string;
  brand?: string;
  isSource?: boolean;
  sourceUrl?: string;
}

export interface ExternalPriceResult {
  price: number | null;
  oldPrice: number | null;
  personalPrice: number | null;
  isSearching: boolean;
  priceSource: 'extension' | 'api' | 'unavailable';
  confidence: number;
  url: string;
  searchQuery: string;
}

/**
 * Формирует поисковую ссылку с приоритетом штрихкода (EAN-13 / barcode),
 * а при его отсутствии — по контрольной фразе или очищенному названию.
 */
export function buildBarcodePrioritizedUrl(
  marketplace: MarketplaceId,
  params: { barcode?: string; controlPhrase?: string; normalizedTitle?: string; isSource?: boolean; sourceUrl?: string }
): { url: string; searchQuery: string } {
  const { barcode, controlPhrase, normalizedTitle, isSource, sourceUrl } = params;

  if (isSource && sourceUrl && sourceUrl.startsWith('http')) {
    return {
      url: sourceUrl,
      searchQuery: controlPhrase || normalizedTitle || 'Прямой товар'
    };
  }

  const effectiveQuery = (barcode && /^\d{8,14}$/.test(barcode.trim()))
    ? barcode.trim()
    : (controlPhrase?.trim() || normalizedTitle?.trim() || '');

  return {
    url: buildTargetedMarketplaceUrl(marketplace, effectiveQuery, false, sourceUrl),
    searchQuery: effectiveQuery
  };
}

/**
 * Заглушка-сервис получения живой цены с Ozon и других закрытых антиботом площадок.
 * TODO: Интегрировать Playwright/Puppeteer (только с резидентными прокси и playwright-stealth),
 * официальный Ozon Seller / Partner API или приемник снимков Browser Extension (/api/v1/prices/from-extension).
 *
 * ВАЖНО: Никогда не генерирует случайные или ориентировочные цены при отсутствии реального ответа.
 */
export async function lookupExternalMarketplacePrice(
  params: ExternalMarketplaceLookupParams
): Promise<ExternalPriceResult> {
  const { url, searchQuery } = buildBarcodePrioritizedUrl(params.marketplace, {
    barcode: params.barcode,
    controlPhrase: params.controlPhrase,
    normalizedTitle: params.normalizedTitle,
    isSource: params.isSource,
    sourceUrl: params.sourceUrl
  });

  // TODO: Требуется API ключ, прокси-инфраструктура (Playwright) или Browser Extension.
  // Возвращаем честную структуру с price: null вместо вымышленных чисел.
  return {
    price: null,
    oldPrice: null,
    personalPrice: null,
    isSearching: false,
    priceSource: 'unavailable',
    confidence: 0,
    url,
    searchQuery
  };
}

/**
 * Синхронная сборка честного предложения (MarketplaceOffer) для маркетплейса,
 * по которому живая цена еще не получена через API или расширение.
 */
export function buildUnverifiedMarketplaceOffer(
  params: ExternalMarketplaceLookupParams
): MarketplaceOffer {
  const config = MARKETPLACE_CONFIGS[params.marketplace];
  const isSource = Boolean(params.isSource);
  const { url, searchQuery } = buildBarcodePrioritizedUrl(params.marketplace, {
    barcode: params.barcode,
    controlPhrase: params.controlPhrase,
    normalizedTitle: params.normalizedTitle,
    isSource,
    sourceUrl: params.sourceUrl
  });

  const sellerLabel = isSource
    ? `${config.name} (прямая карточка)`
    : `Каталог ${config.name}`;

  return {
    marketplace: params.marketplace,
    title: params.title,
    price: null,
    oldPrice: null,
    personalPrice: null,
    personalDiscountPercent: config.typicalDiscount,
    sellerName: sellerLabel,
    sellerRating: 0,
    deliveryDate: 'На площадке',
    deliverySpeed: 'Условия на сайте магазина',
    url,
    inStock: true,
    isLowest: false,
    isDirectLink: isSource,
    isSearching: false,
    priceSource: 'unavailable',
    confidence: 0,
    estimated: false,
    availabilityStatus: 'price_unverified',
    availabilityNote: isSource
      ? 'Антибот площадки ограничивает автополучение цены — откройте карточку для точной цены с учётом вашей карты/СПП.'
      : 'Живая цена не получена автоматически — откройте целевой поиск на площадке для сравнения.',
    searchQuery
  };
}
