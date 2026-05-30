import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import { BrakeModal } from '@/components/BrakeModal';
import { GuideOverlay } from '@/components/GuideOverlay';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastContainer } from '@/components/ToastContainer';
import { ConfirmProvider } from '@/components/useConfirm';
import '@xterm/xterm/css/xterm.css';
import './theme-tokens.css';
import './globals.css';
import './console-shell.css';
import './console-controls.css';

const visualThemeBootstrapScript = `
(() => {
  const storageKey = 'clowder:visual-theme';
  const migrationKey = 'clowder:visual-theme-default:v4';
  const validThemes = new Set(['claude', 'slockv1', 'slock', 'kami']);
  const defaultTheme = 'slock';
  try {
    const migrated = window.localStorage.getItem(migrationKey) === '1';
    const stored = window.localStorage.getItem(storageKey);
    const normalizedStored = stored === 'tesla' ? 'slockv1' : stored;
    const nextTheme = migrated && validThemes.has(normalizedStored) ? normalizedStored : defaultTheme;
    document.documentElement.dataset.visualTheme = nextTheme;
    window.localStorage.setItem(storageKey, nextTheme);
    window.localStorage.setItem(migrationKey, '1');
  } catch {
    document.documentElement.dataset.visualTheme = defaultTheme;
  }
})();
`;

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#E29578',
};

export const metadata: Metadata = {
  title: 'Clowder AI',
  description: 'Your AI team collaboration space',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icons/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Clowder AI',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-visual-theme="slock" suppressHydrationWarning>
      <body className="min-h-screen">
        <script dangerouslySetInnerHTML={{ __html: visualThemeBootstrapScript }} />
        <SessionBootstrap />
        <ThemeProvider>
          <ConfirmProvider>
            <AppShell>{children}</AppShell>
          </ConfirmProvider>
          <BrakeModal />
          <GuideOverlay />
          <ToastContainer />
        </ThemeProvider>
      </body>
    </html>
  );
}
