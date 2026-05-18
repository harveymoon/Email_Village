# Email Village

A tiny top-down village where every **unread Gmail thread is a person walking around**. Walk up to them, click to read or move, drag emails between buildings (= Gmail labels), make filter rules straight from a sender's profile, and watch unread count drain visually as the town quiets down.

Built on Phaser 4 + Vite for the game scene, Express + googleapis on the backend, multi-account Gmail OAuth, and a fully composable LimeZu Modern Interiors sprite stack for the avatars.

![Screenshot — overview](docs/screenshots/01-overview.png)

## Why

Inbox Zero gamified. Filing emails feels like sorting your village. Each label is a building, each sender is a recurring NPC who shows up at their building with the unread count above their head, and the player wanders the map clicking through them. The map is hand-authored in Tiled, the avatars are randomly generated (and editable) layered LimeZu Modern Interiors sprites, and there's a full rule editor that talks to Gmail's filter API.

## Features

- **One NPC per (sender × building).** A sender with 5 unread emails in your `Shopping` building shows up as one NPC carrying 5 threads — click for a list, Read, Move per thread, or "Move all".
- **Multi-account Gmail OAuth.** Bring as many Gmail accounts as you like; labels with the same name across accounts merge into one building.
- **Live in-world moves.** Move a thread → the NPC physically walks from its building to the destination building's door, then despawns (or returns home if they have more to deliver).
- **Floors per building.** A building bound to a parent label (`Projects/Archive`) collapsibly groups its sub-labels (`Projects/Archive/NTT`, `Projects/Archive/Mozfest`, …) into floors inside the popup. Move emails between floors with one click.
- **Suggested destinations.** When you open any Move-to picker, the system suggests buildings based on (1) other emails from the same sender already filed there, (2) same-domain history, (3) label-name vs. email-domain fuzzy match. Suggestions float to the top with a green tag.
- **Rule management.** A full Gmail-style filter editor — criteria (from, to, subject, has-the-words, …) and actions (apply label, archive, mark read, star, never spam), with the matching rules for any sender visible right on their profile popup.
- **Layered avatars.** Each sender gets a deterministic random LimeZu chibi sprite (body + eyes + outfit + hairstyle + optional accessory). Customize anyone via the character builder; the in-world Phaser texture re-composes live the moment you save.
- **Region banner.** Walk into a Tiled `Regions` polygon → its name banners across the top. Pair regions with a `labelPrefix` custom property to filter building-label dropdowns.
- **Pathfinding with personality.** A* on a cost grid, "step right" sidesteps when two NPCs collide head-on, idle NPCs flee out of the way of travelers, target jitter so two NPCs don't fight over the same door pixel.
- **Off-screen arrow.** When there's no NPC nearby, a small yellow arrow floats 2 tiles in front of the player pointing toward the closest unread email.
- **Hotkeys:** `T` map · `B` buildings · `U` people · `F` rules · `R` refresh · `P` paths · `G` grid · `C` call nearest NPC · `H` home

## Screenshots

> Drop screenshots into `docs/screenshots/` with the names below and they'll render here.

| | |
| --- | --- |
| **Overview** — village with NPCs roaming | ![](docs/screenshots/01-overview.png) |
| **NPC popup** — profile + threads + rules + move/read | ![](docs/screenshots/02-npc-popup.png) |
| **Building popup** — floors collapsed by sub-label | ![](docs/screenshots/03-building.png) |
| **Move-to picker** — suggested destinations highlighted | ![](docs/screenshots/04-move-suggestions.png) |
| **Person profile** — rules + customize avatar + notes | ![](docs/screenshots/05-profile.png) |
| **Character builder** — layered LimeZu picker | ![](docs/screenshots/06-character-builder.png) |
| **Rules pane** — per-account, searchable, collapsible | ![](docs/screenshots/07-rules.png) |
| **Minimap** — buildings + NPC dots | ![](docs/screenshots/08-minimap.png) |

## Project layout

```
Email_Village/
├── backend/             Express + googleapis. OAuth, threads, filters CRUD.
│   ├── server.js
│   ├── routes/auth.js
│   └── routes/gmail.js
├── little_town/         Vite + Phaser frontend.
│   ├── src/
│   │   ├── main.ts                # Phaser scene, NPC lifecycle, hotkeys, popups
│   │   ├── npc.ts                 # A* pathing, idle, sidestep, jitter
│   │   ├── avatar.ts              # Per-email AvatarConfig + DOM portrait
│   │   ├── avatar_texture.ts      # Phaser texture composer + animations
│   │   ├── character_builder_app.js   # Reusable layered picker
│   │   ├── email_ui.ts            # Email list rows, move pickers
│   │   ├── email_content.ts       # Full-thread modal
│   │   ├── people.ts / people_ui.ts   # People grid + profile popup
│   │   ├── rules_ui.ts            # F-pane editor + reusable sender rules panel
│   │   └── api.ts                 # Thin wrapper around the backend
│   └── public/
│       ├── character-builder.html   # Standalone sandbox
│       └── assets/                  # Tilemap JSON + atlas (PNGs gitignored)
├── Tiled/               .tmx + .tsx authoring files (PNGs gitignored)
└── start.bat            Launches backend + frontend in two windows
```

## Setup

### Prereqs

- Node 18+
- A Gmail Google Cloud OAuth client (Web application). Authorized redirect URI:
  `http://localhost:3091/auth/callback`
