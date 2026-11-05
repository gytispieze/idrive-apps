// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-cast: plays a stream URL on the iDrive 7 instrument cluster or HUD,
 * with its sound through the car's speakers, controlled from a phone page; or
 * CarPlay's own cluster screen (the second CarPlay screen, through hook111).
 *
 * - A web page on the uplink's Wi-Fi address (the phone's hotspot), port
 *   8480, behind a token; the cluster shows its link as a QR code while idle.
 * - ffmpeg (bundled, static) reads the stream through proxy.js, which runs as
 *   the tool's internet uid; mgu-uplink routes only that uid through the
 *   phone. ffmpeg writes I420 frames (stdout) and S16LE 48 kHz audio (fd 3).
 * - Frames go to cluster-render as a video layer; audio to pcm_play.py
 *   (mgu-python), which plays it into SmartXbar's CarPlayMain source.
 * - The CarPlay second screen: ffmpeg listens on 127.0.0.1:6111 for hook111's
 *   H.264 (carplay_screen.js) and scales it for the cluster map or the HUD.
 *
 *   node server.js     (root: the render socket, ALSA, nftables)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const qrcode = require('./qrcode.js');
const firewall = require('./firewall.js');
const { ClusterRender } = require('./cluster_render_client.js');
const consoleOut = require('./console_out.js');
const { startControl } = require('./control.js');
const carplay = require('./carplay_screen.js');

const HERE = __dirname;
const STATE_DIR = process.env.CAST_STATE || '/var/opt/vizualyse-cast/state';
const PORT = Number(process.env.CAST_PORT) || 8480;
const PROXY_PORT = PORT + 1;
const INTERNET_UID = 12999;
const IFNAME = 'wlan0';
const FFMPEG = process.env.CAST_FFMPEG || path.join(HERE, 'ffmpeg');
const PYTHON = '/var/opt/mgu-python/current/bin/python3';
const LEASE = '/run/mgu-uplink/lease.json';
const UPLINK_STATUS = '/run/mgu-uplink/status.json';

function even(n) { return Math.max(0, Math.round(n / 2) * 2); }
/* cluster-render takes a video at most this wide a multiple of 4. */
function four(n) { return Math.max(4, Math.floor(n / 4) * 4); }

/* Each output: the target, the frame size sent and its rate (within the
 * renderer's 5500 KB/s upload ceiling), and the part of the target used. */
const OUTPUTS = {
    map: { target: 'map', W: 1088, H: 480, w: 512, h: 288, fps: 15, band: null, title: 'Cluster map' },
    /* band: the part of the height the HUD shows clear of its clipped top and
     * the speed; xband: the part of the width its optics show. */
    hud: { target: 'hud', W: 800, H: 480, w: 480, h: 270, fps: 15, band: [0.25, 0.65], xband: [0.17, 0.83], title: 'HUD' },
    /* The central display through mgu-render: a frame file, not cluster-render's upload budget. */
    console: { console: true, w: 640, h: 360, fps: 15, title: 'Media console' },
    none: { title: 'Audio only' },
};

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

/* ---- small helpers ------------------------------------------------------- */

function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d, 0o700); } }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/* The token in the QR link: kept across restarts, so a saved link works. */
function token() {
    const f = path.join(STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    mkdirp(STATE_DIR);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}

/* The head unit's address on the phone's hotspot, or null. */
function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const ifs = os.networkInterfaces()[IFNAME] || [];
    const v4 = ifs.filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : null;
}

/* A URL without its query or credentials, for logs and status. */
function redact(u) {
    try { const x = new URL(u); return x.protocol + '//' + x.host + x.pathname + (x.search ? '?…' : ''); } catch (e) { return '(invalid)'; }
}

/* ---- the cluster: QR code and video layer -------------------------------- */

const TOKEN = token();
const cr = new ClusterRender('vizualyse_cast');

