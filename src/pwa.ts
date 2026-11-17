// Keeps the installed app up to date. When a new version is deployed, the service
// worker downloads it and the page reloads into it, instead of needing two launches.
import { registerSW } from 'virtual:pwa-register';

export function setupUpdates() {
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (navigator.onLine) reg.update().catch(() => {});
      };
      // iPhone home-screen apps are resumed rather than relaunched, so check
      // whenever the app comes back to the foreground, and hourly while open.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, 60 * 60 * 1000);
    },
  });
}
