// ---------------------------------------------------------------------------
// Super Basketball - a basic single-player basketball throwing game
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const VIEW_W = canvas.width;
const VIEW_H = canvas.height;

const GROUND_Y = 430;           // court floor line
const ARENA_LEFT = 40;          // left play boundary (pole area excluded)
const ARENA_RIGHT = VIEW_W - 30;

// Hoop geometry (fixed at the left side of the arena, matching the court art)
const HOOP = {
  poleX: 90,
  backboardX: 108,
  backboardTop: 130,
  backboardBottom: 230,
  rimX: 138,
  rimY: 200,
  rimRadius: 16,
};

const THREE_POINT_X = 560; // shoot from at/beyond this x for a 3-pointer

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
const playerImg = new Image();
playerImg.src = 'assets/player-sprite.png';
// Bounding box of the large, clean character pose inside the sprite sheet.
const SPRITE_SRC = { x: 5, y: 20, w: 495, h: 810 };

// The sprite sheet's background is a flat near-white fill rather than real
// alpha transparency, so it gets chroma-keyed out into an offscreen canvas
// once the image loads; drawPlayer() reads from that canvas instead.
let playerSprite = null;

const ballImg = new Image();
ballImg.src = 'assets/basketball.png';

let assetsReady = 0;
function assetLoaded() {
  assetsReady++;
}
playerImg.onload = () => {
  playerSprite = chromaKeyBackground(playerImg);
  assetLoaded();
};
ballImg.onload = assetLoaded;