/* Settings kept across restarts in STATE_DIR/settings.json: the service on
 * or off, the QR code on the cluster (off by default: with navigation up
 * the cluster draws its direction list over it; the iDrive page shows it),
 * the CarPlay cluster cards (directions, time / distance; both on), whether the phone is
 * asked to centre its view (the target's safe area; on by default), and the
 * HUD's alternate mode (the wide 1056x384 picture, not centred; off). */
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const settings = Object.assign({ enabled: true, clusterQr: false, carplayDirections: true, carplayEta: true, carplayCentre: true, carplayViewAreas: true, carplayHudAlt: false }, readJson(SETTINGS_FILE) || {});
settings.carplayCentre = settings.carplayCentre !== false;
settings.carplayViewAreas = settings.carplayViewAreas !== false;
settings.carplayHudAlt = settings.carplayHudAlt === true;
settings.carplayDirections = settings.carplayDirections !== false;
settings.carplayEta = settings.carplayEta !== false;
delete settings.carplayView;   /* 0.3.6's view setting: the two card switches replace it */
delete settings.carplayShape; delete settings.carplayVignette;   /* 0.3.5's, removed */
function saveSettings() {
    try { mkdirp(STATE_DIR); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings) + '\n', { mode: 0o600 }); } catch (e) { log('settings: ' + e.message); }
}
let qrLayer = null, qrUrl = null, qrWanted = settings.clusterQr;

function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

/* RGBA pixels of the QR code of `text`, black on white with a 4-module quiet
 * zone, `px` pixels a module: { px, size }. */
function qrPixels(text, target) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = Math.max(2, Math.floor(target / (n + 8))), size = (n + 8) * m;
    const buf = Buffer.alloc(size * size * 4, 255);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!q.isDark(r, c)) continue;
            for (let y = (r + 4) * m; y < (r + 5) * m; y++) {
                const row = y * size * 4;
                for (let x = (c + 4) * m; x < (c + 5) * m; x++) buf.fill(0, row + x * 4, row + x * 4 + 3);
            }
        }
    }
    return { px: buf, size: size };
}

/* The QR code on the cluster's map area while idle and wanted. A content
 * layer: an overlay alone never takes the area from the cluster's own map. */
function updateQr() {
    /* Shown until the video's first frame: the area is never left empty in
     * between, which would hand it back to the cluster's own map. */
    const url = link(), show = settings.enabled && qrWanted && (!player || !player.frames) && !!url;
    if (url && url !== qrUrl) {
        if (qrLayer) cr.drop(qrLayer);
        const q = qrPixels(url, 300), W = 1088, H = 480;
        /* contend: take the centre from the stock map (cluster-render's
         * take-over), as the Waze map does; without it the layer waits for a
         * free slot, which in Map view never comes. */
        qrLayer = cr.image({ target: 'map', contend: true, x: Math.round((W - q.size) / 2), y: Math.round((H - q.size) / 2),
            w: q.size, h: q.size, iw: q.size, ih: q.size, visible: show });
        cr.pixels(qrLayer, null, q.px);
        qrUrl = url;
        log('qr: ' + url.replace(TOKEN, '<token>') + ' (' + q.size + ' px)');
    } else if (qrLayer) {
        cr.set(qrLayer, { visible: show });
    }
}

/* I420 to the renderer's 4:2:0 atlas: the Y plane, then each chroma row as
 * its U half followed by its V half. */
function atlas(i420, w, h, out) {
    const ySize = w * h, cw = w / 2, ch = h / 2, cSize = cw * ch;
    i420.copy(out, 0, 0, ySize);
    for (let y = 0; y < ch; y++) {
        const row = ySize + y * w;
        i420.copy(out, row, ySize + y * cw, ySize + (y + 1) * cw);
        i420.copy(out, row + cw, ySize + cSize + y * cw, ySize + cSize + (y + 1) * cw);
    }
    return out;
}

/* The largest rect of w:h inside the output's area (or band), centred. */
function placement(o) {
    const a = area(o);
    const s = Math.min(a.W / o.w, a.H / o.h), dw = Math.round(o.w * s), dh = Math.round(o.h * s);
    return { x: a.x + Math.round((a.W - dw) / 2), y: a.y + Math.round((a.H - dh) / 2), w: dw, h: dh };
}

/* The part of a target that is shown: its bands, or all of it. */
function area(o) {
    const x = o.xband ? Math.round(o.W * o.xband[0]) : 0, y = o.band ? Math.round(o.H * o.band[0]) : 0;
    return { x: x, y: y, W: o.xband ? Math.round(o.W * (o.xband[1] - o.xband[0])) : o.W,
        H: o.band ? Math.round(o.H * (o.band[1] - o.band[0])) : o.H };
}

/* ---- the proxy ----------------------------------------------------------- */

