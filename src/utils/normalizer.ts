// Модуль нормализации заголовков и извлечения атрибутов для точного кросс-поиска и матчинга товаров

const MARKETING_STOP_WORDS = new Set([
  'хит', 'скидка', 'распродажа', 'оригинал', 'новинка', 'акция', 'срочно',
  'суперцена', 'выгода', 'подарок', 'топ', 'лучший', 'бесплатная', 'доставка',
  'bestseller', 'sale', 'new', 'hot', 'top', 'original', 'promo', 'deal',
  'мужской', 'мужская', 'мужское', 'мужские',
  'женский', 'женская', 'женское', 'женские',
  'унисекс', 'unisex',
  '2022', '2023', '2024', '2025', '2026',
  'купить', 'цена', 'гарантия', 'рст', 'еас', 'eac', 'global', 'версия', 'ростест', 'евротест'
]);

const COLOR_WORDS = new Set([
  'черный', 'чёрный', 'черная', 'чёрная', 'черное', 'черные',
  'белый', 'белая', 'белое', 'белые',
  'серый', 'серая', 'серое', 'серые', 'серебристый', 'серебристая',
  'синий', 'синяя', 'голубой', 'голубая',
  'красный', 'красная', 'розовый', 'розовая',
  'зеленый', 'зелёный', 'зеленая', 'зелёная',
  'желтый', 'жёлтый', 'оранжевый', 'фиолетовый',
  'бежевый', 'коричневый', 'золотой', 'золотистый', 'титан', 'графит',
  'black', 'white', 'silver', 'gold', 'gray', 'grey', 'blue', 'red', 'green', 'pink', 'titanium', 'navy', 'beige'
]);

const SIZE_TOKENS = new Set([
  'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl', '4xl', 'onesize'
]);

export interface ExtractedAttributes {
  colors: string[];
  sizes: string[];
  memoryOrVolume: string[];
}

/**
 * Извлекает ключевые атрибуты (цвет, размер, память/объем) из заголовка товара,
 * чтобы сравнивать их отдельно от базового названия модели.
 */
export function extractAttributes(title: string): ExtractedAttributes {
  const lower = (title || '').toLowerCase();
  const colors: string[] = [];
  const sizes: string[] = [];
  const memoryOrVolume: string[] = [];

  const tokens = lower.replace(/[^\p{L}\p{N}\s./-]+/gu, ' ').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (COLOR_WORDS.has(token) && !colors.includes(token)) {
      colors.push(token);
    }
    if (SIZE_TOKENS.has(token) && !sizes.includes(token.toUpperCase())) {
      sizes.push(token.toUpperCase());
    }
  }

  const ruSizeMatches = lower.match(/\b\d{2}\s*(?:размер|р-р|р\.)\b/gi);
  if (ruSizeMatches) {
    ruSizeMatches.forEach(m => {
      const clean = m.trim();
      if (!sizes.includes(clean)) sizes.push(clean);
    });
  }

  const memMatches = lower.match(/\b\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб|ml|мл|l|л|mm|мм|вт|w|mah|мач)\b/gi);
  if (memMatches) {
    memMatches.forEach(m => {
      const clean = m.replace(/\s+/g, '').toLowerCase();
      if (!memoryOrVolume.includes(clean)) memoryOrVolume.push(clean);
    });
  }

  return { colors, sizes, memoryOrVolume };
}

/**
 * Умная нормализация названия товара для точного кросс-поиска:
 * - Приводит к нижнему регистру и удаляет лишнюю пунктуацию
 * - Вырезает маркетинговые стоп-слова, года, цвета и размеры одежды
 * - Сохраняет бренд, модельный индекс и смысловые слова категории (включая «детский» для игрушек)
 */
export function normalizeTitle(title: string): string {
  if (!title) return '';

  const cleaned = title
    .toLowerCase()
    // Удаляем выражения вида «42 размер», «размер 44», «р-р 46»
    .replace(/\b\d{2}\s*(?:размер[а-я]*|р-р)\b/gi, ' ')
    .replace(/\b(?:размер[а-я]*|р-р)\s*\d{2}\b/gi, ' ')
    // Удаляем пунктуацию кроме дефисов внутри кодов моделей (например CW-7420W)
    .replace(/[()[\]{}"'«».,:;!?/\\|+_*~@#$%^&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(word => {
    if (!word || word.length < 2) {
      // Сохраняем одиночные цифры только если это часть модели (не изолированный мусор)
      return /^\d$/.test(word);
    }
    if (MARKETING_STOP_WORDS.has(word)) return false;
    if (COLOR_WORDS.has(word)) return false;
    if (SIZE_TOKENS.has(word)) return false;
    return true;
  });

  // Убираем подряд идущие дубликаты слов
  const deduped: string[] = [];
  for (const w of words) {
    if (deduped[deduped.length - 1] !== w) {
      deduped.push(w);
    }
  }

  return deduped.join(' ').trim();
}
