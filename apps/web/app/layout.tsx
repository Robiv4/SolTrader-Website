import './globals.css';
import './terminal.css';

import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import type { ReactNode } from 'react';

import { AppShell } from './components';
import { THEME_BOOT_SCRIPT } from './theme-script';

const jakarta = Plus_Jakarta_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-display', weight: ['400', '500', '600', '700', '800'], display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Soltrader',
  description: 'Solana memecoin paper-trading terminál',
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f6fb' }, { media: '(prefers-color-scheme: dark)', color: '#090c12' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="hu" data-theme="dark" className={`${jakarta.variable} ${mono.variable}`} suppressHydrationWarning>
      {/* Applies the remembered light/dark choice before the first paint. */}
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head>
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
