// Built-in sample: a small original HTML5 game, so ReSourcefy opens in a
// working state. Its tuning lives in data/config.json, which makes a good
// first edit-and-playtest.

const INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Orbit Courier</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<canvas id="game" width="640" height="400"></canvas>
<div id="hud"><span id="score">0</span><span id="lives"></span></div>
<script src="js/engine.js"></script>
<script src="js/game.js"></script>
</body>
</html>
`;

const CSS = `html, body { margin: 0; height: 100%; background: #05070b; overflow: hidden; }
body { display: grid; place-items: center; font: 600 16px/1 "Trebuchet MS", system-ui, sans-serif; color: #e6f2ff; }
canvas { width: min(100vw, 160vh); height: auto; image-rendering: pixelated; background: #070a10; }
#hud { position: fixed; top: 10px; left: 0; right: 0; display: flex; justify-content: space-between; padding: 0 16px; pointer-events: none; text-shadow: 0 1px 0 #000; }
`;

const ENGINE = `// Tiny engine: asset loading, input, game loop.
var Engine = (function () {
  var keys = {};
  window.addEventListener('keydown', function (e) { keys[e.key.toLowerCase()] = true; });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  var pointer = { x: 0, y: 0, down: false };
  function loadJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }
  function loadImage(url) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = url; });
  }
  function loadSound(url) { var a = new Audio(url); a.preload = 'auto'; return a; }
  function play(sound) { try { var s = sound.cloneNode(); s.volume = 0.5; s.play(); } catch (e) {} }
  function loop(update) {
    var last = performance.now();
    function frame(now) { var dt = Math.min(0.05, (now - last) / 1000); last = now; update(dt); requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
  }
  return { keys: keys, pointer: pointer, loadJSON: loadJSON, loadImage: loadImage, loadSound: loadSound, play: play, loop: loop };
})();
`;

const GAME = `// Orbit Courier: collect parcels, dodge asteroids.
(function () {
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var cfg, sheet, sfx = {};
  var ship, parcels, rocks, score = 0, lives = 0, hurt = 0, stars = [];

  canvas.addEventListener('pointermove', function (e) {
    var r = canvas.getBoundingClientRect();
    Engine.pointer.x = (e.clientX - r.left) * W / r.width;
    Engine.pointer.y = (e.clientY - r.top) * H / r.height;
  });
  canvas.addEventListener('pointerdown', function () { Engine.pointer.down = true; });
  window.addEventListener('pointerup', function () { Engine.pointer.down = false; });

  function rand(a, b) { return a + Math.random() * (b - a); }
  function spawnRock() {
    var edge = Math.random() < 0.5;
    return { x: edge ? -20 : rand(0, W), y: edge ? rand(0, H) : -20, vx: rand(-60, 60), vy: rand(-60, 60), r: rand(12, 20), a: rand(0, 6.28), spin: rand(-2, 2) };
  }
  function spawnParcel() { return { x: rand(40, W - 40), y: rand(40, H - 40), t: 0 }; }
  function reset() {
    ship = { x: W / 2, y: H / 2, a: -Math.PI / 2, vx: 0, vy: 0 };
    parcels = [spawnParcel(), spawnParcel()];
    rocks = [];
    for (var i = 0; i < cfg.asteroids; i++) rocks.push(spawnRock());
    score = 0; lives = cfg.lives; hurt = 0;
    hud();
  }
  function hud() {
    document.getElementById('score').textContent = cfg.title + '  ·  ' + score;
    document.getElementById('lives').textContent = lives > 0 ? new Array(lives + 1).join('\\u2665 ') : 'GAME OVER · press R';
  }
  function wrap(o) { if (o.x < -30) o.x = W + 30; if (o.x > W + 30) o.x = -30; if (o.y < -30) o.y = H + 30; if (o.y > H + 30) o.y = -30; }
  function sprite(index, x, y, angle, scale) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle || 0); ctx.scale(scale || 1, scale || 1);
    ctx.drawImage(sheet, index * 32, 0, 32, 32, -16, -16, 32, 32);
    ctx.restore();
  }

  function update(dt) {
    var k = Engine.keys;
    if (lives <= 0) { if (k.r) reset(); draw(); return; }
    var turn = (k.arrowleft || k.a ? -1 : 0) + (k.arrowright || k.d ? 1 : 0);
    var thrust = k.arrowup || k.w || Engine.pointer.down;
    if (Engine.pointer.down) {
      var want = Math.atan2(Engine.pointer.y - ship.y, Engine.pointer.x - ship.x);
      var diff = Math.atan2(Math.sin(want - ship.a), Math.cos(want - ship.a));
      turn = Math.max(-1, Math.min(1, diff * 3));
    }
    ship.a += turn * cfg.turnSpeed * dt;
    if (thrust) { ship.vx += Math.cos(ship.a) * cfg.shipSpeed * dt; ship.vy += Math.sin(ship.a) * cfg.shipSpeed * dt; }
    ship.vx *= 1 - cfg.drag * dt; ship.vy *= 1 - cfg.drag * dt;
    ship.x += ship.vx * dt; ship.y += ship.vy * dt; wrap(ship);
    hurt = Math.max(0, hurt - dt);
    rocks.forEach(function (r) {
      r.x += r.vx * dt; r.y += r.vy * dt; r.a += r.spin * dt; wrap(r);
      if (!hurt && Math.hypot(r.x - ship.x, r.y - ship.y) < r.r + 10) { lives--; hurt = 1.5; Engine.play(sfx.hit); hud(); }
    });
    parcels.forEach(function (p, i) {
      p.t += dt;
      if (Math.hypot(p.x - ship.x, p.y - ship.y) < 22) {
        score += cfg.parcelValue; parcels[i] = spawnParcel(); Engine.play(sfx.pickup);
        if (score % (cfg.parcelValue * 5) === 0) rocks.push(spawnRock());
        hud();
      }
    });
    draw();
  }

  function draw() {
    ctx.fillStyle = cfg.colors.space; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    stars.forEach(function (s) { ctx.globalAlpha = s.b; ctx.fillRect(s.x, s.y, 1.5, 1.5); });
    ctx.globalAlpha = 1;
    parcels.forEach(function (p) { sprite(1, p.x, p.y + Math.sin(p.t * 3) * 3, 0, 1); });
    rocks.forEach(function (r) { sprite(2, r.x, r.y, r.a, r.r / 14); });
    if (!(hurt > 0 && Math.floor(hurt * 10) % 2)) sprite(0, ship.x, ship.y, ship.a + Math.PI / 2, 1);
    if (lives <= 0) {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = cfg.colors.parcel; ctx.font = '700 32px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Delivered: ' + score, W / 2, H / 2);
    }
  }

  Promise.all([Engine.loadJSON('data/config.json'), Engine.loadImage('img/sprites.png')]).then(function (res) {
    cfg = res[0]; sheet = res[1];
    sfx.pickup = Engine.loadSound('audio/pickup.wav');
    sfx.hit = Engine.loadSound('audio/hit.wav');
    for (var i = 0; i < 90; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, b: Math.random() * 0.8 + 0.2 });
    document.title = cfg.title;
    reset();
    console.log('Orbit Courier ready: arrows/WASD or hold the mouse to fly. Edit data/config.json and press Play again.');
    Engine.loop(update);
  });
})();
`;

const CONFIG = {
  title: 'Orbit Courier',
  shipSpeed: 220,
  turnSpeed: 3.4,
  drag: 0.9,
  asteroids: 5,
  parcelValue: 10,
  lives: 3,
  colors: { space: '#070a10', parcel: '#ffb15a' },
};

async function makeSprites() {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(96, 32) : Object.assign(document.createElement('canvas'), { width: 96, height: 32 });
  const g = c.getContext('2d');
  // ship
  g.fillStyle = '#3fd3c1';
  g.beginPath(); g.moveTo(16, 3); g.lineTo(27, 28); g.lineTo(16, 22); g.lineTo(5, 28); g.closePath(); g.fill();
  g.fillStyle = '#e8fffb'; g.fillRect(14, 11, 4, 6);
  // parcel
  g.fillStyle = '#ffb15a'; g.fillRect(32 + 7, 8, 18, 16);
  g.fillStyle = '#b8641a'; g.fillRect(32 + 15, 8, 2, 16); g.fillRect(32 + 7, 15, 18, 2);
  // asteroid
  g.fillStyle = '#7d889b';
  g.beginPath();
  const pts = [[16, 2], [25, 6], [30, 15], [26, 25], [17, 30], [7, 26], [2, 16], [6, 6]];
  pts.forEach(([x, y], i) => (i ? g.lineTo(64 + x, y) : g.moveTo(64 + x, y)));
  g.closePath(); g.fill();
  g.fillStyle = '#5c6677'; g.beginPath(); g.arc(64 + 12, 12, 3.5, 0, 7); g.fill(); g.beginPath(); g.arc(64 + 20, 21, 2.5, 0, 7); g.fill();
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/png' });
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

function makeWav(freqs, dur, shape = 'square') {
  const rate = 22050, n = Math.floor(rate * dur);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = freqs[0] + (freqs[1] - freqs[0]) * t;
    phase += f / rate;
    const s = shape === 'noise' ? Math.random() * 2 - 1 : (phase % 1 < 0.5 ? 1 : -1);
    v.setInt16(44 + i * 2, s * (1 - t) * 0.35 * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export async function sampleGameFiles() {
  const base = 'orbit-courier/';
  return [
    { path: base + 'index.html', blob: new Blob([INDEX], { type: 'text/html' }) },
    { path: base + 'css/style.css', blob: new Blob([CSS], { type: 'text/css' }) },
    { path: base + 'js/engine.js', blob: new Blob([ENGINE], { type: 'text/javascript' }) },
    { path: base + 'js/game.js', blob: new Blob([GAME], { type: 'text/javascript' }) },
    { path: base + 'data/config.json', blob: new Blob([JSON.stringify(CONFIG, null, 2)], { type: 'application/json' }) },
    { path: base + 'img/sprites.png', blob: await makeSprites() },
    { path: base + 'audio/pickup.wav', blob: makeWav([880, 1760], 0.12) },
    { path: base + 'audio/hit.wav', blob: makeWav([200, 60], 0.35, 'noise') },
  ];
}
