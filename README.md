# Sewer Showdown

NES-style multiplayer browser MMO. Drive the Party Wagon across a procedurally generated world, visit artist galleries, and play with others in real time.

## Architecture

```
├── index.html              # Game client (vanilla JS, canvas)
├── js/
│   ├── game.js             # Rendering, input, procedural buildings
│   ├── multiplayer.js      # WebSocket client, prediction, auth
│   └── shared/             # Code shared between client & server
├── server/                 # Node.js authoritative MMO server
│   └── src/
│       ├── auth/           # JWT auth, rate limiting
│       ├── realtime/       # WebSocket server, sim tick loop, AOI
│       ├── zones/          # Zone manager, collision, presence
│       ├── ugc/            # User-generated content pipeline
│       └── db/             # Postgres migrations
├── scripts/
│   └── urban_plan.py       # Procedural city & road generation
├── data/                   # World, region, level JSON data
├── sprites/                # NES-style sprite assets
└── render.yaml             # Render.com deployment blueprint
```

## Quick Start

### Client only (no multiplayer)

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

### Full stack (multiplayer)

```bash
# 1. Start Postgres and create the database
createdb sewer_showdown

# 2. Copy env and edit as needed
cp server/.env.example server/.env

# 3. Install dependencies
npm install

# 4. Run migrations
npm run migrate

# 5. Start server + client
npm run dev
```

The game server runs on `:3000` (WebSocket + REST).
The client runs on `:8080` and auto-detects the server.

## Regenerating the Map

```bash
npm run gen:map
```

This runs `scripts/urban_plan.py` which rebuilds `data/regions/na.json` with highways, arterials, local streets, blocks, zoning, and building placement.

## Deployment

The repo includes a `render.yaml` blueprint for [Render.com](https://render.com):

- **sewer-showdown-server** — Node.js web service (WebSocket + REST API)
- **sewer-showdown-client** — Static site serving the game client
- **sewer-showdown-db** — Managed Postgres database

Deploy with: Render Dashboard → New → Blueprint → connect this repo.

The client auto-detects whether to connect to `localhost:3000` or the production Render service.

## Controls

- **Arrow Keys / WASD** — Drive
- **Enter / Space** — Interact with buildings
- **Mobile** — Touch controls

## Stack

- **Client**: Vanilla JS, Canvas 2D, procedural NES-style renderer
- **Server**: Node.js, Express, ws (WebSocket), PostgreSQL
- **Auth**: JWT (guest + registered accounts)
- **Multiplayer**: Authoritative server, client prediction, server reconciliation, AOI
- **Map gen**: Python (A* routing, Prim MST, zone classification, lot generation)
