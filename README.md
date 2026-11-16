# Country Quiz

Learn where all 197 countries are, one region at a time, then take the timed whole-world quiz.

- **Explore**: tap countries to see names and save memory hooks
- **Find it**: tap the named country on the map
- **Name it**: type the name of the highlighted country
- **Timed challenge**: type every country in a region (or the world) against the clock

Spaced repetition (FSRS) schedules reviews. Progress is stored on the device for now.

## Run it

```sh
npm install
npm run dev      # local dev server
npm run build    # production build in dist/ (installable, works offline)
```

Map data: Natural Earth via the `world-atlas` package. Built with Vite, TypeScript, D3, ts-fsrs and vite-plugin-pwa.

## Hosting

Every push to `main` builds the app and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**.
