import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';

/**
 * English and French, chosen from the browser's Accept-Language header.
 *
 * No locale prefix in the URL, and no cookie. A self-hosted instance has one
 * household reading it, and `/fr/app` alongside `/en/app` would double every
 * route and every link for a choice nobody wants to make twice. The header
 * already carries the answer.
 *
 * The consequence, stated because it is a real one: two people sharing an
 * instance can see it in different languages, and a link one sends the other
 * opens in the reader's. That is correct behaviour here — the language belongs
 * to the reader, not to the page.
 *
 * A stored preference belongs on the user record and comes with the settings
 * screen; until then the header is the better guess, and never a wrong one for
 * long.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function resolveLocale(acceptLanguage: string | null): Locale {
  if (acceptLanguage === null) return DEFAULT_LOCALE;

  // Accept-Language is a weighted list: "fr-FR,fr;q=0.9,en;q=0.8". Parsed
  // rather than string-matched, so "en-GB,fr;q=0.9" picks English — a substring
  // test for "fr" would get that backwards.
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase(), q: q === undefined ? 1 : Number(q.split('=')[1]) };
    })
    .filter((entry) => Number.isFinite(entry.q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split('-')[0];
    const match = LOCALES.find((locale) => locale === base);
    if (match !== undefined) return match;
  }
  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = resolveLocale((await headers()).get('accept-language'));
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
