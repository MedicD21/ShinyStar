# ShinyStar

Vite + React + TypeScript implementation of the Charmander Star Detector.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Notes

- Draw a search area on the video feed before starting detection.
- Detection performance was improved by matching only the selected ROI each frame (instead of preprocessing the full frame).