- The LimeZu Modern Interiors asset pack — see [Building your own map](#building-your-own-map) below
- [Tiled](https://www.mapeditor.org/) if you want to edit the map

### Backend env

Copy the template:

```sh
cp backend/.env.example backend/.env
```

Fill in:

```
GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REDIRECT_URI=http://localhost:3091/auth/callback
SESSION_SECRET=<any random string>
```

Required Gmail scopes (already configured in `backend/routes/auth.js`):

- `gmail.readonly`, `gmail.modify`, `gmail.labels` — read + relabel threads
- `gmail.settings.basic` — filter rules CRUD
- `userinfo.email`, `userinfo.profile` — show which account is connected

### Run

```sh
# Windows — opens backend + frontend in separate windows:
start.bat
```

Or manually:

```sh
cd backend && npm install && npm run dev    # http://localhost:3091
cd little_town && npm install && npm run dev # http://localhost:5173
```

Visit `http://localhost:5173`, click through the Google OAuth flow, and you should see your inbox spawn as NPCs around the Post Office.

## Building your own map

The map is hand-drawn in [Tiled](https://www.mapeditor.org/) using the **[LimeZu Modern Interiors](https://limezu.itch.io/moderninteriors)** + **Modern Exteriors** tile packs. Those PNGs are **not committed** to this repo (paid asset, redistribute-no). You'll need to either buy the packs and recreate the asset folders, or substitute your own art.

### Asset folders you need to populate

```
assets/                                         # the raw asset library
├── Modern_Interiors/2_Characters/Character_Generator/
│   ├── Bodies/48x48/Body_48x48_NN.png         # body sheets
│   ├── Eyes/48x48/Eyes_48x48_NN.png
│   ├── Outfits/48x48/Outfit_NN_48x48_MM.png
│   ├── Hairstyles/48x48/Hairstyle_NN_48x48_MM.png
│   └── Accessories/48x48/Accessory_NN_<Name>_48x48_MM.png
└── Modern_Exteriors_48x48/ME_Theme_Sorter_48x48/
    ├── 4_Generic_Buildings_48x48.png
    ├── 7_Villas_48x48.png
    ├── 9_Shopping_Center_and_Markets_48x48.png
    ├── 11_Camping_48x48.png
    ├── 16_Office_48x48.png
    ├── 21_Beach_48x48.png
    ├── 22_Post_Office_48x48.png
    ├── 24_Additional_Houses_48x48.png
    └── 3_City_Props_48x48.png
```

Then copy the sliced tileset PNGs into:

```
little_town/public/assets/tilesets/<same-filename>.png
```

…and the LimeZu character generator PNGs into:

```
little_town/public/assets/character_builder/{bodies,eyes,outfits,hairstyles,accessories}/
```

Each layer folder needs a `manifest.json` listing every PNG (alphabetical). Quick way to regenerate them:

```sh
for layer in bodies eyes outfits hairstyles accessories; do
  cd "little_town/public/assets/character_builder/$layer"
  python -c "import json,os; print(json.dumps(sorted(f for f in os.listdir('.') if f.endswith('.png')), indent=2))" > manifest.json
  cd -
done
```

### Building the map in Tiled

The `Tiled/` folder ships with the `.tmx` and `.tsx` authoring files. Open `Tiled/First_Map.tmx` and:

1. **Layers used by the game:**
   - `Background`, `Ground Objects`, `Buildings`, `Trees` — tile layers (in depth order; `Buildings` is the one with collisions baked into `collides=true` per-tile properties)
   - `Building_Def` — object layer; each rectangle becomes a building. Name it (e.g. `Post_Office`) so the game can recognize it.
   - `doors` — object layer; either point objects (one per door) or polylines (a path network — NPCs prefer to walk along these).
   - `Regions` — object layer; rectangles or polygons that show up as the region-name banner when the player walks into them. Add a `labelPrefix` custom property to auto-filter the building-label dropdown when a building is inside that region.
2. **Tile properties** — flag any tile that should block movement with a custom property `collides = true` on the tile.
3. **Export to JSON** so the game can load it:

```sh
"C:/Program Files/Tiled/tiled.exe" --export-map json --embed-tilesets \
   Tiled/First_Map.tmx little_town/public/assets/tilemaps/First_Map.json
```

Every time you save the .tmx, re-export and refresh the browser.

### Tileset registration

Each tileset must also be listed in `little_town/src/main.ts` near the top:

```ts
const TILESETS: Array<{ name: string; key: string; file: string }> = [
  { name: '22_Post_Office_48x48', key: 'ts_postoffice', file: '22_Post_Office_48x48.png' },
  // ...add new ones here
];
```

`name` must match the tileset name in the .tmx; `file` is the PNG basename under `little_town/public/assets/tilesets/`. If you add a tileset to the map and forget to register it here, the tiles render as `?` and the game logs the missing key in the console.

## Tech notes

- **State:** localStorage holds per-building label bindings, per-email AvatarConfigs, per-account collapsed-rules state, sidebar collapse, portrait crop tuner, NPC thread-limit setting, and the player's `__player__@local` avatar.
- **Per-email cache:** the email cache pre-fetches every Gmail label (not just bound buildings) on startup so suggestions and the People grid have data without manual scans. Background poll watches INBOX and re-spawns NPCs when the count changes.
- **Avatars:** layered LimeZu sheets composited into one Phaser CanvasTexture per unique config (cached by hash → many NPCs share textures). Animations registered per-texture on the 48×96 sprite layout (R0 stand, R1 idle, R2 walk, R4 sit).
- **Filter suggestions:** three stacked strategies — sender history (≥2 co-filings), domain history, label-name vs. domain fuzzy match. Computed locally from the cached threads each time the picker opens.

## License

Source code: MIT.

Tile and character art is © LimeZu and **not redistributed** with this project. Buy your own copy at https://limezu.itch.io/.
