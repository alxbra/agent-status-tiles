import { useEffect, type ReactElement } from 'react';

function useSystemAppearance(): void {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateAppearance = (): void => {
      document.documentElement.classList.toggle('dark', mediaQuery.matches);
    };

    updateAppearance();
    mediaQuery.addEventListener('change', updateAppearance);
    return () => mediaQuery.removeEventListener('change', updateAppearance);
  }, []);
}

export function App(): ReactElement {
  useSystemAppearance();

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
    </main>
  );
}