function chromaKeyBackground(img) {
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  const imgData = octx.getImageData(0, 0, off.width, off.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (r > 195 && g > 195 && b > 195 && max - min < 18) {
      d[i + 3] = 0;
    }
  }
  octx.putImageData(imgData, 0, 0);
  return off;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const keys = { left: false, right: false };

const player = {
  x: 650,
  y: GROUND_Y,
  w: 62,
  h: 100,
  speed: 3,
  facing: -1,       // -1 = facing hoop (left), 1 = facing right
  moveFacing: -1,   // facing based on last movement input
  walkPhase: 0,
  isMoving: false,
};

const ball = {
  state: 'held',   // 'held' | 'flying' | 'settling'
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  radius: 15,
  rotation: 0,
  scored: false,
  restTimer: 0,
};

let power = 0;              // 0..1 charge level
let charging = false;
const CHARGE_RATE = 1 / 55; // full charge in ~55 frames (~0.9s)
const MIN_LAUNCH = 2.46;
const MAX_LAUNCH = 12.08;
const GRAVITY = 0.127;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

let score = 0;
let shotsMade = 0;
let shotsAttempted = 0;

let throwLean = 0; // visual lean while charging / snapping

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'ArrowLeft') { keys.left = true; e.preventDefault(); }
  if (e.code === 'ArrowRight') { keys.right = true; e.preventDefault(); }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!charging && ball.state === 'held') {
      charging = true;
      power = 0;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft') keys.left = false;
  if (e.code === 'ArrowRight') keys.right = false;
  if (e.code === 'Space') {
    e.preventDefault();
    if (charging) {
      throwBall();
      charging = false;
    }
  }
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
function update() {
  // Movement (locked while a shot is being charged)
  player.isMoving = false;
  if (!charging) {
    if (keys.left) {
      player.x -= player.speed;
      player.moveFacing = -1;
      player.isMoving = true;
    }
    if (keys.right) {
      player.x += player.speed;
      player.moveFacing = 1;
      player.isMoving = true;
    }
  }
  player.x = Math.max(ARENA_LEFT + 130, Math.min(ARENA_RIGHT, player.x));

  if (player.isMoving) {
    player.walkPhase += 0.22;
  } else {
    player.walkPhase = 0;
  }

  // Facing: while charging/holding, always face the hoop; otherwise follow movement
  player.facing = charging || ball.state !== 'held' ? -1 : player.moveFacing;

  // Charging power
  if (charging) {
    power = Math.min(1, power + CHARGE_RATE);
    throwLean = -power * 0.35; // lean back while winding up
  } else if (throwLean < 0) {
    throwLean = Math.min(0, throwLean + 0.05); // ease back to neutral
  }

  // Ball behaviour
  if (ball.state === 'held') {
    const handX = player.x + player.facing * (player.w * 0.35);
    const handY = player.y - player.h * 0.62;
    ball.x = handX;
    ball.y = handY;
  } else if (ball.state === 'flying') {
    const prevX = ball.x;
    const prevY = ball.y;
    ball.vy += GRAVITY;
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.rotation += ball.vx * 0.05;

    checkRimCollision(prevX, prevY);

    // Backboard collision
    if (
      ball.x - ball.radius <= HOOP.backboardX &&
      ball.y >= HOOP.backboardTop &&
      ball.y <= HOOP.backboardBottom &&
      ball.vx < 0
    ) {
      ball.x = HOOP.backboardX + ball.radius;
      ball.vx *= -0.45;
    }

    // Ground collision
    if (ball.y + ball.radius >= GROUND_Y) {
      ball.y = GROUND_Y - ball.radius;
      if (!ball.scored) {
        endShot(false);
      }
      ball.vy *= -0.35;
      ball.vx *= 0.6;
      ball.state = 'settling';
      ball.restTimer = 0;
    }

    // Out of bounds on the right (shouldn't normally happen since it arcs left)
    if (ball.x > VIEW_W + 40) {
      if (!ball.scored) endShot(false);
      resetBallToPlayer();
    }
  } else if (ball.state === 'settling') {
    ball.vy += GRAVITY;
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.rotation += ball.vx * 0.05;
    if (ball.y + ball.radius >= GROUND_Y) {
      ball.y = GROUND_Y - ball.radius;
      ball.vy *= -0.35;
      ball.vx *= 0.6;
    }
    ball.restTimer++;
    if (ball.restTimer > 55 || Math.abs(ball.vx) < 0.05) {
      resetBallToPlayer();
    }
  }
}

function throwBall() {
  ball.state = 'flying';
  ball.scored = false;
  const launchSpeed = MIN_LAUNCH + power * (MAX_LAUNCH - MIN_LAUNCH);
  // Close-range shots need a steep, lobbed arc (like a real layup) since the
  // ball starts near chest height and has to climb well above the rim; long
  // shots flatten out. Without this, point-blank shots always sail past the
  // rim horizontally before they've climbed high enough to drop through it.
  const distToHoop = Math.abs(player.x - HOOP.rimX);
  const angle = clamp(75 - distToHoop / 18, 45, 75) * (Math.PI / 180);
  ball.vx = -Math.cos(angle) * launchSpeed;
  ball.vy = -Math.sin(angle) * launchSpeed;
  ball.shotFromX = player.x;
  shotsAttempted++;
  throwLean = 0.4; // forward snap
  power = 0;
  updateStats();
}

function checkRimCollision(prevX, prevY) {
  if (ball.scored) return;
  // Sweep across several substeps between the previous and current position so
  // a fast-moving ball can't tunnel through the scoring window between frames.
  const STEPS = 6;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const sx = prevX + (ball.x - prevX) * t;
    const sy = prevY + (ball.y - prevY) * t;
    const dx = sx - HOOP.rimX;
    const dy = sy - HOOP.rimY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const withinRim = Math.abs(dx) < HOOP.rimRadius - 4;
    const atRimHeight = Math.abs(dy) < 10;
    if (withinRim && atRimHeight && ball.vy > 0) {
      ball.scored = true;
      ball.vx = -0.5;
      ball.vy = 3;
      const isThree = ball.shotFromX >= THREE_POINT_X;
      endShot(true, isThree ? 3 : 2);
      return;
    } else if (dist < HOOP.rimRadius + ball.radius * 0.4 && ball.vy > 0 && !withinRim) {
      // clank off the rim edge
      ball.vx *= -0.5;
      ball.vy *= 0.7;
      return;
    }
  }
}

function endShot(made, points = 0) {
  if (made) {
    score += points;
    shotsMade++;
    showFeedback(points === 3 ? 'SWISH! +3' : 'NICE! +2', 'make');
  } else {
    showFeedback('MISS', 'miss');
  }
  updateStats();
}

function resetBallToPlayer() {
  ball.state = 'held';
  ball.vx = 0;
  ball.vy = 0;
  ball.scored = false;
}

function updateStats() {
  document.getElementById('score').textContent = score;
  document.getElementById('stats').textContent = `${shotsMade} / ${shotsAttempted} shots`;
}

