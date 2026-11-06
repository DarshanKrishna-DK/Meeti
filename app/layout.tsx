import type { Metadata } from 'next';
import './globals.css';
import { MEETI_TITLE, MEETI_TAGLINE } from '@/packages/shared/src/brand';
export const metadata: Metadata = { title: MEETI_TITLE, description: MEETI_TAGLINE };
const themeInitializer = "(function(){var theme='light';try{if(localStorage.getItem('meeti.theme')==='dark')theme='dark';}catch(error){}document.documentElement.dataset.theme=theme;})();";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth" data-theme="light" suppressHydrationWarning><head><script id="meeti-theme-initializer" dangerouslySetInnerHTML={{ __html: themeInitializer }} /></head><body>{children}</body></html>;
}
