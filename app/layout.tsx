import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Meeti | Good connections begin with permission', description: 'Your agent finds the right people. You decide who gets to meet you.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>; }
