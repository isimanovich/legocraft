# LEGOCRAFT

A first-person voxel survival game in the browser. Build with LEGO-style bricks,
smash the angry minifigs before they smash you. Play solo or share a world with
friends on your local network. A small Node.js server serves the game and
connects multiplayer players; three.js is vendored, so gameplay needs no outside
services or internet connection after installation.

## Run

```bash
npm ci                      # first run / after pulling dependency changes
npm start                   # http://localhost:8080
# Or use the launcher:
./run.sh
PORT=9000 ./run.sh           # different port
OPEN_BROWSER=1 ./run.sh      # optionally open the local browser
```

Install **Node.js 20.19 or newer** first; a maintained Node 22/24 LTS release is
recommended. There is no build step. The server listens on `0.0.0.0:8080` by
default, so another device on the same Wi-Fi can open `http://YOUR_SERVER_IP:8080`.
Set `HOST=127.0.0.1` to allow connections from this machine only.

The title screen lets you choose **Solo** or **Play together**, as well as
**Laptop** or **iPad / iPhone** controls. Solo asks you to pick a game mode:
**Survive the waves** (minifigs
attack in ever harder waves; score, kills, tomatoes) or **Free build** (no
enemies, no health bar, a full stock of tomatoes for demolition; just you and
the bricks). `Esc` pauses solo play; the pause screen has a **New game** button that
throws the world away, generates a fresh one and asks for a mode again. Dying
and pressing `R` restarts in the same world and mode.

### Play together

1. Open the same server address on every laptop, iPad, or iPhone. Use the main
   Wi-Fi network rather than a guest network with client isolation enabled.
2. Choose **Play together**, enter a name, select **Survive the waves** or
   **Free build**, and choose **Create room**.
3. Share the six-character room code shown in the game. Friends choose
   **Play together**, enter their name and that code, and choose **Join room**.

Each room supports up to **8 players**. Everyone shares the terrain and sees
other players building and breaking bricks. Survive mode is cooperative, with
shared enemies, waves, kills, and score. Each player keeps their own health and
controls; laptop and touchscreen players can share a room.

Pause, inventory, naming, and switching away from the browser release your own
controls in multiplayer; the room continues running for the other players.
Your player can still take enemy damage while a menu is open. The room creator
can choose **New world for everyone** to reset the shared world. If that player
leaves, another player becomes the room host. Use **Leave room** to return to
solo play. A room code identifies a game on this server; it is not an internet
invitation or a password.

The server saves room seeds, terrain edits, score, kills, and wave progress in
`.local-data/rooms.json` by default. Set `DATA_DIR` to a writable, persistent
directory to move these saves. Players, health, creatures, bodies, and projectiles
are temporary; a server restart restores the saved terrain and progress rather
than an exact instant of combat, restarting the current wave with its full enemy
roster. Empty rooms expire after 24 hours. Back up the data directory to keep
your worlds, and keep it when updating the code.

Solo still works from a plain static web server, including the earlier Python
or Nginx setup. **Play together requires the Node.js server** and its WebSocket
endpoint; copying files into Nginx's document root alone does not enable it.

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
| Pause | Open the menu, resume, switch controls, or start a new world (solo pauses) |
| Rebuild yourself | Restart after dying |

Movement, aiming and actions work with multiple fingers at the same time.
Touch controls use larger action buttons (96 pixels on tablets), a larger
thumbstick, and more space between actions so children can hit the intended
control more easily. On narrow screens,
the hotbar wraps into two rows rather than shrinking the slots; inventory slots
are enlarged too.

Touch mode suppresses accidental pinch and double-tap page zoom, including in
the start, inventory, and naming menus. Menus still scroll with one finger and
name/room fields still accept typing. Laptop mode keeps normal browser gestures.
Reload the game after updating if an older session is already zoomed. Safari
and device accessibility settings can override page behavior, so check on your
actual iPad/iPhone as well.

