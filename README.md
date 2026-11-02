# Infinite World

Infinite World is a browser prototype for a free-flight, procedurally generated terrain system that behaves like a much larger world than the amount of geometry held in memory.

The prototype focuses on the engineering problems behind that illusion: deterministic world-space terrain, level-of-detail streaming, seam handling, floating render origins, forward prefetch, bounded tile counts, and responsive high-speed flight.

## Highlights

- Deterministic terrain from `(seed, worldX, worldZ)` coordinates.
- Layered continental, ridged-mountain, erosion-like, and detail signals.
- Multi-level terrain tiles with distance-aware LOD.
- Preview-first generation and prioritized replacement with higher-detail tiles.
- Flight-direction prefetch so terrain is prepared ahead of the camera.
- Tile eviction to keep the loaded world finite.
- Floating render origin to reduce precision problems at large coordinates.
- Terrain skirts and LOD-aware bounds to reduce visible seams.
- Lightweight atmosphere, fog, clouds, sun, and flight HUD.

## Run locally

No build step is required. Serve the directory with any static HTTP server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a modern browser with WebGL support.

The only runtime library is Three.js 0.160.0, loaded as an ES module from unpkg.

## Structure

- `index.html` — page shell, controls, and HUD.
- `src/main.js` — renderer, flight controls, streaming/LOD scheduler, atmosphere, and world-origin management.
- `src/terrain.js` — deterministic terrain field and terrain mesh/material generation.
- `tasks/` — development notes retained for implementation context.

## Scope

This is an algorithm prototype, not a finished game. It intentionally uses browser-native JavaScript and WebGL/Three.js so the streaming and terrain ideas can be tested without a game-engine build pipeline. The long-term visual scale is aspirational; the repository demonstrates the prototype mechanisms rather than claiming a production-scale world engine.

## License

Code in this repository is released under the MIT License. Three.js is an external dependency distributed under its own MIT License.
