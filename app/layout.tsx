import type { Metadata } from 'next';
import './globals.css';
import { MEETI_TITLE, MEETI_TAGLINE } from '@/packages/shared/src/brand';
export const metadata: Metadata = { title: MEETI_TITLE, description: MEETI_TAGLINE };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>; }