let feedbackTimer = null;
function showFeedback(text, cls) {
  const el = document.getElementById('feedback');
  el.textContent = text;
  el.className = cls;
  // force reflow so the show class re-triggers the transition every time
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => el.classList.remove('show'), 700);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function drawBackground() {
  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#1b1147');
  sky.addColorStop(0.45, '#5a2f6b');
  sky.addColorStop(0.75, '#e8734f');
  sky.addColorStop(1, '#ffb45c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y);

  // Stars
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 40; i++) {
    const sx = (i * 137.5) % VIEW_W;
    const sy = (i * 71.3) % (GROUND_Y * 0.5);
    ctx.globalAlpha = 0.3 + (i % 5) * 0.12;
    ctx.fillRect(sx, sy, 2, 2);
  }
  ctx.globalAlpha = 1;

  // Skyline silhouette
  ctx.fillStyle = 'rgba(30, 15, 45, 0.55)';
  let bx = 0;
  let seed = 12345;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  while (bx < VIEW_W) {
    const bw = 24 + rnd() * 40;
    const bh = 40 + rnd() * 140;
    ctx.fillRect(bx, GROUND_Y - 60 - bh, bw, bh);
    bx += bw + 4;
  }

  // Distant water / horizon glow
  ctx.fillStyle = 'rgba(255, 180, 120, 0.18)';
  ctx.fillRect(0, GROUND_Y - 65, VIEW_W, 65);

  // Court floor
  const floor = ctx.createLinearGradient(0, GROUND_Y, 0, VIEW_H);
  floor.addColorStop(0, '#3b3866');
  floor.addColorStop(1, '#211f3d');
  ctx.fillStyle = floor;
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);

  // Court lines
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 4);
  ctx.lineTo(VIEW_W, GROUND_Y + 4);
  ctx.stroke();

  // Three point arc marker
  ctx.beginPath();
  ctx.setLineDash([6, 6]);
  ctx.moveTo(THREE_POINT_X, GROUND_Y);
  ctx.lineTo(THREE_POINT_X, GROUND_Y + 55);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '11px Segoe UI';
  ctx.fillText('3PT', THREE_POINT_X - 14, GROUND_Y + 68);
}

function drawHoop() {
  // Pole
  ctx.fillStyle = '#2b2b3a';
  ctx.fillRect(HOOP.poleX - 6, HOOP.backboardTop - 20, 12, GROUND_Y - (HOOP.backboardTop - 20));

  // Backboard
  ctx.fillStyle = 'rgba(235, 240, 255, 0.85)';
  ctx.fillRect(HOOP.backboardX, HOOP.backboardTop, 8, HOOP.backboardBottom - HOOP.backboardTop);
  ctx.strokeStyle = '#ff5c5c';
  ctx.lineWidth = 2;
  ctx.strokeRect(HOOP.backboardX + 1, HOOP.backboardTop + 14, 5, 20);

  // Rim
  ctx.strokeStyle = '#ff6b35';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(HOOP.rimX, HOOP.rimY, HOOP.rimRadius, 5, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Net
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  const netLen = 22;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(HOOP.rimX + i * (HOOP.rimRadius - 3), HOOP.rimY);
    ctx.lineTo(HOOP.rimX + i * (HOOP.rimRadius - 8), HOOP.rimY + netLen);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(HOOP.rimX - HOOP.rimRadius, HOOP.rimY);
  ctx.lineTo(HOOP.rimX + HOOP.rimRadius, HOOP.rimY);
  ctx.stroke();
}

function drawPlayer() {
  if (!playerSprite) return;

  const { x, y, w, h, facing } = player;
  const bob = player.isMoving ? Math.sin(player.walkPhase) * 4 : 0;

  ctx.save();
  ctx.translate(x, y - h / 2 + bob);
  ctx.scale(facing, 1);
  ctx.rotate(-throwLean * facing);
  ctx.drawImage(
    playerSprite,
    SPRITE_SRC.x, SPRITE_SRC.y, SPRITE_SRC.w, SPRITE_SRC.h,
    -w / 2, -h / 2, w, h
  );
  ctx.restore();

  // Power meter above player while charging
  if (charging) {
    const barW = 60;
    const barX = x - barW / 2;
    const barY = y - h - 22;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(barX, barY, barW, 8);
    ctx.fillStyle = power > 0.85 ? '#ff5c5c' : '#ffd23f';
    ctx.fillRect(barX, barY, barW * power, 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, 8);
  }
}

function drawBall() {
  if (!ballImg.complete || ballImg.naturalWidth === 0) return;
  const size = ball.radius * 2;
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(ball.rotation);
  ctx.drawImage(ballImg, -ball.radius, -ball.radius, size, size);
  ctx.restore();
}

function draw() {
  drawBackground();
  drawHoop();
  drawBall();
  drawPlayer();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

resetBallToPlayer();
updateStats();
loop();