Portrait and landscape layouts fit phones and tablets, including screen safe
areas; landscape gives aiming more room. Switching apps or losing focus pauses
solo play and releases held inputs. Multiplayer continues for the room. Returning
to play starts with neutral controls.

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
| E | Inventory: all 20 bricks plus the sword; solo pauses while it is open |
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
inventory: solo play freezes and the mouse is released. In multiplayer, only
your controls pause. Click a hotbar slot
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
to cancel, an empty name removes it. Solo play freezes while you type; a
multiplayer room continues. Named
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

## Host on a Raspberry Pi

These instructions use Raspberry Pi OS with the Pi and players on the same
local network. The Pi needs internet access to install packages and download
the repository; playing afterward needs only the local network. Reserve the
Pi's IP address in your router's DHCP settings so your game address stays the
same. No router port forwarding is needed.

### First installation

Run these commands in the Pi's terminal, or in an SSH session to the Pi:

```bash
sudo apt update
sudo apt install -y git nodejs npm
node --version
```

The version must be **20.19 or newer**. Older Raspberry Pi OS repositories may
offer Node 18, which is too old: install a maintained Node 22/24 LTS release for
your Pi's architecture using the [Node.js installation instructions](https://nodejs.org/en/download)
before continuing. The service below uses the system Node binary; if your
installation uses a different path, use the result of `command -v node` in its
`ExecStart` line.

For a new checkout:

```bash
git clone https://github.com/isimanovich/legocraft.git "$HOME/legocraft"
cd "$HOME/legocraft"
npm ci
npm start
```

If you already cloned it while setting up the old static version, use
`git -C "$HOME/legocraft" pull --ff-only origin main`, then run `npm ci` and
`npm start` inside that existing folder instead.

Open `http://YOUR_PI_IP:8080` from your laptop or iPad. Run `hostname -I` on the
Pi to find its LAN IPv4 address, such as `192.168.0.123`. Test a shared room
with two browser tabs or devices. Stop the foreground server with `Ctrl+C`
before enabling the service below, which uses the same port.

### Start automatically after reboot

The example service runs as your ordinary Pi user and restarts after a failure.
It serves both the website and multiplayer; you do not need Python or Nginx
for this configuration.

```bash
cd "$HOME/legocraft"
mkdir -p .local-data
cp deploy/legocraft.service.example /tmp/legocraft.service
nano /tmp/legocraft.service
```

In that file, replace every `YOUR_PI_USERNAME` with the username you created
during OS installation. Change `/home/YOUR_PI_USERNAME/legocraft` if your
checkout is somewhere else, and check that `/usr/bin/node` matches
`command -v node`. Keep `DATA_DIR` pointing at the writable `.local-data`
directory. Then install and start it:

```bash
sudo install -m 644 /tmp/legocraft.service /etc/systemd/system/legocraft.service
sudo systemctl daemon-reload
sudo systemctl enable --now legocraft
curl --fail http://127.0.0.1:8080/healthz
```

The health endpoint returns JSON with `ok: true` and current room/player counts.
Useful commands:

```bash
sudo systemctl status legocraft
sudo journalctl -u legocraft -n 50 --no-pager
sudo systemctl restart legocraft
```

### Update after a commit to main

Stop the server so its last saved room state is written before replacing code.
Run these commands as the account that owns the checkout:

```bash
sudo systemctl stop legocraft
git -C "$HOME/legocraft" pull --ff-only origin main
cd "$HOME/legocraft"
npm ci
sudo systemctl start legocraft
curl --fail http://127.0.0.1:8080/healthz
```

Check each command succeeds before continuing. If the Git pull refuses because
you have local changes, preserve those changes before updating. Do not delete
`.local-data`; reload the game on all devices after the update. GitHub pushes do
not automatically update the Pi; run these commands to deploy a new commit.

### Keep an existing Nginx address on port 80

If you followed the earlier static Nginx setup, you can either use the new
`:8080` address directly or have Nginx forward the existing port-80 address to
the Node server. The files previously copied into `/var/www/html` are no longer
the deployment source when using this proxy.

