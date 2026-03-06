# ShinyStar (MediaPipe)

Single-page camera app that detects a gold star icon using:

1. Gold-color candidate extraction (filters gray/white background)
2. MediaPipe `ImageEmbedder` similarity against your star template
3. Stable-frame confirmation + beep alert

## Run

Use any static server from the project folder:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Deploy To GitHub Pages (iPhone-ready HTTPS)

This repo now includes a Pages workflow at `.github/workflows/deploy-pages.yml`.

1. Push `main`.
2. In GitHub: `Settings -> Pages`.
3. Under `Build and deployment`, set `Source` to `GitHub Actions`.
4. Wait for the `Deploy GitHub Pages` workflow to finish.

Your site URL should be:

- `https://medicd21.github.io/ShinyStar/`

## Workflow

1. Click **Start Camera**
2. Click **Load Template** (auto tries `star.png`, then `8.png`)
3. Draw ROI around the area where stars appear
4. Click **Calibrate ROI** while a known star is visible
5. Click **Start Scan**

## Key Settings

- **Match Threshold**: Higher = stricter matching
- **Stable Frames**: Number of consecutive hits required before alert
- **Min Gold Ratio**: Requires enough yellow pixels in candidate
- **Min Gold Pixels**: Rejects tiny yellow noise
- **Scan Interval**: Lower = faster checks, more CPU
- **Beep Cooldown**: Minimum time between beeps

## Notes

- Manual zoom/focus controls are enabled when the camera exposes those capabilities.
- For GitHub Pages, keep using this static `index.html` setup (no React/Vite entrypoint required).
