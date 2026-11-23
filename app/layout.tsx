import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NitroStack Knowledge Engine',
  description: 'Search your workspace documents and get answers with source citations.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
