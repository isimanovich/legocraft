# LEGOCRAFT

A first-person voxel survival game in the browser. Build with LEGO-style bricks,
smash the angry minifigs before they smash you. Runs 100% locally - no install,
no network (three.js is vendored).

## Run

```bash
./run.sh            # serves http://127.0.0.1:8080 and opens your browser
PORT=9000 ./run.sh  # different port
```

The title screen asks you to pick a mode: **Survive the waves** (minifigs
attack in ever harder waves; score, kills, tomatoes) or **Free build** (no
enemies, no health bar, a full stock of tomatoes for demolition; just you and
the bricks). `Esc` pauses; the pause screen has a **New game** button that
throws the world away, generates a fresh one and asks for a mode again. Dying
and pressing `R` restarts in the same world and mode.

## Laptop or iPad / iPhone controls

Choose **Laptop** or **iPad / iPhone** under **Controls** on the start screen.
This choice is separate from Survive / Free build. Touch devices default to
iPad / iPhone; your selection is remembered when browser storage is available.
You can switch controls from the pause screen without starting a new game.

Laptop uses the keyboard and a locked mouse, as before. iPad / iPhone uses
on-screen controls and does not require mouse locking or a physical keyboard:

| Touch control | Action |
|---|---|
| Left thumbstick | Move; drag farther for full speed |
| Drag an uncovered part of the world | Look / aim with the crosshair |
| Jump | Jump; hold to swim up |
| Sprint | Toggle sprint on / off |
| Hit | Break blocks / attack; hold to repeat or carry a fallen Stalker, release to drop |
| Place | Place the selected brick; hold to repeat |
| Tomato | Throw an exploding tomato |
| Tap a hotbar slot | Select that slot |
| Bag | Open inventory; pick a slot and item, then tap Done to return |
| Name | Name the fallen Stalker under the crosshair or being carried; Save name / Cancel dismisses the keyboard |
| Pause | Pause, resume, switch controls, or start a new world |
| Rebuild yourself | Restart after dying |

Movement, aiming and actions work with multiple fingers at the same time.
Portrait and landscape layouts fit phones and tablets, including screen safe
areas; landscape gives aiming more room. Switching apps or losing focus pauses
the game and releases held inputs. Returning to play starts with neutral controls.

### Laptop keyboard shortcuts

