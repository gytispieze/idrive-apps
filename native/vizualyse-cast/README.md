# vizualyse-cast

A tech demo for the iDrive 7 head unit: play a stream URL from your phone on
the instrument cluster or the HUD, with its sound through the speakers.

1. The head unit is on your phone's hotspot (mgu-uplink).
2. Open **Cast** (the iDrive app, apps/vizualyse_cast) and scan its QR code
   with the phone. The cluster can show the QR code while idle too (off by
   default: with navigation up the cluster's direction list covers it).
3. On the page, either a **Stream URL** (a file, HLS `.m3u8`, `rtsp://`,
   `rtmp://`) to **Cluster map**, **HUD**, **Media console** or **Audio only**,
   with sound on or off and the volume; or the **CarPlay second screen** to
   the cluster map or the HUD. Then **Play**.

**Cast to cluster: on / off** on the iDrive page turns the whole service off
(nothing plays, no QR code, the phone page closed) and is kept across restarts.

## The CarPlay second screen

CarPlay's own instrument-cluster view (Google Maps' or Apple Maps' cluster
map), which the phone draws next to the main CarPlay screen. On this head
unit's 2020 `carplay` it needs **hook111** ([`native/hook111`](../hook111), from the Store) armed
for the current start, in mode `alt`. The hook hands the stream out as H.264
to a consumer on `127.0.0.1:6111`; the tool's ffmpeg is that consumer
(`carplay_screen.js`). It listens, the hook connects and asks the phone for a
keyframe, and the picture follows in about 0.2 s. If the connection ends,
ffmpeg listens again.

| Output | The phone draws | Sent to cluster-render |
|---|---|---|
| Cluster map | 984x480, placed at x 52-1036 of the 1088x480 `map` target (calibrated on the car: the cluster's soft vignette hides the outer ~130 px each side; the map reaches 60 px into it for a wider picture). Safe area 340x435 at 322,20 when centring | as drawn, 984x480 at up to 20 fps (cluster-render's governor keeps the link within its cap) |
| HUD | by default the cluster map's picture (984x480, its safe area); in the HUD's alternate mode 1056x384, the band's own shape, no safe area | 528x192 at 15 fps, fitted (black either side by default), in the band (17-83 % of the width, 25-65 % of the height) |

