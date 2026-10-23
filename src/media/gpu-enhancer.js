// ==========================================================================
// VHO GPU Enhancer: WebGL2 super-resolution pipeline for low-res media
//
//   source ─► [bilateral denoise] ─► [FSR 1.0 EASU upscale ×N] ─► [FSR RCAS + BCS + A/B] ─► screen
//
// EASU/RCAS are ports of AMD FidelityFX Super Resolution 1.0 (MIT license).
// All textures use bottom-up (GL) orientation: sources are uploaded with UNPACK_FLIP_Y.
// ==========================================================================

const VS = `#version 300 es
out vec2 vUv;
void main() {
  // Single full-screen triangle (no vertex buffer needed)
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Edge-preserving bilateral filter at source resolution: removes compression
// noise/mosquito artifacts so EASU and RCAS don't amplify them.
const FS_DENOISE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uStrength; // 0..1
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float sigmaR = mix(0.03, 0.12, uStrength);
  float invR = 1.0 / (2.0 * sigmaR * sigmaR);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec3 s = texture(uTex, vUv + vec2(x, y) * uTexel).rgb;
      vec3 d = s - c;
      float w = exp(-float(x * x + y * y) * 0.2222 - dot(d, d) * invR);
      acc += s * w;
      wsum += w;
    }
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

// FSR 1.0 EASU: edge-adaptive spatial upsampling (12-tap, direction-aware Lanczos-like kernel)
const FS_EASU = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uCon0, uCon1, uCon2, uCon3;
out vec4 outColor;

vec3 tap(vec2 p) { return texture(uTex, p).rgb; }

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
  v *= len;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aW += w;
  aC += w * c;
}

void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float lenX = max(abs(lD - lC), abs(lC - lB));
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) / max(lenX, 1e-5), 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float lenY = max(abs(lE - lC), abs(lC - lA));
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) / max(lenY, 1e-5), 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

void main() {
  vec2 ip = floor(gl_FragCoord.xy);
  vec2 pp = ip * uCon0.xy + uCon0.zw;
  vec2 fp = floor(pp);
  pp -= fp;

  vec2 p0 = fp * uCon1.xy + uCon1.zw;
  vec2 p1 = p0 + uCon2.xy;
  vec2 p2 = p0 + uCon2.zw;
  vec2 p3 = p0 + uCon3.xy;
  vec4 off = vec4(-0.5, 0.5, -0.5, 0.5) * uCon1.xxyy;

  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 bC = tap(p0 + off.xw); float bL = bC.g + 0.5 * (bC.r + bC.b);
  vec3 cC = tap(p0 + off.yw); float cL = cC.g + 0.5 * (cC.r + cC.b);
  vec3 iC = tap(p1 + off.xw); float iL = iC.g + 0.5 * (iC.r + iC.b);
  vec3 jC = tap(p1 + off.yw); float jL = jC.g + 0.5 * (jC.r + jC.b);
  vec3 fC = tap(p1 + off.yz); float fL = fC.g + 0.5 * (fC.r + fC.b);
  vec3 eC = tap(p1 + off.xz); float eL = eC.g + 0.5 * (eC.r + eC.b);
  vec3 kC = tap(p2 + off.xw); float kL = kC.g + 0.5 * (kC.r + kC.b);
  vec3 lC = tap(p2 + off.yw); float lL = lC.g + 0.5 * (lC.r + lC.b);
  vec3 hC = tap(p2 + off.yz); float hL = hC.g + 0.5 * (hC.r + hC.b);
  vec3 gC = tap(p2 + off.xz); float gL = gC.g + 0.5 * (gC.r + gC.b);
  vec3 oC = tap(p3 + off.yz); float oL = oC.g + 0.5 * (oC.r + oC.b);
  vec3 nC = tap(p3 + off.xz); float nL = nC.g + 0.5 * (nC.r + nC.b);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < (1.0 / 32768.0);
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= vec2(dirR);
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 - 0.29 * len;
  float clp = 1.0 / lob;

  vec3 min4 = min(min(fC, gC), min(jC, kC));
  vec3 max4 = max(max(fC, gC), max(jC, kC));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, iC);
  easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, jC);
  easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, fC);
  easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, eC);
  easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, kC);
  easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, lC);
  easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, hC);
  easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, gC);
  easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, oC);
  easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, nC);

  // Normalize and de-ring against the 4 nearest texels
  outColor = vec4(min(max4, max(min4, aC / aW)), 1.0);
}`;

