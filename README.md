**English** | [简体中文](README.zh-CN.md)

# Inotia 4 Remake

A fan-made remake of Inotia 4, built with Phaser 4.2.1 and TypeScript. It runs in desktop and mobile browsers and as a standalone Android app. The repository contains the game source, story and quest content, assets, tests, and build tools.

This is a non-commercial fan project, not an official game. Assets from the original game and text derived from its story remain the property of their original rights holders. See [License](#license).

## What's in the game

- Story scenes, quests, dialogue, and choices
- Real-time combat with party AI
- Maps, movement, and battle effects
- Cloud saves with account login
- An Android app with its own Chromium and over-the-air updates
- GM debug mode for testing quests and game state

## Requirements

- Node.js 24 or newer
- npm

## Quick start

```bash
npm ci
npm run dev
```

Open http://localhost:4003/ in a browser.

`npm run dev` loads the game code from source and compiles the content with the same rules as a production build.

## Preview the production build locally

```bash
npm run build
npm run serve
```

Open http://127.0.0.1:4004/ in a browser.

`npm run build` validates the content and builds the game into `dist/`. `npm run serve` reads `dist/` from disk, so a new build appears after a page refresh without restarting the server.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the development server on port 4003. |
| `npm run build` | Validate content, build into `dist/`, and prune unused assets. |
| `npm run serve` | Serve the built `dist/` folder on port 4004. |
| `npm run deploy` | Type-check, build, and confirm the deployed site serves this build. |
| `npm run typecheck` | Type-check TypeScript only. |
| `npm test -- tests/combat.test.ts` | Type-check, then run the named test file. |
| `npm run test:all` | Run the full unit test suite. |
| `npm run validate:content` | Validate content, the validator, and asset references. |
| `npm run test:standalone` | Verify a clean install, type-check, and build. |
| `npm run apk` | Build the Android APK. |
| `npm run verify:apk` | Check the APK output. |
| `npm run update:key` | Create the hot-update signing key on first use. |
| `npm run verify:update` | Compare the APK baseline with the published update manifest. |

## Project layout

```text
src/                Game source
  application/      Capability wiring, content loading, saves, audio
  domain/           Pure rules: combat, story, quests, inventory, saves
  rendering/        Phaser world, combat, effects, character visuals
  scenes/           Map, story stage, menu, and debug scenes
  ui/               Menus, HUD, dialogue, DOM components, UI logic
  debug/            GM debug actions
public/             Runtime assets shipped with the game
  content/          Story, quests, maps, combat, items, audio
  assets/           Atlas pages, maps, audio, standalone images
asset-source/       Source images for atlas generation (in Git, not shipped)
asset-archive/      Old runtime images removed by the build (not in Git)
tests/              Unit tests and standalone build checks
tools/              Build, validation, static server, APK packaging
docs/               Architecture, content authoring, deployment, updates, debugging
android/            Android shell with bundled Chromium 156
.agents/skills/     Phaser 4 development skills included with the repo
```

## Content and assets

- `public/content/campaign.json` holds the story, quests, events, and character placement.
- `public/content/world.json`, `public/content/maps/`, `public/content/battle.json`, and the other files in `public/content/` hold map and combat data.
- `public/assets/` holds the atlas pages, maps, audio, and standalone images loaded at runtime. Content JSON or the atlas map points to these files.
- `asset-source/` holds the source images for characters, effects, UI, props, and icons. Atlas generation, content deduplication, and pixel tests read from here; the folder is not shipped with the game.
- See [Story and quest authoring](docs/story-content.md) for content fields and validation rules.
- Run `npm run validate:content` after changing content, the validator, or asset references. The build validates again.

Content and assets are versioned with the game and do not depend on data outside this repository. When adding assets, follow the existing folder and naming rules and make sure validation and the build pass.

## Development docs

Development docs are currently written in Chinese.

| Task | Start here |
|---|---|
| Understand how the modules work together | [Module guide](docs/module-guide.md) |
| Change behavior, rules, or lifecycle | [Architecture](docs/architecture.md) → source and tests |
| Write dialogue, quests, events, or map conditions | [Story and quest authoring](docs/story-content.md) → `public/content/campaign.json` |
| Change music, ambience, or sound effects | [Audio](docs/audio.md) → `public/content/audio.json` |
| Debug the game or a quest | [GM debug mode](docs/debugging.md) |
| Deployment and caching | [Build service and deployment](docs/deployment.md) |
| Android over-the-air updates | [Hot updates](docs/live-update.md) |
| Collect errors from phones | [Diagnostics](docs/diagnostics.md) |

## Interface and debug scenes

Screen UI uses DOM, CSS, and SVG components; Phaser draws the map, characters, and combat.

- `?gm` opens GM debug mode for the session and adds a **Debug** entry to the title screen.
- The GM panel has four tabs: state, characters, items, and story. In a browser you can also call the same actions through `globalThis.gm`.

## Phaser skills

The repository includes 28 Phaser 4 development skills in `.agents/skills/`. Claude Code reads them through the `.claude/skills` symlink. The skills cover scenes, animation, physics, cameras, tilemaps, input, text, particles, filters, scaling, and Phaser 4 features.

When implementing a feature, look for a solution in this order:

1. Built-in Phaser APIs.
2. The matching skill in this repository.
3. The official Phaser 4.2.1 documentation.

The engine version is pinned in `package.json`.

## Testing

Choose the `tests/*.test.ts` files related to your change; you can pass several files at once. Unit tests cover rules and lightweight stand-ins. Content validation checks files and references. Neither replaces checking the real screen, audio, and long-running memory use on a device.

By project convention, automated browser runs are not started on their own. UI and device checks are done by the maintainer. Browsers are used only when explicitly requested.

## Android app

`npm run apk` packages `dist/` into the Android wrapper in `android/`. The wrapper embeds Chromium 156, so the app does not depend on the device WebView. Building needs JDK 25 on the machine and uses Gradle 9.7.1, AGP 9.4, Android SDK 37, and build-tools 37.0.0. The first run downloads the Android SDK and Gradle and creates a signing key in your home directory. `android/keystore.properties`, build caches, and build outputs are not committed. The APK is about 337 MB and targets arm64-v8a only.

A hot update means the app downloads new web code and content without installing a new APK. `npm run build` generates and signs the update manifest in `dist/update/`. Run `npm run update:key` once before the first APK build. The private key is stored at `~/.config/inoita/update-signing.pem` and must be backed up separately; the public key `android/update-public-key.txt` is committed. After the first APK, web code and content changes only need a new build and deployment; the ~337 MB APK does not need to be rebuilt. Engine or Chromium upgrades still require a new APK. See [Hot updates](docs/live-update.md) for details.

## Credits

Thanks to kj for testing and feedback.

## License

The source code in this repository (`src/`, `tests/`, `tools/`, and so on) is released under the [MIT License](LICENSE).

Images, audio, and other assets in `public/assets/` and `asset-source/`, and the story, quest, and text content in `public/content/` derived from the original game, are the property of their original rights holders. They are not covered by the MIT License and are included for study and research only.

## Copyright

Game assets and derived content belong to their original rights holders. This project is for study and research.