let proxy = null;
function startProxy() {
    proxy = spawn(process.execPath, [path.join(HERE, 'proxy.js'), String(PROXY_PORT)],
        { uid: INTERNET_UID, gid: INTERNET_UID, stdio: ['ignore', 'pipe', 'pipe'] });
    proxy.stdout.on('data', (d) => process.stdout.write(d));
    proxy.stderr.on('data', (d) => process.stderr.write(d));
    proxy.on('exit', (code, sig) => {
        log('proxy: exited (' + (sig || code) + ')');
        proxy = null;
        if (!stopping) setTimeout(startProxy, 2000);
    });
}

/* ---- playback ------------------------------------------------------------ */

let player = null;      /* { ff, py, opts, video, started, frames, lastErr[] } */
const consoleVideo = new consoleOut.ConsoleVideo(log);
let last = { state: 'idle' };
let lastPlay = null;    /* the last play's options (with its full URL): the app's Play last */
let restartTimer = null; /* the CarPlay second screen's ffmpeg, started again after it ends */
let restartDelay = 500;  /* doubles after each run without a frame, back to 1 s after one with */

function o0(p) { return OUTPUTS[p.opts.output] || {}; }

function stopPlayer(why) {
    clearTimeout(restartTimer); restartTimer = null;
    const p = player;
    if (!p) return;
    player = null;
    p.stopped = why;
    try { p.ff.kill('SIGTERM'); } catch (e) { /* gone */ }
    setTimeout(() => { try { p.ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
    if (p.py) try { p.py.kill('SIGTERM'); } catch (e) { /* gone */ }
    if (p.video) cr.drop(p.video);
    if (o0(p).console) consoleVideo.stop();
    log('play: stopped (' + why + ') after ' + p.frames + ' frames');
    last = { state: 'idle', note: why, url: p.opts.shown, output: p.opts.output, frames: p.frames };
    updateQr();
}

function play(opts) {
    stopPlayer('replaced');
    lastPlay = opts;
    const cp = opts.source === 'carplay';
    let o = OUTPUTS[opts.output];
    if (cp) {
        /* the size the phone should draw at (from its next connection), and
         * what goes on to the renderer */
        const t = carplay.TARGETS[opts.output];
        o = Object.assign({}, o, { w: t.w, h: t.h, fps: t.fps }, t.xband ? { xband: t.xband } : {}, t.band ? { band: t.band } : {});
        try {
            const d = carplay.wantDisplay(opts.output, undefined, settings.carplayCentre, settings.carplayHudAlt, settings.carplayViewAreas);
            if (d) log('carplay: asking for ' + d.wanted + (d.safearea ? ', safe area ' + d.safearea : ', no safe area') +
                (d.pending ? ' (from the phone\'s next connection; until then scaled)' : ''));
        } catch (e) { log('carplay: display: ' + e.message); }
        syncScene();
    }
    if (o.w) o = Object.assign({}, o, { w: four(o.w), h: even(o.h) });
    const wantVideo = opts.output !== 'none';
    const isHttp = !cp && /^https?:/i.test(opts.url);

    const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '3'];
    if (cp) {
        /* live: no -re; the hook connects to this listener */
        args.push.apply(args, carplay.inputArgs(carplay.state().port));
        args.push.apply(args, carplay.outputArgs(opts.output));
    } else {
        if (opts.realtime) args.push('-re');
        if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        args.push('-i', opts.url);
        if (wantVideo) {
            args.push('-map', '0:v:0', '-vf',
                'scale=' + o.w + ':' + o.h + ':force_original_aspect_ratio=decrease:flags=bilinear,' +
                'pad=' + o.w + ':' + o.h + ':-1:-1,fps=' + o.fps + (o.look ? ',' + o.look : '') + ',format=yuv420p',
                '-f', 'rawvideo', 'pipe:1');
        }
    }
    if (opts.audio) {
        args.push('-map', '0:a:0', '-af', 'volume=' + (opts.volume / 100).toFixed(2), '-ac', '2', '-ar', '48000',
            '-f', 's16le', 'pipe:3');
    }

    const env = Object.assign({}, process.env, { http_proxy: 'http://127.0.0.1:' + PROXY_PORT, https_proxy: 'http://127.0.0.1:' + PROXY_PORT });
    const ff = spawn(FFMPEG, args, { env: env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const p = { ff: ff, py: null, opts: opts, video: null, started: Date.now(), frames: 0, lastErr: [] };
    player = p;
    log('play: ' + opts.shown + ' on ' + opts.output + (opts.audio ? ' with audio at ' + opts.volume + '%' : ' without audio'));
    ff.on('error', (e) => { p.lastErr.push('ffmpeg: ' + e.message); log('ffmpeg: ' + e.message); });

    ff.stderr.on('data', (d) => {
        String(d).split('\n').filter((l) => l.trim()).forEach((l) => {
            p.lastErr.push(l.trim());
            if (p.lastErr.length > 6) p.lastErr.shift();
            log('ffmpeg: ' + l.trim());
        });
    });

    if (wantVideo) {
        const size = o.w * o.h * 3 / 2, out = Buffer.alloc(size);
        const r = o.console ? null : placement(o);
        if (o.console) consoleVideo.start(o.w, o.h, o.fps);
        /* prewarm: ask for the slot before the first frame (ffmpeg takes a
         * second or two to start); contend: take it from the stock content. */
        if (!o.console) p.video = cr.video({ target: o.target, z: 1, contend: true, prewarm: true, x: r.x, y: r.y, w: r.w, h: r.h, vw: o.w, vh: o.h, fps: o.fps });
        let parts = [], have = 0;
        ff.stdout.on('data', (d) => {
            parts.push(d);
            have += d.length;
            while (have >= size) {
                const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
                if (o.console) { consoleVideo.frame(all.slice(0, size)); ++p.frames; }
                else cr.frame(p.video, atlas(all.slice(0, size), o.w, o.h, out), ++p.frames);
                if (p.frames === 1) { log('play: first frame'); updateQr(); }
                parts = have > size ? [all.slice(size)] : [];
                have -= size;
            }
        });
    } else {
        ff.stdout.resume();
    }

    if (opts.audio) {
        const py = spawn(PYTHON, [path.join(HERE, 'pcm_play.py'), '--file', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        p.py = py;
        ff.stdio[3].pipe(py.stdin);
        py.stdin.on('error', () => { /* python gone: ffmpeg's write fails and it ends */ });
        py.stdout.on('data', (d) => log(String(d).trim()));
        py.stderr.on('data', (d) => { const l = String(d).trim(); p.lastErr.push(l); log(l); });
    } else {
        ff.stdio[3].resume();
    }

    updateQr();
    ff.on('exit', (code, sig) => {
        if (player !== p) return;     /* stopped or replaced */
        const ok = code === 0;
        log('play: ffmpeg ended (' + (sig || code) + ')');
        if (!ok && opts.audio && !p.frames && p.lastErr.some((l) => /matches no streams|does not contain any stream/i.test(l))) {
            log('play: the stream has no audio; again without it');
            return play(Object.assign({}, opts, { audio: false }));
        }
        player = null;
        if (p.py) try { p.py.stdin.end(); } catch (e) { /* gone */ }
        if (p.video) cr.drop(p.video);
        if (o.console) consoleVideo.stop();
        last = { state: ok ? 'ended' : 'error', url: opts.shown, output: opts.output, frames: p.frames,
            error: ok ? null : (p.lastErr.slice(-3).join(' | ') || 'ffmpeg exited ' + (sig || code)) };
        /* The second screen has no end: the hook's connection went (it gives
         * up on a reader that stops, then reconnects); listen again. */
        if (cp && !stopping && settings.enabled) {
            /* a run that showed nothing waits longer each time (up to 30 s), so
             * a listener that can't start doesn't spin */
            restartDelay = p.frames ? 1000 : Math.min(30000, restartDelay * 2);
            last = { state: 'waiting', url: opts.shown, output: opts.output, frames: p.frames,
                note: 'listening again for the second screen in ' + Math.round(restartDelay / 1000) + ' s', error: last.error };
            restartTimer = setTimeout(() => { restartTimer = null; if (!player && lastPlay === opts && settings.enabled && !stopping) play(opts); }, restartDelay);
        }
        updateQr();
    });
}

function status() {
    const up = readJson(UPLINK_STATUS) || {};
    const s = player
        ? { state: 'playing', url: player.opts.shown, output: player.opts.output, audio: player.opts.audio, volume: player.opts.volume,
            frames: player.frames, seconds: Math.round((Date.now() - player.started) / 1000) }
        : last;
    const c = carplay.state();
    return Object.assign({ enabled: settings.enabled, uplink: up.state || 'unknown', render: cr.ready ? 'connected' : 'not connected', qr: qrWanted,
        link: link(), canReplay: !!lastPlay,
        source: player ? player.opts.source || 'url' : (lastPlay && lastPlay.source) || 'url',
        carplay: { armed: c.armed, ready: c.ready, why: c.why, mode: c.mode, streaming: c.streaming, frames: c.frames,
            display: c.display, wanted: c.wanted, size: c.size, switch: carplaySwitch(), cards: carplayCards(c), centre: carplayCentre(c), hudAlt: settings.carplayHudAlt },
        outputs: Object.keys(OUTPUTS).filter((k) => k !== 'console' || consoleOut.available()).map((k) => ({ id: k, title: OUTPUTS[k].title })) }, s);
}

/* ---- the web page -------------------------------------------------------- */

const PAGE = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');

function send(res, code, type, body) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }

function readBody(req, cb) {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 16384) req.destroy(); });
    req.on('end', () => { try { cb(null, b ? JSON.parse(b) : {}); } catch (e) { cb(e); } });
}

function authorised(req, u) {
    const t = req.headers['x-cast-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Cast page to open this page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'Cast to cluster is off: turn it on on the iDrive Cast page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

    readBody(req, (err, b) => {
        if (err) return json(res, 400, { error: 'bad JSON' });
        if (u.pathname === '/api/play' && b.source === 'carplay') {
            const why = playCarplay(b.output);
            return why ? json(res, 400, { error: why }) : json(res, 200, status());
        }
        if (u.pathname === '/api/play') {
            let url;
            try { url = new URL(String(b.url || '')); } catch (e) { return json(res, 400, { error: 'not a URL' }); }
            if (!/^(https?|rtsp|rtmp):$/.test(url.protocol)) return json(res, 400, { error: 'http(s), rtsp or rtmp only' });
            const output = OUTPUTS[b.output] ? b.output : 'map';
            const audio = b.audio !== false;
            if (output === 'none' && !audio) return json(res, 400, { error: 'nothing to play: no video output and no audio' });
            const volume = Math.max(0, Math.min(150, Math.round(Number(b.volume) || 60)));
            play({ url: url.href, shown: redact(url.href), output: output, audio: audio, volume: volume, realtime: b.realtime !== false });
            return json(res, 200, status());
        }
        if (u.pathname === '/api/carplay-centre') {
            setCarplayCentre(b.on === true);
            return json(res, 200, status());
        }
        if (u.pathname === '/api/carplay-view-areas') {
            setCarplayViewAreas(b.on === true);
            return json(res, 200, status());
        }
        if (u.pathname === '/api/carplay-hud-alt') {
            setCarplayHudAlt(b.on === true);
            return json(res, 200, status());
        }
        if (u.pathname === '/api/carplay-cards') {
            setCarplayCards(b);
            return json(res, 200, status());
        }
        if (u.pathname === '/api/carplay-zoom') {
            const why = carplayZoom(b.dir);
            return why ? json(res, 400, { error: why }) : json(res, 200, status());
        }
        if (u.pathname === '/api/hook111') {
            const why = setCarplayMode(b.mode);
            return why ? json(res, 400, { error: why }) : json(res, 200, status());
        }
        if (u.pathname === '/api/stop') { stopPlayer('stopped from the phone'); return json(res, 200, status()); }
        if (u.pathname === '/api/qr') { setQr(!!b.show); return json(res, 200, status()); }
        json(res, 404, { error: 'not found' });
    });
});

/* ---- start and stop ------------------------------------------------------ */

/* The CarPlay second screen on the cluster map or the HUD: null, or why not. */
function carplayOpts(output) {
    return { source: 'carplay', shown: 'CarPlay second screen', output: output, audio: false, volume: 0, realtime: false };
}
function playCarplay(output) {
    const c = carplay.state();
    if (!c.ready) return 'the CarPlay second screen is not available: ' + c.why;
    play(carplayOpts(output === 'hud' ? 'hud' : 'map'));
    return null;
}

/* The second screen's switch: hook111's mode, off or alt, now and for later
 * starts (carplay_screen.setMode). Off also stops a second screen playing.
 * null, or why not. */
function carplaySwitch() {
    try { return carplay.switchState(); } catch (e) { return { installed: false, on: false, pending: null, error: e.message }; }
}
function setCarplayMode(mode) {
    let r;
    try { r = carplay.setMode(mode); } catch (e) { log('hook111: mode ' + mode + ': ' + e.message); return e.message; }
    log('hook111: mode ' + r.mode + ' saved; ' + r.note);
    if (r.mode === 'off' && player && player.opts.source === 'carplay') stopPlayer('the CarPlay second screen turned off');
    return null;
}

/* The CarPlay output playing, or last played, or the cluster map. */
function carplayOutput() {
    return (player && player.opts.source === 'carplay' && player.opts.output) || (lastPlay && lastPlay.source === 'carplay' && lastPlay.output) || 'map';
}
const hudAltOn = (out) => out === 'hud' && settings.carplayHudAlt;

/* The cluster scene: the directions card and the time / distance card,
 * written for hook111 (carplay_screen.sceneUrl), now and every 5 s (its run
 * directory is new at each start). hook111 0.1.5 sends a change to the phone
 * at once. The HUD's alternate mode shows the time / distance card only. */
function sceneOpts(out) {
    const alt = hudAltOn(out);
    return { directions: alt ? false : settings.carplayDirections, eta: settings.carplayEta, wide: alt || !settings.carplayCentre || !settings.carplayViewAreas };
}
function syncScene() {
    try { return carplay.wantScene(sceneOpts(carplayOutput())); } catch (e) { log('carplay: scene: ' + e.message); return null; }
}
function carplayCards(c) {
    const url = carplay.sceneUrl(sceneOpts(carplayOutput()));
    return { directions: settings.carplayDirections, eta: settings.carplayEta, url: url,
        pending: c.streaming && c.uiUrl !== url ? 'in a moment' : null };
}
function setCarplayCards(b) {
    if (typeof b.directions === 'boolean') settings.carplayDirections = b.directions;
    if (typeof b.eta === 'boolean') settings.carplayEta = b.eta;
    saveSettings();
    const r = syncScene();
    log('carplay: directions card ' + (settings.carplayDirections ? 'on' : 'off') + ', time / distance card ' + (settings.carplayEta ? 'on' : 'off') +
        (r ? ': ' + r.url : ', from the next start (hook111 is not armed this start)'));
    return null;
}
/* Zoom the cluster map in or out (hook111 sends it while the stream runs). */
function carplayZoom(dir) {
    let ok;
    try { ok = carplay.requestZoom(dir); } catch (e) { return e.message; }
    if (!ok) return 'hook111 is not armed this start';
    log('carplay: zoom ' + dir);
    return null;
}

/* Centre the map: view area 0, the phone's view centred on the target's safe
 * area (carplay_screen TARGETS[].safe): the directions card at the top, the
 * car, the time / distance card at the bottom. Off: view area 1, Maps' own
 * layout. hook111 0.1.5 switches it at once (updateViewArea).
 * View areas off (carplayViewAreas false): no safe area is written, so
 * hook111 offers none and the phone sees a plain display; from the phone's
 * next connection. */
function carplayCentre(c) {
    const out = carplayOutput();
    return { on: settings.carplayCentre, viewAreas: settings.carplayViewAreas,
        safearea: settings.carplayViewAreas ? carplay.safeText(carplay.safeAreaFor(out, hudAltOn(out))) : null,
        pending: c.streaming && c.viewarea !== null && c.viewarea !== (settings.carplayCentre ? 0 : 1) ? 'in a moment' : null };
}
function setCarplayCentre(on) {
    settings.carplayCentre = !!on;
    saveSettings();
    const out = carplayOutput();
    try { carplay.wantDisplay(out, undefined, settings.carplayCentre, hudAltOn(out), settings.carplayViewAreas); } catch (e) { log('carplay: centre: ' + e.message); }
    syncScene();
    log('carplay: centre ' + (on ? 'on' : 'off') + ' saved');
    return null;
}
function setCarplayViewAreas(on) {
    settings.carplayViewAreas = !!on;
    saveSettings();
    const out = carplayOutput();
    try { carplay.wantDisplay(out, undefined, settings.carplayCentre, hudAltOn(out), settings.carplayViewAreas); } catch (e) { log('carplay: view areas: ' + e.message); }
    syncScene();
    log('carplay: view areas ' + (on ? 'on' : 'off') + ' saved, from the phone\'s next connection');
    return null;
}
/* The HUD's alternate mode: the phone draws the HUD band's own wide shape
 * (1056x384), no safe area, the time / distance card only. Off (the default):
 * the cluster's picture and cards, centred, fitted into the band. Written now
 * when the CarPlay picture is on the HUD (the size from the phone's next
 * connection). */
function setCarplayHudAlt(on) {
    settings.carplayHudAlt = !!on;
    saveSettings();
    const onHud = player && player.opts.source === 'carplay' && player.opts.output === 'hud';
    let d = null;
    if (onHud) { try { d = carplay.wantDisplay('hud', undefined, settings.carplayCentre, settings.carplayHudAlt, settings.carplayViewAreas); } catch (e) { log('carplay: hud: ' + e.message); } }
    syncScene();
    log('carplay: HUD alternate mode ' + (on ? 'on' : 'off') + ' saved' + (d ? ', asking for ' + d.wanted + ', from the phone\'s next connection' : ', from the next play on the HUD'));
    return null;
}

/* The iDrive app's commands over the control socket: null, or why not. */
function setQr(show) { qrWanted = show; settings.clusterQr = show; saveSettings(); updateQr(); }

/* On: the phone page reachable (its firewall rule), the QR code as set.
 * Off: nothing plays, no QR code, the page closed. */
function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    if (on) {
        try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
    } else {
        stopPlayer('turned off');
        try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
    }
    log('cast: ' + (on ? 'on' : 'off'));
    updateQr();
}

function command(c) {
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (c.cmd === 'hook111') return setCarplayMode(c.mode);
    if (c.cmd === 'carplayCards') return setCarplayCards(c);
    if (c.cmd === 'carplayZoom') return carplayZoom(c.dir);
    if (c.cmd === 'carplayCentre') return setCarplayCentre(c.on === true);
    if (c.cmd === 'carplayViewAreas') return setCarplayViewAreas(c.on === true);
    if (c.cmd === 'carplayHudAlt') return setCarplayHudAlt(c.on === true);
    if (!settings.enabled) return 'Cast to cluster is off';
    if (c.cmd === 'carplay') return playCarplay(c.output);
    if (c.cmd === 'stop') { stopPlayer('stopped on the iDrive page'); return null; }
    if (c.cmd === 'qr') { setQr(!!c.show); return null; }
    if (c.cmd === 'replay') {
        if (!lastPlay) return 'nothing played yet: start a stream from the phone first';
        const output = OUTPUTS[c.output] ? c.output : lastPlay.output;
        if (output === 'console' && !consoleOut.available()) return 'the media console needs mgu-render';
        if (lastPlay.source === 'carplay') {
            if (output === 'console' || output === 'none') return 'the CarPlay second screen goes to the cluster map or the HUD';
            return playCarplay(output);
        }
        play(Object.assign({}, lastPlay, { output: output, audio: lastPlay.audio || output === 'none' }));
        return null;
    }
    return 'unknown command';
}

let control = null;
let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    stopPlayer('shutting down');
    consoleVideo.stop();
    try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
    if (proxy) proxy.kill('SIGTERM');
    if (control) control.close();
    cr.close();
    web.close();
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

cr.on('ready', () => { log('render: connected (' + cr.backend + ')'); updateQr(); });
cr.on('disconnected', () => log('render: disconnected'));
cr.on('layer', (ref, state, reason) => log('render: layer ' + ref + (ref === qrLayer ? ' (qr)' : player && ref === player.video ? ' (video)' : '') +
    ' ' + state + (reason ? ': ' + reason : '')));
cr.on('target', (t, state, holder, reason) => log('render: target ' + t + ' ' + state + (holder && holder !== 'none' ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : '')));
cr.on('refused', (op, ref, reason) => log('render: refused ' + op + ' ' + ref + (reason ? ': ' + reason : '')));

if (settings.enabled) {
    try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
} else {
    log('cast: off (turn it on on the iDrive Cast page)');
}
startProxy();
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
control = startControl({ app: 'vizualyse_cast', status: status, command: command, log: log });
cr.connect();
/* The address changes with the hotspot: keep the QR code current. hook111's
 * run directory can appear after this tool starts: keep its view current. */
syncScene();
setInterval(() => { updateQr(); syncScene(); }, 5000);