// FSR 1.0 RCAS (robust contrast-adaptive sharpening, noise-aware) + brightness/contrast/saturation + A/B split
const FS_FINAL = `#version 300 es
precision highp float;
uniform sampler2D uUp;    // upscaled image (output resolution) or the source itself
uniform sampler2D uOrig;  // untouched source (A/B left half)
uniform vec2  uPx;        // 1 / sampling grid of uUp
uniform float uRcas;      // exp2(-sharpness stops), 0 = off
uniform float uSplit;     // 0 = off, otherwise split position 0..1
uniform vec3  uBCS;       // processed side: brightness, contrast, saturation (1 = neutral)
uniform vec3  uBase;      // original side
uniform float uDetail;    // clarity strength (0 = off)
uniform float uLod;       // mip level ≈ source-pixel scale, used as the clarity blur
in vec2 vUv;
out vec4 outColor;

const float RCAS_LIMIT = 0.25 - 1.0 / 16.0;

vec3 bcs(vec3 c, vec3 k) {
  c *= k.x;
  c = (c - 0.5) * k.y + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3(l), c, k.z), 0.0, 1.0);
}

float luma2(vec3 c) { return c.g + 0.5 * (c.r + c.b); }

vec3 rcas(vec2 uv) {
  vec3 b = texture(uUp, uv + vec2(0.0, -uPx.y)).rgb;
  vec3 d = texture(uUp, uv + vec2(-uPx.x, 0.0)).rgb;
  vec3 e = texture(uUp, uv).rgb;
  vec3 f = texture(uUp, uv + vec2(uPx.x, 0.0)).rgb;
  vec3 h = texture(uUp, uv + vec2(0.0, uPx.y)).rgb;
  float bL = luma2(b), dL = luma2(d), eL = luma2(e), fL = luma2(f), hL = luma2(h);

  // Noise detection: soften the effect on isolated pixel noise
  float nz = 0.25 * (bL + dL + fL + hL) - eL;
  float range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = clamp(abs(nz) / max(range, 1e-5), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;

  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = mn4 / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (1.0 - mx4) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uRcas;
  lobe *= nz;
  return clamp((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 0.0, 1.0);
}

void main() {
  if (uSplit > 0.0 && vUv.x < uSplit) {
    outColor = vec4(bcs(texture(uOrig, vUv).rgb, uBase), 1.0);
    return;
  }
  vec3 c = uRcas > 0.0 ? rcas(vUv) : texture(uUp, vUv).rgb;
  if (uDetail > 0.0) {
    // Clarity: boost mid-frequency detail (texture of fabric, grass, faces) that a
    // 1-pixel sharpener can't reach after a large upscale. Halo-limited.
    vec3 blur = textureLod(uUp, vUv, uLod).rgb;
    vec3 d = clamp((c - blur) * uDetail, -0.12, 0.12);
    c = clamp(c + d, 0.0, 1.0);
  }
  outColor = vec4(bcs(c, uBCS), 1.0);
}`;

// Each EASU pass handles up to this factor; larger upscales are chained (e.g. 144p → 1080p = 3 passes)
const MAX_EASU_STEP = 2.2;