**The switch** (the iDrive page and the phone page, "CarPlay second screen:
on / off") sets hook111's mode: `alt` (on) or `off`. The tool runs as root, so
it does what the app can't: it saves `HOOK111_MODE=` in
`/var/opt/hook111/config` (its other lines kept) for later starts, and when
the hook is armed this start, sets it now with hook111's own
`hook111-arm.sh mode`; the phone sees it at its next connection. Not armed, or
fallen back to off this start: it applies from the next start, and the pages
say so. Off also stops a second screen that's playing. `full` isn't offered:
`viewAreas` without its records made the phone refuse every session (centring,
below, sends both).

The tool writes the wanted size to `/run/hook111/display`; the phone gets it
at its next connection, and until then the stream is scaled to fit. The page
and the iDrive page show whether hook111 is ready, and why not.

**The cluster cards** ("CarPlay directions card" / "CarPlay time / distance
card" on the iDrive page, two checkboxes on the phone page; both on by
default): the tool writes the scene for them to `/run/hook111/url`
(`carplay_screen.sceneUrl`), and hook111 0.1.5 sends it to the phone as
`showUI` while the stream runs: at once, no reconnect. Found on the car
(2026-11-04, Google Maps): `?showETA=yes` both cards, `?showETA=no`
directions only, `?showETA=yes&maneuverLayout=topAligned` the time /
distance card only on the centred area (on a wide area that shows both, so
there `/map?showETA=yes`: the card bottom right), `/map` neither. The
options only apply through `showUI`, not `/info`'s `initialURL`; the view
/info names (`/run/hook111/view`) follows the directions card. The commands
are `{"cmd":"carplayCards","directions":…,"eta":…}` and
`POST /api/carplay-cards`.

**Zoom** ("CarPlay map: zoom in / out", "−" / "+" on the phone page): a
request in `/run/hook111/zoom` that hook111 sends as `changeMapZoomLevel`.
`{"cmd":"carplayZoom","dir":"in"|"out"}`, `POST /api/carplay-zoom`.

**Centring** ("CarPlay: centre the map" on the iDrive page, "Centre the map"
on the phone page; on by default): the tool writes the target's safe area to
`/run/hook111/safearea` (`x,y,w,h`; the map's 340x435 at y 20, centred across
its width; the HUD uses the map's) with the size when it plays, and the view
area to `/run/hook111/viewarea`: 0 centred, 1 Maps' own layout. hook111 0.1.5
offers both view areas and switches between them at once (`updateViewArea`).
On the car the directions card follows the area's top edge and the time /
distance card its bottom; 340x435 at y 20 was the owner's pick. hook111 (0.1.4) puts it into `/info` as `viewAreas` and
answers `viewAreas` at SETUP; the phone centres its view on it from its next
connection. On the car (2026-11-04, Google Maps): the car centred, the
directions card above it. Without a safe area Google Maps puts the car low
and a quarter across, the card top right. The commands are
`{"cmd":"carplayCentre","on":…}` and `POST /api/carplay-centre`.
With view areas off (phone page "Offer view areas", `{"cmd":"carplayViewAreas","on":false}`,
`POST /api/carplay-view-areas`) no safe area file is written, so hook111
offers no view areas and the phone sees a plain display (Waze may hide road
hazards on a small viewport); the scene is the wide one. It takes effect at the
phone's next connection.

**The HUD's alternate mode** ("CarPlay HUD alternate mode" / "HUD alternate
mode"; off by default): with it, the CarPlay picture on the HUD is the wide
1056x384 that fills the HUD's band, not centred, with the time / distance
card only (bottom right); without, the HUD shows the
cluster's centred picture, fitted into the band. Written at once while the
picture is on the HUD (the phone takes it when it reconnects). The commands
are `{"cmd":"carplayHudAlt","on":…}` and `POST /api/carplay-hud-alt`.

0.3.5's shape setting (a taller picture squeezed back) and its vignette are
gone: on the car the squeeze looked squashed and moved nothing.

The central-screen mirror (BMW's `winston-grabber` and the Google Maps
layouts) was removed in 0.3.0.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | the page on port 8480 (token in the QR link), the QR code and the video layer through cluster-render, starts ffmpeg and the audio player |
| `proxy.js` | uid 12999 | an HTTP/CONNECT proxy on 127.0.0.1:8481; mgu-uplink routes this uid (never root) through the phone, and names resolve through the uplink's DNS, since the head unit's own resolver does not resolve internet names |
| `ffmpeg` | root | static build, reads the stream through the proxy and writes I420 frames (stdout) and S16LE 48 kHz stereo (fd 3) |
| `pcm_play.py` | root, mgu-python | plays the audio into SmartXbar's `CarPlayMain_CF_48_STEREO` source |
| `console_out.js` | root | the media console output: frames into mgu-render's frame file `/dev/shm/mgu-video-vizualyse_cast` (MGVF, 3 slots), drawn by an mgu-render client in layer mode in the screen's app area |
| `firewall.js` | root | one in-memory nftables rule letting the phone reach port 8480 on `wlan0`; added at start (while on), removed at stop, when turned off and by the tool's `deactivate` |
| `control.js` | root | the iDrive app's socket, `/dev/shm/vizualyse-cast/ctl.sock`, mode 0660 in the Cast app's own group (found by its package name under `/var/opt/public/oap`; root only until it is installed; every Store app shares `tm_oap_app`, so that group was open to all of them before 0.3.8): status, stop, replay, carplay, hook111, carplayCards, carplayZoom, carplayCentre, carplayHudAlt, enable, disable, the cluster QR code |
| `carplay_screen.js` | root | the CarPlay second screen: hook111's state, the size and the cluster view to ask for, ffmpeg's arguments |

Frame sizes keep within cluster-render's 5500 KB/s upload ceiling: for a
stream URL 512x288 at 15 fps on the map and 480x270 at 15 fps on the HUD,
there in the band between its clipped top and the car's speed (25 % to 65 %
of the height); for the CarPlay second screen, the table above. The CarPlay
map is the exception: it goes at the phone's own size, and cluster-render's
governor (it sends only changed tiles, and a frame it can't cover packed,
then exact) keeps the link to the cluster within the cap. On the car
(2026-11-04, 936x480 at 20 fps, parked): ~14.5 fps reached the cluster, no
budget holds, 19 frames packed in 15 s. The cap protects that link: on a car
the cluster flashed black at 8000 KB/s. ffmpeg
decodes in software on the Atom A3960's four cores.

`test/carplay_test.js` (Node 8, the kit's ffmpeg) checks the second-screen
source off the car: a fake hook111, a real x264 stream through the tool's
ffmpeg arguments, and server.js end to end.

Sound reaches the speakers while the audio manager has `CarPlayMain`
connected (CarPlay the source, or nothing else playing); the first play
after the head unit starts can take a while to connect.

## Build and install

`node tools/fetch_ffmpeg.js` (the tool's `build`) downloads the pinned
static ffmpeg into `build/`. `release/release.js` packs the tool kit and
publishes it in the fork's `catalog` release; add the fork as a Store source
on **Releases** and install **Cast to cluster**. It requires cluster-render,
mgu-python and mgu-uplink.

## Licenses

GPL-3.0-or-later (`LICENSE`). `cluster_render_client.js` is MPL-2.0
(`LICENSES/MPL-2.0.txt`), Robert Nisipeanu's client for
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render). `qrcode.js` is Kazuhiko Arase's QR Code Generator,
MIT. The bundled ffmpeg is John Van Sickle's static build, GPLv3
(`ffmpeg-GPLv3.txt`). [THIRD-PARTY.md](THIRD-PARTY.md), shipped in the kit,
names the exact build, its libraries and where their source is.