Edit the active Nginx site (typically
`sudo nano /etc/nginx/sites-available/default`). Inside its existing `server`
block, replace the static `location /` section with both locations from
[`deploy/nginx.conf.example`](deploy/nginx.conf.example). Keep the site's
existing `listen` and `server_name` settings. The `/multiplayer` location must
include the WebSocket upgrade headers or multiplayer connections will fail.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Now open `http://YOUR_PI_IP` on every device. Keep the Node service running on
port 8080. If only Nginx should reach the Node server, change the service's
`HOST` to `127.0.0.1`, then run `sudo systemctl daemon-reload` and
`sudo systemctl restart legocraft`.

If a device cannot connect, first check `systemctl status legocraft`, the Pi's
current IP, and that both devices use the regular Wi-Fi rather than an isolated
guest network. If you configured a firewall, allow TCP 8080 for direct access
or TCP 80 for the Nginx setup on your LAN. This is designed for a trusted local
network; the room code provides no account authentication or access control.

## Code

```
index.html        HUD + importmap
run.sh            LAN game/multiplayer server launcher
package.json      Node.js dependencies and start/test commands
server/main.mjs   HTTP/static server and WebSocket multiplayer entry point
deploy/           example Raspberry Pi systemd service and Nginx proxy
vendor/three.module.js  three.js r160 (MIT)
src/main.js       game loop, input, HUD, spawning, combat, carrying
src/multiplayer.js WebSocket session, room messages, and connection state
src/remote-players.js   other players' minifig avatars and movement
src/network-entities.js replicated enemies, animals, bodies, and projectiles
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
src/touch-gestures.js   touch-mode browser zoom protection
test/touch-gestures.mjs gesture cancellation and normal-input regression checks
test/browser.mjs  optional Chromium regression tests for touch and laptop controls
test/multiplayer-browser.mjs optional multi-browser shared-room regression tests
```

Tuning knobs: `World` options in `main.js` (size, seed, `studs: false` for a
flat Minecraft look), structure counts in `World.placeStructures`, `ENEMY_TYPES`
/ `AGGRO_RADIUS` / `waveMods()` in `enemies.js`, `waveSize()` / `maxAlive()` /
`INTERMISSION_SECONDS` in `main.js`.

## Validation

Install dependencies with `npm ci`, then run the server integration tests,
headless gameplay suite, remote-player rendering, and touch-gesture checks:

```bash
npm test
```

`npm run test:server`, `npm run test:smoke`, `npm run test:remote`, and
`npm run test:touch` run the suites separately.
The browser suite below is an additional check; physical iPad/iPhone Safari
testing remains useful for touch, audio, and browser lifecycle behavior.

The browser suite uses Playwright and starts its own local test server. It checks
simultaneous touches, building/breaking, inventory, carrying/naming, restarting,
mouse locking and keyboard controls, preference storage, large touch targets,
phone/tablet layouts, and zoom prevention with scrollable menus.
To use the cloud environment's installed Chromium without adding game dependencies:

```bash
npm install --prefix /tmp/legocraft-browser --cache /tmp/legocraft-npm-cache --no-audit --no-fund playwright
PLAYWRIGHT_MODULE=/tmp/legocraft-browser/node_modules/playwright/index.mjs \
  CHROMIUM_PATH=/usr/bin/chromium node --test test/browser.mjs
PLAYWRIGHT_MODULE=/tmp/legocraft-browser/node_modules/playwright/index.mjs \
  CHROMIUM_PATH=/usr/bin/chromium node --test test/multiplayer-browser.mjs
```

With Playwright and its Chromium already installed in your own development setup,
`npm run test:browser` and `npm run test:multiplayer-browser` also work. The
multiplayer suite opens separate browser sessions against the actual Node
server to check the shared-room workflow. Chromium's device emulation does not
replace testing Safari and touch/audio behavior on a physical iPad or iPhone.