export function createGpuEnhancer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  function program(fsSrc, names) {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
    return { prog, u };
  }

  const pDenoise = program(FS_DENOISE, ["uTex", "uTexel", "uStrength"]);
  const pEasu = program(FS_EASU, ["uTex", "uCon0", "uCon1", "uCon2", "uCon3"]);
  const pFinal = program(FS_FINAL, ["uUp", "uOrig", "uPx", "uRcas", "uSplit", "uBCS", "uBase", "uDetail", "uLod"]);

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  const srcTex = makeTexture();

  // Render targets, reallocated only when their size changes
  const targets = [];
  function target(i, w, h) {
    let t = targets[i];
    if (!t) {
      t = targets[i] = { tex: makeTexture(), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w;
      t.h = h;
    }
    return t;
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // sharp: 0..1 (RCAS strength), denoise: 0..1, box: () => [w, h] CSS px to stretch into (photo /
  // forced aspect ratio) or null for "contain" fitting.
  const opts = { sharp: 0.6, denoise: 0, detail: 0, split: 0, bcs: [1, 1, 1], base: [1, 1, 1], box: null };
  let source = null, running = false, rvfcId = 0, rafId = 0, lost = false;

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; stop(); });

  function srcSize() {
    return source instanceof HTMLVideoElement
      ? [source.videoWidth, source.videoHeight]
      : [source.naturalWidth, source.naturalHeight];
  }

  function draw() {
    if (!source || lost) return false;
    const [sw, sh] = srcSize();
    if (!sw || !sh) return false;

    // Canvas at physical pixel size (DPR aware). clientWidth ignores CSS transforms.
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }

    let vw, vh;
    const box = opts.box?.();
    if (box && box[0] > 0 && box[1] > 0) {
      vw = Math.max(1, Math.round(box[0] * dpr));
      vh = Math.max(1, Math.round(box[1] * dpr));
    } else {
      const scale = Math.min(cw / sw, ch / sh);
      vw = Math.max(1, Math.round(sw * scale));
      vh = Math.max(1, Math.round(sh * scale));
    }

    // 1) Upload the current frame
    bindTex(0, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {               // CORS-tainted source: disable safely
      console.warn("[GPU Enhancer] texImage2D:", err);
      stop();
      canvas.dispatchEvent(new CustomEvent("enhancer-error", { detail: err }));
      return false;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    // Large photos shrunk on screen: mipmaps avoid shimmering/aliasing
    const downscale = vw < sw * 0.5 && !(source instanceof HTMLVideoElement);
    if (downscale) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, downscale ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);

    let cur = { tex: srcTex, w: sw, h: sh };
    let ti = 0;

    // 2) Denoise at source resolution (only meaningful for low-res sources)
    if (opts.denoise > 0.001 && sh <= 720) {
      const t = target(ti++, sw, sh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.useProgram(pDenoise.prog);
      bindTex(0, cur.tex);
      gl.uniform1i(pDenoise.u.uTex, 0);
      gl.uniform2f(pDenoise.u.uTexel, 1 / sw, 1 / sh);
      gl.uniform1f(pDenoise.u.uStrength, opts.denoise);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur = t;
    }

    // 3) EASU upscale, chained in ≤2.2× steps so edges stay clean at 5-8× factors
    if (opts.sharp > 0.001 && (vw > cur.w * 1.05 || vh > cur.h * 1.05)) {
      gl.useProgram(pEasu.prog);
      gl.uniform1i(pEasu.u.uTex, 0);
      while (cur.w < vw || cur.h < vh) {
        const f = Math.min(MAX_EASU_STEP, Math.max(vw / cur.w, vh / cur.h));
        const ow = Math.min(vw, Math.round(cur.w * f));
        const oh = Math.min(vh, Math.round(cur.h * f));
        const finalStep = ow === vw && oh === vh;
        const t = target(ti++, finalStep ? vw : ow, finalStep ? vh : oh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, t.w, t.h);
        bindTex(0, cur.tex);
        const rx = cur.w / t.w, ry = cur.h / t.h;
        gl.uniform4f(pEasu.u.uCon0, rx, ry, 0.5 * rx - 0.5, 0.5 * ry - 0.5);
        gl.uniform4f(pEasu.u.uCon1, 1 / cur.w, 1 / cur.h, 1 / cur.w, -1 / cur.h);
        gl.uniform4f(pEasu.u.uCon2, -1 / cur.w, 2 / cur.h, 1 / cur.w, 2 / cur.h);
        gl.uniform4f(pEasu.u.uCon3, 0, 4 / cur.h, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        cur = t;
        if (finalStep) break;
      }
    }

    // Clarity needs a blurred copy at roughly source-pixel scale: mipmaps of the upscaled image
    const upscaled = cur.tex !== srcTex && cur.w === vw;
    const scale = vw / sw;
    const useDetail = opts.detail > 0.001 && upscaled && scale > 1.5;
    bindTex(0, cur.tex);
    if (useDetail) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // 4) RCAS + clarity + color + A/B split to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport((cw - vw) >> 1, (ch - vh) >> 1, vw, vh);
    gl.useProgram(pFinal.prog);
    bindTex(0, cur.tex);
    bindTex(1, srcTex);
    gl.uniform1i(pFinal.u.uUp, 0);
    gl.uniform1i(pFinal.u.uOrig, 1);
    gl.uniform2f(pFinal.u.uPx, 1 / vw, 1 / vh);
    // RCAS "sharpness" is in stops (0 = strongest); map 0..1 strength onto 2..0 stops
    gl.uniform1f(pFinal.u.uRcas, opts.sharp > 0.001 ? Math.pow(2, -2 * (1 - opts.sharp)) : 0);
    gl.uniform1f(pFinal.u.uSplit, opts.split);
    gl.uniform3fv(pFinal.u.uBCS, opts.bcs);
    gl.uniform3fv(pFinal.u.uBase, opts.base);
    gl.uniform1f(pFinal.u.uDetail, useDetail ? opts.detail : 0);
    gl.uniform1f(pFinal.u.uLod, Math.min(3.5, Math.max(1, Math.log2(scale) * 0.8)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    if (useDetail) {
      // The texture is rendered into again next frame: drop back to a non-mipmapped filter
      bindTex(0, cur.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return true;
  }

  function loop() {
    if (!running) return;
    draw();
    if (source instanceof HTMLVideoElement && "requestVideoFrameCallback" in source) {
      rvfcId = source.requestVideoFrameCallback(loop);
    } else if (source instanceof HTMLVideoElement) {
      rafId = requestAnimationFrame(loop);
    } // a still <img> needs a single frame
  }

  function start(el) {
    stop();
    source = el;
    running = true;
    canvas.hidden = false;
    loop();
  }

  function stop() {
    running = false;
    if (rvfcId && source?.cancelVideoFrameCallback) source.cancelVideoFrameCallback(rvfcId);
    cancelAnimationFrame(rafId);
    rvfcId = rafId = 0;
    canvas.hidden = true;
  }

  function set(patch) {
    Object.assign(opts, patch);
    if (running) draw();          // update immediately, even while paused
  }

  /** Snapshot: redraw the processed frame in the same task and encode it. */
  function snapshot(type = "image/png") {
    return new Promise((res) => { draw(); canvas.toBlob(res, type); });
  }

  const ro = new ResizeObserver(() => running && draw());
  ro.observe(canvas);

  function destroy() {
    stop();
    ro.disconnect();
    for (const t of targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    gl.deleteTexture(srcTex);
    [pDenoise, pEasu, pFinal].forEach((p) => gl.deleteProgram(p.prog));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return {
    start, stop, set, snapshot, destroy,
    get active() { return running; },
    get source() { return source; },
  };
}