| Key | Action |
|---|---|
| W A S D / arrows | Move |
| Mouse | Look |
| Space | Jump |
| Shift | Sprint |
| Left mouse | Break block / hit enemy (hold to repeat); on a fallen Stalker: hold to carry it, release to drop |
| Right mouse | Place selected brick |
| Q / middle mouse | Throw an exploding tomato |
| N | Name the fallen Stalker under the crosshair (or the one you're carrying) |
| 1-9 / wheel | Select hotbar slot |
| E | Inventory: all 20 bricks plus the sword; the game pauses while it is open |
| R | Restart after death |

Enemies come in waves. A wave has a fixed roster (4 minifigs in wave 1, growing
every wave) that trickles in a few at a time; the next wave starts only once
every minifig on the field is destroyed, after a 5 s breather. Each wave they
get more HP (+15%/wave), hit harder (+10%/wave), move a little faster and skew
towards Titans. Score = kill value x wave.

Minifigs appear 18-32 blocks out on natural ground. Successive spawns step
round you by the golden angle and keep at least 9 blocks from every other
minifig (`SPAWN_SPACING`, halved only if the ring is crowded), so they come at
you from all sides instead of dropping in as a clump.

The bar at the top of the screen points you at them: one marker per minifig,
coloured like its torso, placed at its bearing relative to where you're looking
(centre notch = straight ahead, edges = 90 degrees left/right). Markers grow and
brighten as a minifig gets closer and pulse once it's hunting you; a minifig
behind you shows as a chevron at the edge, pointing the way to turn.

Every wave hands you 3 exploding tomatoes (you can bank up to 9; the count is in
the top-left HUD). `Q` or
middle-click lobs one along the crosshair with your own motion added. It arcs,
and bursts on the first thing it touches - terrain, a minifig, a body - or
after 5 s in the air. A burst does 90 damage at the centre falling to 25% at
4 blocks (a direct hit always takes the full 90, enough to drop anything but a
Titan in one), shoves bodies, blows a small 1.3-block crater, and splatters red.
Tomatoes never hurt you, so throw them at your feet when you're swarmed.
Numbers are the constants at the top of `src/tomatoes.js`.

## World

144x144 map with lakes (wade or swim - Space swims up / climbs out), two tree
species, half-buried boulders, giant 2x4 bricks, minifig houses (walk in through
the door) and stone watchtowers with a spiral stair to a crenellated top.
Also stepped sand-and-orange pyramids with a gold cap and a chamber you can
walk into (there's a treasure brick inside), ruined stone circles with broken
columns and a surviving lintel, and plank piers on wooden posts running from a
beach out over the lake with a lantern post at the end. Everything is made of
breakable bricks except the baseplate.

## Inventory and hotbar

The hotbar has 9 slots (`1`-`9`, mouse wheel). Press `E` to open the
inventory: the game freezes and the mouse is released. Click a hotbar slot
(or press its number) to select it, then click an item to put it there.
Items are the 20 brick colours (red, blue, yellow, white, grass, lime, leaf,
orange, pink, purple, azure, dark red, gold, black, dark grey, grey, tan,
brown, wood, plank) and the sword. The sword is a look, not a weapon upgrade:
it hits exactly as hard as a brick, swings sideways, and can't place
anything. `E` or `Esc` closes the inventory and re-grabs the mouse.

The inventory also has three spawn buttons that put a passive creature about
three blocks in front of you: a **Wolf**, a **Cat**, or a **Fallen Stalker**.
Wolves and cats (`src/animals.js`) wander, sit, swim, hop one-block steps, and
occasionally trot over to see what you are doing; they have no health, never
attack, and nothing targets them. Hit one or set off a blast nearby and it
yelps and bolts. Up to 12 are kept. The Fallen Stalker is a Stalker that is
already dead: it appears standing and topples into a ragdoll you can carry
and name, without having to fight one.

## Enemies

Every minifig carries a floating name tag above its head (a camera-facing
sprite, hidden behind walls like anything else in the scene) so you can tell a
Bomber from a Brute before it reaches you. Tags drop off when a minifig dies.

| Type | Look | Speed | HP | Damage |
|---|---|---|---|---|
| Brute | red torso, red cap | medium | 40 | 10 |
| Scout | black torso, blue legs | fast | 20 | 6 |
| Titan | big, blue torso, grey helmet | slow | 110 | 18 |
| Bomber | green torso, lit fuse on head | medium | 30 | 45 (blast) |
| Stalker | 3.5 blocks tall, near-black, glowing purple eyes | fast | 70 | 14 |

Bombers never swing. One runs up to you and starts ticking; stand within 2.6
blocks of it for 3 seconds (`FUSE_SECONDS`) and it detonates: damage falls off
over 4.5 blocks (`BLAST_RADIUS`), nearby minifigs take 1.5x the blast (those
kills count for you), and it blows a crater in the terrain. Backing off lets
the fuse cool down. Killing a Bomber before it blows is safe: it bursts into
bricks like any other minifig and gives the normal score; only the fuse sets
off the blast.

Stalkers are the Enderman of the set: lanky, too tall for doorways, and 60% of
the time a hit that doesn't kill one makes it blink to a spot 4-8 blocks from
you (`BLINK_CHANCE`, `BLINK_MIN/MAX`). They don't shatter when killed. The
figure stays in one piece and ragdolls (`src/ragdoll.js`): it topples about its
feet like a felled tree, bounces and slides over the terrain, floats in lakes,
and its limbs are loose pendulums the whole time: in the air (toppling, thrown,
falling) they swing toward gravity and lag behind the body's spin, on landing
the impact jolts them, and once it lies still they settle flat on the ground
instead of poking into it. Bodies get shoved when you walk into them or a
Bomber goes off nearby. Click one and hold the button to carry it around by
the point you grabbed: it dangles from your hand and keeps ragdolling while
held. Every part you aren't holding hangs toward the ground on loose springs,
and the body has a waist hinge, so grab it by the head and the legs swing
below, grab a foot and it hangs head-down with the arms trailing, grab the
middle and it folds into a V. Moving your hand shakes it. It can't pass
through walls; release to drop or toss it. Look at a body (or carry it) and
press `N` to give it a name: type up to 16 characters, Enter to confirm, Esc
to cancel, an empty name removes it. The game freezes while you type. Named
bodies carry a white-on-purple tag that floats above them wherever they end
up, and the carry hint says who you're lugging around. The newest 16 bodies
are kept (`MAX_BODIES`); a name goes with its body.

AI: wander until the player is within 12 blocks (`AGGRO_RADIUS`), then chase
using 8-connected A* over the voxel surface (replanned twice a second, walks
around houses, towers and tree clusters, jumps one-block steps, drops up to
three). Paths are string-pulled afterwards, so across open ground a minifig
walks a straight line at any angle instead of staircasing along the grid;
diagonals are refused where they would clip a wall corner. They swing when
in reach, and give up if the player gets more than 22 blocks away
(`LOSE_INTEREST_RADIUS`). Hitting one always enrages it. Killing one blows it
apart into its individual bricks (Stalkers excepted, see above).

## Code

```
index.html        HUD + importmap
run.sh            local server launcher
vendor/three.module.js  three.js r160 (MIT)
src/main.js       game loop, input, HUD, spawning, combat, carrying
src/world.js      voxel storage, terrain gen (lakes, trees, structures), chunk meshing (with studs), DDA raycast
src/physics.js    AABB vs voxel collision, ray/box, buoyancy
src/pathfind.js   bounded A* over standable cells (enemy navigation)
src/player.js     first-person controller
src/enemies.js    minifig builder + AI + explode / toRagdoll
src/ragdoll.js    intact dead bodies: topple, collide, float, flop, push, carry
src/animals.js    passive wolf and cat: wander, sit, swim, flee
src/tomatoes.js   throwable exploding tomatoes: flight, hit detection, hand model
src/debris.js     flying bricks
src/sfx.js        procedural WebAudio sounds
src/noise.js      value noise / fBm
test/smoke.mjs    headless test (node --import ./test/register.mjs test/smoke.mjs)
src/touch-controls.js   multi-pointer thumbstick, look, and on-screen actions
test/browser.mjs  optional Chromium regression tests for touch and laptop controls
```

Tuning knobs: `World` options in `main.js` (size, seed, `studs: false` for a
flat Minecraft look), structure counts in `World.placeStructures`, `ENEMY_TYPES`
/ `AGGRO_RADIUS` / `waveMods()` in `enemies.js`, `waveSize()` / `maxAlive()` /
`INTERMISSION_SECONDS` in `main.js`.

## Validation

Run the existing headless gameplay suite with Node 24:

```bash
node --import ./test/register.mjs test/smoke.mjs
```

The browser suite uses Playwright and starts its own local test server. It checks
simultaneous touches, building/breaking, inventory, carrying/naming, restarting,
mouse locking and keyboard controls, preference storage, and phone/tablet layouts.
To use the cloud environment's installed Chromium without adding game dependencies:

```bash
npm install --prefix /tmp/legocraft-browser --cache /tmp/legocraft-npm-cache --no-audit --no-fund playwright
PLAYWRIGHT_MODULE=/tmp/legocraft-browser/node_modules/playwright/index.mjs \
  CHROMIUM_PATH=/usr/bin/chromium node --test test/browser.mjs
```

With Playwright and its Chromium already installed in your own development setup,
`node --test test/browser.mjs` also works. Chromium's device emulation does not
replace testing Safari and touch/audio behavior on a physical iPad or iPhone.
