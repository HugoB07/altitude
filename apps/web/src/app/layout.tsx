import type { Metadata } from 'next';
import { Geist, Geist_Mono, Inter } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import './globals.css';
import { cn } from '@/lib/utils';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Altitude',
  description: 'Self-hosted wealth tracking.',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // Resolved from Accept-Language in src/i18n/request.ts, so `lang` is the
  // language actually rendered rather than a hardcoded guess - screen readers
  // and translation tools both read it.
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      className={cn(
        'h-full',
        'dark',
        'antialiased',
        geistSans.variable,
        geistMono.variable,
        'font-sans',
        inter.variable,
      )}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
