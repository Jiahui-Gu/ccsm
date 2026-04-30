# Contributing to ccsm

## Local development

- Use Node 20.x for local builds. CI runs on 20.x.
- On Windows, native modules require VS Build Tools with C++/CX SDK (full VS 2022, not just BuildTools).

## Debugging the Electron main process

Set `CCSM_ELECTRON_INSPECT=1` when running `npm run dev:app` (or `npm run dev`) to spawn the Electron main process with `--inspect=9229`. Without the env var, no inspector port is opened.

```sh
CCSM_ELECTRON_INSPECT=1 npm run dev:app
```

Attach Chrome DevTools via `chrome://inspect` or a VS Code launch config (T67 wires a launch.json compound).
