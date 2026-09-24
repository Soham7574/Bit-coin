// 3D background scene: physically-based Bitcoin coin with instanced edge reeding,
// GPU-animated particle field, shader-drawn 3D price ribbon, shader grid floor,
// bloom + custom vignette/chromatic-aberration post-processing.
// Scroll choreography is driven from main.js through the returned API (GSAP ScrollTrigger).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const gsap = window.gsap;

export function createScene(canvas) {
  const isMobile = window.innerWidth < 768;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: "high-performance" });
  const MAX_DPR = Math.min(window.devicePixelRatio, 2);
  let dpr = MAX_DPR;
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.045);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, 9);
  const lookTarget = new THREE.Vector3(0, 0, 0);

  // ---------- Lights ----------
  const key = new THREE.DirectionalLight(0xffd199, 2.2);
  key.position.set(4, 5, 6);
  scene.add(key);
  const rim = new THREE.PointLight(0x7b5cff, 60, 30);
  rim.position.set(-5, -2, -3);
  scene.add(rim);
  const warm = new THREE.PointLight(0xf7931a, 22, 20);
  warm.position.set(3, -3, 4);
  scene.add(warm);

  // ---------- Coin ----------
  const coinRig = new THREE.Group(); // moved by scroll
  const coin = new THREE.Group(); // spun by idle / celebrate animations
  coinRig.add(coin);
  scene.add(coinRig);

  // Turned-metal micro rings for the coin faces: one random value per texture row.
  // The lathe's V coordinate runs along the profile, so rows become concentric rings.
  const ringCanvas = document.createElement("canvas");
  ringCanvas.width = 4; ringCanvas.height = 2048;
  const rc = ringCanvas.getContext("2d");
  for (let y = 0; y < ringCanvas.height; y++) {
    const v = 150 + Math.random() * 70 + (y % 7 === 0 ? 30 : 0);
    rc.fillStyle = `rgb(${v},${v},${v})`;
    rc.fillRect(0, y, 4, 1);
  }
  const ringTex = new THREE.CanvasTexture(ringCanvas);
  ringTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const gold = new THREE.MeshPhysicalMaterial({
    color: 0xe0901f, metalness: 1, roughness: 0.34, roughnessMap: ringTex,
    bumpMap: ringTex, bumpScale: 0.35,
    clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 1.5,
  });
  // Polished relief (emblem, rim ring, reeding): brighter and glossier than the field for contrast
  const goldBright = new THREE.MeshPhysicalMaterial({
    color: 0xffcf73, metalness: 1, roughness: 0.1,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.8,
  });

  // Lathe profile: flat face, raised rim, rounded edge (x = radius, y = thickness)
  const R = 1.6, T = 0.13;
  const prof = [
    [0, T - 0.03], [R - 0.2, T - 0.03], [R - 0.16, T + 0.03], [R - 0.06, T + 0.03],
    [R, T - 0.02], [R + 0.01, 0], [R, -T + 0.02], [R - 0.06, -T - 0.03],
    [R - 0.16, -T - 0.03], [R - 0.2, -T + 0.03], [0, -T + 0.03],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 128), gold);
  body.rotation.x = Math.PI / 2;
  coin.add(body);

  // Edge reeding: 160 instanced ridges around the rim
  const REEDS = 160;
  const reeds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.2, 0.03), goldBright, REEDS);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < REEDS; i++) {
    const a = (i / REEDS) * Math.PI * 2;
    q.setFromEuler(new THREE.Euler(Math.PI / 2, 0, a));
    m4.compose(new THREE.Vector3(Math.cos(a) * (R + 0.012), Math.sin(a) * (R + 0.012), 0), q, s);
    reeds.setMatrixAt(i, m4);
  }
  coin.add(reeds);

  // Bitcoin "₿" emblem as an extruded shape, on both faces
  function bitcoinShapes() {
    const k = 0.95;
    const B = new THREE.Shape();
    B.moveTo(-0.38 * k, -0.62 * k);
    B.lineTo(0.12 * k, -0.62 * k);
    B.absarc(0.12 * k, -0.31 * k, 0.31 * k, -Math.PI / 2, Math.PI / 2, false);
    B.lineTo(0.08 * k, 0);
    B.absarc(0.08 * k, 0.31 * k, 0.31 * k, -Math.PI / 2, Math.PI / 2, false);
    B.lineTo(-0.38 * k, 0.62 * k);
    B.closePath();
    const h1 = new THREE.Path();
    h1.moveTo(-0.2 * k, -0.46 * k);
    h1.lineTo(0.12 * k, -0.46 * k);
    h1.absarc(0.12 * k, -0.31 * k, 0.15 * k, -Math.PI / 2, Math.PI / 2, false);
    h1.lineTo(-0.2 * k, -0.16 * k);
    h1.closePath();
    const h2 = new THREE.Path();
    h2.moveTo(-0.2 * k, 0.16 * k);
    h2.lineTo(0.08 * k, 0.16 * k);
    h2.absarc(0.08 * k, 0.31 * k, 0.15 * k, -Math.PI / 2, Math.PI / 2, false);
    h2.lineTo(-0.2 * k, 0.46 * k);
    h2.closePath();
    B.holes.push(h1, h2);
    const bars = [];
    for (const x of [-0.22, 0.02]) {
      for (const [y0, y1] of [[0.6, 0.8], [-0.8, -0.6]]) {
        const b = new THREE.Shape();
        b.moveTo(x * k, y0 * k); b.lineTo((x + 0.1) * k, y0 * k);
        b.lineTo((x + 0.1) * k, y1 * k); b.lineTo(x * k, y1 * k); b.closePath();
        bars.push(b);
      }
    }
    return [B, ...bars];
  }
  const emblemGeo = new THREE.ExtrudeGeometry(bitcoinShapes(), {
    depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.012, bevelSegments: 3, curveSegments: 32,
  });
  emblemGeo.center();
  const front = new THREE.Mesh(emblemGeo, goldBright);
  front.position.z = T - 0.01;
  front.rotation.z = -0.22;
  coin.add(front);
  const back = front.clone();
  back.position.z = -T + 0.01;
  back.rotation.set(0, Math.PI, 0.22);
  coin.add(back);

  // Engraved ring on each face
  const ringGeo = new THREE.TorusGeometry(1.22, 0.02, 12, 128);
  for (const z of [T - 0.02, -T + 0.02]) {
    const ring = new THREE.Mesh(ringGeo, goldBright);
    ring.position.z = z;
    coin.add(ring);
  }

  // Glow halo (additive sprite shader) behind the coin
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.55 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime; uniform float uIntensity;
        void main(){
          vec2 p = vUv - .5; float d = length(p);
          float a = atan(p.y, p.x);
          float rays = .5 + .5 * sin(a * 12. + uTime * .6) * sin(a * 7. - uTime * .4);
          float g = smoothstep(.5, .0, d) * (.55 + .45 * rays * smoothstep(.1, .35, d));
          vec3 col = mix(vec3(1., .55, .1), vec3(.48, .36, 1.), smoothstep(.1, .5, d));
          gl_FragColor = vec4(col * g * g * uIntensity, 1.);
        }`,
    })
  );
  halo.position.z = -1.2;
  coinRig.add(halo);

  // ---------- Particle field (GPU animated) ----------
  const PCOUNT = isMobile ? 2500 : 6000;
  const pos = new Float32Array(PCOUNT * 3), seed = new Float32Array(PCOUNT), scale = new Float32Array(PCOUNT);
  for (let i = 0; i < PCOUNT; i++) {
    const r = 4 + Math.pow(Math.random(), 0.6) * 22;
    const th = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 18 * Math.random();
    pos.set([Math.cos(th) * r, y, Math.sin(th) * r - 6], i * 3);
    seed[i] = Math.random();
    scale[i] = 0.4 + Math.random() * 1.6;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  pGeo.setAttribute("aScale", new THREE.BufferAttribute(scale, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uPixel: { value: renderer.getPixelRatio() }, uScroll: { value: 0 },
      uMouse: { value: new THREE.Vector2() }, uBurst: { value: 0 },
    },
    vertexShader: `
      attribute float aSeed; attribute float aScale;
      uniform float uTime, uPixel, uScroll, uBurst; uniform vec2 uMouse;
      varying float vSeed; varying float vFade;
      mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c,-s,s,c); }
      void main(){
        vec3 p = position;
        float speed = .03 + aSeed * .05;
        p.xz = rot(uTime * speed + uScroll * 1.5) * (p.xz + vec2(0., 6.)) - vec2(0., 6.);
        p.y += sin(uTime * .5 + aSeed * 30.) * .35 + uScroll * (aSeed - .5) * 6.;
        p.xy += uMouse * (0.4 + aSeed) * .6;
        p += normalize(p + vec3(0., 0., 6.)) * uBurst * (2. + aSeed * 4.);
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aScale * uPixel * (26. / -mv.z) * (1. + uBurst);
        vSeed = aSeed; vFade = smoothstep(40., 6., -mv.z);
      }`,
    fragmentShader: `
      varying float vSeed; varying float vFade; uniform float uTime;
      void main(){
        float d = length(gl_PointCoord - .5);
        float a = smoothstep(.5, 0., d);
        float tw = .6 + .4 * sin(uTime * 2. + vSeed * 50.);
        vec3 col = mix(vec3(1., .6, .15), vec3(.5, .4, 1.), step(.62, vSeed));
        col = mix(col, vec3(1.), step(.95, vSeed) * .6);
        gl_FragColor = vec4(col * a * tw * vFade, a * vFade);
      }`,
  });
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  // ---------- 3D price ribbon (history), drawn progressively in the fragment shader ----------
  const ribbon = new THREE.Group();
  ribbon.position.set(0, -2.6, -6);
  scene.add(ribbon);
  const ribbonMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uProgress: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uProgress, uTime;
      void main(){
        if (vUv.x > uProgress) discard;
        float head = smoothstep(uProgress - .04, uProgress, vUv.x);
        float pulse = .5 + .5 * sin(vUv.x * 120. - uTime * 4.);
        vec3 col = mix(vec3(.45, .35, 1.), vec3(1., .58, .12), vUv.x);
        col += head * 1.5 + pulse * .15;
        gl_FragColor = vec4(col, .9);
      }`,
  });
  let ribbonMesh = null, ribbonCurve = null, pillars = null;
  const ribbonHead = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 24), new THREE.MeshBasicMaterial({ color: 0xffd08a }));
  ribbon.add(ribbonHead);
  ribbonHead.visible = false;

  function setPriceHistory(prices) {
    // x across time, y = log price, gentle z wave for depth
    const n = prices.length;
    const lp = prices.map(Math.log);
    const lo = Math.min(...lp), hi = Math.max(...lp);
    const pts = [];
    for (let i = 0; i < n; i += 2) {
      const t = i / (n - 1);
      pts.push(new THREE.Vector3((t - 0.5) * 16, ((lp[i] - lo) / (hi - lo)) * 5, Math.sin(t * Math.PI * 2) * 1.2));
    }
    ribbonCurve = new THREE.CatmullRomCurve3(pts);
    ribbonMesh = new THREE.Mesh(new THREE.TubeGeometry(ribbonCurve, 900, 0.035, 8, false), ribbonMat);
    ribbon.add(ribbonMesh);
    // Vertical "volume" pillars under the curve, instanced
    const PIL = 90;
    const pil = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.05, 1, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x6b55ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
      PIL
    );
    for (let i = 0; i < PIL; i++) {
      const p = ribbonCurve.getPointAt(i / (PIL - 1));
      const h = Math.max(p.y + 0.6, 0.05);
      m4.compose(new THREE.Vector3(p.x, p.y - h / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      pil.setMatrixAt(i, m4);
    }
    ribbon.add(pil);
    pillars = pil;
    ribbonHead.visible = true;
  }

  // ---------- Shader grid floor ----------
  const grid = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec3 vW; uniform float uTime;
        float line(float x, float w){ float f = abs(fract(x - .5) - .5) / fwidth(x); return 1. - min(f / w, 1.); }
        void main(){
          vec2 g = vW.xz * .8 + vec2(0., uTime * .25);
          float l = max(line(g.x, 1.), line(g.y, 1.));
          float fade = smoothstep(40., 2., length(vW.xz));
          gl_FragColor = vec4(vec3(.42, .33, 1.) * l * fade * .5, l * fade * .5);
        }`,
      extensions: { derivatives: true },
    })
  );
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -3.4;
  scene.add(grid);

  // ---------- Post-processing ----------
  const target = new THREE.WebGLRenderTarget(window.innerWidth * dpr, window.innerHeight * dpr, {
    type: THREE.HalfFloatType, samples: 4, // MSAA inside the post-processing chain
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.55, 0.88);
  composer.addPass(bloom);
  const finish = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uAberration: { value: 0.0015 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uAberration, uTime; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 d = vUv - .5; float r2 = dot(d, d);
        vec2 off = d * uAberration * (1. + r2 * 4.);
        vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        c *= smoothstep(.85, .15, r2 * 1.6);
        c += (hash(vUv * 900. + uTime) - .5) * .012;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  composer.addPass(finish);
  composer.addPass(new OutputPass());

  // ---------- Interaction & loop ----------
  const mouse = new THREE.Vector2();
  const mouseSmooth = new THREE.Vector2();
  window.addEventListener("pointermove", (e) => {
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  });

  // State tweened by GSAP from main.js
  const state = { spin: 0, idleSpeed: 0.35, ribbonProgress: 0, scroll: 0, zoom: 0 };

  let visible = true;
  document.addEventListener("visibilitychange", () => (visible = !document.hidden));
  const camBase = new THREE.Vector3(0, 0, 9);

  // Frame-rate independent smoothing: same feel at 60, 120 or 144 Hz
  const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  // Adaptive resolution: only if frames are consistently slow, lower the pixel ratio a
  // little; raise it back when there is headroom. Fast machines keep full quality.
  let frameAvg = 16.7, sinceChange = 0;
  function governor(dtMs) {
    frameAvg += (dtMs - frameAvg) * 0.05;
    sinceChange += dtMs;
    if (sinceChange < 1500) return;
    let next = dpr;
    if (frameAvg > 22 && dpr > 1) next = Math.max(1, dpr - 0.25);
    else if (frameAvg < 14 && dpr < MAX_DPR) next = Math.min(MAX_DPR, dpr + 0.25);
    if (next !== dpr) {
      dpr = next;
      renderer.setPixelRatio(dpr);
      composer.setPixelRatio(dpr);
      pMat.uniforms.uPixel.value = dpr;
      sinceChange = 0;
    }
  }

  let t = 0;
  // Driven by gsap.ticker (see main.js) so rendering, scroll and tweens share one frame loop
  function render(dtMs) {
    if (!visible) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    t += dt;
    mouseSmooth.lerp(mouse, damp(3, dt));

    state.spin += state.idleSpeed * dt;
    coin.rotation.y = state.spin + mouseSmooth.x * 0.4;
    coin.rotation.x = -mouseSmooth.y * 0.3 + Math.sin(t * 0.7) * 0.05;
    coin.position.y = Math.sin(t * 1.1) * 0.08;

    halo.material.uniforms.uTime.value = t;
    halo.lookAt(camera.position);
    pMat.uniforms.uTime.value = t;
    pMat.uniforms.uMouse.value.copy(mouseSmooth);
    pMat.uniforms.uScroll.value = state.scroll;
    ribbonMat.uniforms.uTime.value = t;
    ribbonMat.uniforms.uProgress.value = state.ribbonProgress;
    if (pillars) pillars.material.opacity = 0.25 * THREE.MathUtils.smoothstep(state.ribbonProgress, 0.3, 0.8);
    ribbonHead.visible = state.ribbonProgress > 0.01;
    if (ribbonCurve && ribbonHead.visible) ribbonHead.position.copy(ribbonCurve.getPointAt(Math.min(state.ribbonProgress, 1)));
    grid.material.uniforms.uTime.value = t;
    finish.uniforms.uTime.value = t;

    const k = damp(4, dt);
    camera.position.x += (camBase.x + mouseSmooth.x * 0.35 - camera.position.x) * k;
    camera.position.y += (camBase.y + mouseSmooth.y * 0.2 - camera.position.y) * k;
    camera.position.z += (camBase.z + state.zoom - camera.position.z) * k;
    camera.lookAt(lookTarget);

    rim.intensity = 60 + Math.sin(t * 1.3) * 15;
    composer.render(dt);
    governor(dtMs);
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  return {
    camera, camBase, lookTarget, coinRig, coin, halo, ribbon, state, bloom, finish, particles: pMat, isMobile,
    setPriceHistory, render,
    // Compile every shader (scene + post-processing) up front so the first real frames don't stall
    async warmup() {
      const hidden = [];
      scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
      try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
      composer.render(0.016);
      hidden.forEach((o) => (o.visible = false));
    },
    // Called after a prediction: spin the coin, flash the bloom and burst the particles
    celebrate(up = true) {
      gsap.timeline()
        .to(state, { spin: state.spin + Math.PI * 4, duration: 2.2, ease: "expo.out" }, 0)
        .to(bloom, { strength: 1.6, duration: 0.25, yoyo: true, repeat: 1, ease: "power2.out" }, 0)
        .to(pMat.uniforms.uBurst, { value: 0.6, duration: 0.35, yoyo: true, repeat: 1, ease: "power3.out" }, 0)
        .to(finish.uniforms.uAberration, { value: 0.012, duration: 0.2, yoyo: true, repeat: 1 }, 0)
        .to(halo.material.uniforms.uIntensity, { value: up ? 1.1 : 0.3, duration: 0.6, yoyo: true, repeat: 1 }, 0);
    },
  };
}
