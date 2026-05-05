# Migration File Groups

This project should not be migrated by copying everything. Some folders are
generated, reinstallable, or disposable analysis history.

## Copy: project code and boot files

These are small and should move with the project. They may be edited when the
app changes.

- `src/`
- `public/`
- `scripts/`
- `tests/`
- `backtest/`
- `mt5_bridge.py`
- `package.json`
- `package-lock.json`
- `requirements.txt`
- `jest.config.js`
- `start.bat`
- `start-remote.bat`
- `.env.example`
- `.gitignore`
- `.gitattributes`
- `README.md`

## Copy if preserving your current setup

These contain local runtime state. Copy them when moving your own running setup
to another machine.

- `data/config/` - important app/user/strategy/risk configuration.
- `data/trading/` - trading records, current positions, paper/live trade data.
- `.env` - local environment settings. Review it on the new machine because
  paths, ports, and credentials may need to change.

## Optional or disposable

These can be skipped when you only want a clean migration. The app can recreate
most of them.

- `data/history/` - backtest, optimizer, decision audit, execution audit.
- `data/economic-calendar.json`
- `data/logs/`
- `logs/`
- `coverage/`
- `tmp/`
- `.codex-server.out`
- `.codex-server.err`
- `__pycache__/`

## Do not copy: reinstallable or generated

These are large or machine-specific. Reinstall them after migration.

- `node_modules/` - reinstall with `npm ci --omit=dev` for production, or
  `npm ci` if you need tests/dev tools.
- `node-portable/` - `start.bat` can download it again if system Node.js is not
  available.
- `ngrok-portable/` - only needed for remote access; reinstall or let the remote
  setup recreate it.

## Optional: copy only for development history

- `.git/` - needed only if you want Git history/branches on the new machine.
- `.claude/` - local agent/worktree state, not needed to run the app.

## Reinstall commands on the new machine

From the project root:

```powershell
npm ci --omit=dev
pip install -r requirements.txt
```

For development/testing instead:

```powershell
npm ci
npm test -- --runInBand
```

## Small migration package

For a lightweight move, copy only:

- project code and boot files
- `data/config/`
- `data/trading/`
- `.env` if migrating your own private setup

Skip `node_modules/`, `data/history/`, `logs/`, `coverage/`, `tmp/`,
`node-portable/`, and `ngrok-portable/`.
