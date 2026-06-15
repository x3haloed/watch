import * as THREE from "../../node_modules/three/build/three.module.js";

const buzzPalette = {
  theme: "buzz",
  clear: "#010204",
  fog: "#010204",
  ambient: { color: "#2a3442", intensity: 0.34 },
  key: { color: "#dbeafe", intensity: 0.92 },
  rimLight: { color: "#8fb7ff", intensity: 2.8 },
  toolLight: { color: "#74f0b1", intensity: 1.3 },
  callLight: { color: "#ffb15d", intensity: 0.9 },
};

export const buzzVisualization = {
  id: "buzz",
  name: "BUZZ",
  theme: buzzPalette.theme,
  mount(host) {
    return mountBuzz(host, buzzPalette);
  },
};

function mountBuzz(host, palette) {
  host.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.className = "visualization-canvas";
  host.append(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(palette.clear, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(palette.fog, 0.038);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.06, 5.45);

  const ambient = new THREE.AmbientLight(palette.ambient.color, palette.ambient.intensity);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(palette.key.color, palette.key.intensity);
  key.position.set(3.5, 4, 4.5);
  scene.add(key);

  const rimLight = new THREE.PointLight(palette.rimLight.color, palette.rimLight.intensity, 9);
  rimLight.position.set(-1.8, 1.1, 2.7);
  scene.add(rimLight);

  const toolLight = new THREE.PointLight(palette.toolLight.color, palette.toolLight.intensity, 8);
  toolLight.position.set(2.1, -1.1, 2.2);
  scene.add(toolLight);

  const callLight = new THREE.PointLight(palette.callLight.color, palette.callLight.intensity, 7);
  callLight.position.set(0.4, 1.4, 2.4);
  scene.add(callLight);

  const membrane = new BuzzMembrane();
  scene.add(membrane.group);

  let disposed = false;
  let previousFrameTime = performance.now() / 1000;
  let elapsedTime = 0;
  const livePulses = [];
  const state = {
    pressure: 0.062,
    output: 0,
    tool: 0,
    call: 0,
    thinking: 0,
    digestion: 0,
    queued: 0,
    listening: 1,
    error: 0,
    reset: 0,
  };
  const posture = {
    mode: "listening",
    updatedAt: performance.now() / 1000,
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  renderer.setAnimationLoop(() => {
    if (disposed) return;
    const now = performance.now() / 1000;
    const dt = Math.min(now - previousFrameTime, 0.05);
    previousFrameTime = now;
    elapsedTime += dt;
    decayPulses(livePulses, dt);
    const pulseState = pulseStateFrom(livePulses);
    const postureState = postureTargets(posture, now);

    state.pressure = damp(state.pressure, Math.max(postureState.pressure, pulseState.pressure), 0.06);
    state.output = damp(state.output, Math.max(postureState.output, pulseState.output), 0.11);
    state.tool = damp(state.tool, Math.max(postureState.tool, pulseState.tool), 0.12);
    state.call = damp(state.call, Math.max(postureState.call, pulseState.call), 0.13);
    state.thinking = damp(state.thinking, postureState.thinking, 0.08);
    state.digestion = damp(state.digestion, postureState.digestion, 0.08);
    state.queued = damp(state.queued, postureState.queued, 0.07);
    state.listening = damp(state.listening, postureState.listening, 0.04);
    state.error = damp(state.error, postureState.error, 0.11);
    state.reset = damp(state.reset, pulseState.reset, 0.1);

    membrane.update(elapsedTime, state);
    rimLight.intensity = palette.rimLight.intensity + state.output * 6.8 + state.pressure * 2.3 + state.reset * 2.2;
    toolLight.intensity = palette.toolLight.intensity + state.tool * 8.5;
    callLight.intensity = palette.callLight.intensity + state.call * 9.2 + state.error * 4.2;
    camera.position.x = Math.sin(elapsedTime * 0.045) * 0.045;
    camera.position.y = 0.06 + Math.sin(elapsedTime * 0.07) * 0.035;
    camera.lookAt(0, -0.01, 0);
    renderer.render(scene, camera);
  });

  return {
    handleEvent(event) {
      if (disposed) return;
      if (event.type === "visualization.snapshot") {
        for (const impact of event.data?.snapshot?.impacts ?? event.snapshot?.impacts ?? []) {
          spawnImpact(livePulses, impact);
        }
        for (const packet of event.data?.snapshot?.outputPackets ?? event.snapshot?.outputPackets ?? []) {
          spawnPacket(livePulses, packet);
        }
        const snapshotState = event.data?.snapshot?.state ?? event.snapshot?.state;
        if (snapshotState) mergeServerState(state, posture, snapshotState);
        return;
      }
      if (event.type === "visualization.impact") {
        spawnImpact(livePulses, event.data?.impact ?? event.impact);
        return;
      }
      if (event.type === "visualization.output_packet") {
        spawnPacket(livePulses, event.data?.packet ?? event.packet);
        return;
      }
      if (event.type === "visualization.reset") {
        livePulses.push({ age: 0, life: 3.2, pressure: 0.09, output: 0.1, tool: 0, call: 0, reset: 1 });
        return;
      }
      if (event.type === "visualization.state") {
        mergeServerState(state, posture, event.data?.state ?? event.state);
      }
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      membrane.dispose();
      renderer.dispose();
      host.replaceChildren();
    },
  };

  function resize() {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width < 420 ? 5.95 : 5.45;
    camera.updateProjectionMatrix();
  }
}

class BuzzMembrane {
  constructor() {
    this.group = new THREE.Group();
    this.group.rotation.x = -0.08;
    this.group.position.y = -0.02;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uPressure: { value: 0 },
        uOutput: { value: 0 },
        uTool: { value: 0 },
        uCall: { value: 0 },
        uThinking: { value: 0 },
        uDigestion: { value: 0 },
        uQueued: { value: 0 },
        uError: { value: 0 },
        uReset: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        varying float vRib;
        varying float vBoundary;
        uniform float uTime;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uTool;
        uniform float uCall;
        uniform float uThinking;
        uniform float uDigestion;
        uniform float uQueued;
        uniform float uError;
        uniform float uReset;

        void main() {
          vUv = uv;
          vec3 p = position;
          vec2 q = vec2(p.x / 2.15, p.y / 1.0);
          float r = length(q);
          float angle = atan(q.y, q.x);
          float boundary = 1.0 - smoothstep(0.036, 0.19, abs(r - 0.72));
          float basin = 1.0 - smoothstep(0.23, 0.66 + uPressure * 0.05, r);
          float ribA = sin(angle * 18.0 + sin(r * 7.0 - uTime * 0.52) * 0.9 + uTime * (0.24 + uOutput * 2.3));
          float ribB = sin(angle * 31.0 - r * 7.8 + uTime * (0.18 + uCall * 5.5));
          float rib = ribA * 0.68 + ribB * 0.32;
          float breath = sin(uTime * (0.72 + uThinking * 0.4)) * (0.012 + uPressure * 0.035 + uReset * 0.035);
          float tightening = uThinking * 0.08 + uCall * 0.08 + uTool * 0.045 + uQueued * 0.03;
          float recovery = uOutput * 0.08 + uReset * 0.11;
          float shear = sin(angle * 5.0 + uTime * 0.7) * (uTool * 0.08 + uError * 0.09);
          p.z += boundary * (rib * (0.045 + uPressure * 0.11 + uCall * 0.08) + tightening - recovery + shear);
          p.z -= basin * (0.23 + uPressure * 0.17 + uThinking * 0.06 - uOutput * 0.07 - uReset * 0.08);
          p.xy *= 1.0 + boundary * (breath - tightening * 0.02 + recovery * 0.035);
          vRib = rib;
          vBoundary = boundary;
          vPos = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        varying float vRib;
        varying float vBoundary;
        uniform float uTime;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uTool;
        uniform float uCall;
        uniform float uThinking;
        uniform float uDigestion;
        uniform float uQueued;
        uniform float uError;
        uniform float uReset;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          vec2 p = (vUv - 0.5) * vec2(2.08, 1.0);
          float r = length(p);
          float angle = atan(p.y, p.x);
          float basin = 1.0 - smoothstep(0.22, 0.58 + uPressure * 0.05, r);
          float boundary = 1.0 - smoothstep(0.025, 0.14, abs(r - 0.72));
          float ribLine = smoothstep(0.42, 0.96, abs(vRib)) * boundary;
          float orbit = smoothstep(0.78, 1.0, sin(angle * 9.0 - uTime * (0.55 + uOutput * 2.7)) * 0.5 + 0.5) * boundary;
          float spike = smoothstep(0.88, 1.0, sin(angle * 19.0 + uTime * (0.42 + uCall * 4.0)) * 0.5 + 0.5) * boundary * (uCall * 0.66 + uTool * 0.42 + uError * 0.36);
          float grain = hash(floor(vUv * vec2(260.0, 150.0)) + floor(uTime * 6.0)) * 0.045;
          float latent = (sin(angle * 44.0 + r * 18.0 - uTime * 0.16) * 0.5 + 0.5) * boundary;

          vec3 base = vec3(0.014, 0.021, 0.034);
          vec3 membrane = vec3(0.082, 0.112, 0.156);
          vec3 rim = vec3(0.56, 0.74, 1.0);
          vec3 tool = vec3(0.32, 1.0, 0.68);
          vec3 call = vec3(1.0, 0.58, 0.20);
          vec3 output = vec3(0.70, 0.82, 1.0);
          vec3 error = vec3(1.0, 0.20, 0.12);
          float latentCore = (sin(angle * 12.0 + r * 7.0 + uTime * 0.08) * 0.5 + 0.5) * basin;

          vec3 color = base;
          color += membrane * (0.72 + uPressure * 0.44 + uThinking * 0.18 + grain * 1.4);
          color += vec3(0.020, 0.030, 0.045) * latentCore * 0.55;
          color += rim * (boundary * (0.22 + latent * 0.22 + uPressure * 0.58 + uReset * 0.58));
          color += rim * ribLine * (0.42 + uThinking * 0.50 + uCall * 0.32);
          color += output * (orbit * (0.14 + uOutput * 0.95));
          color += tool * (uTool * (0.16 + ribLine * 0.58));
          color += call * spike * (0.16 + uCall * 0.46);
          color += error * (uError * (0.06 + spike * 0.42));
          color = mix(color, vec3(0.0, 0.001, 0.006), basin * (0.70 - uOutput * 0.10 - uReset * 0.18));

          float edgeFade = smoothstep(1.12, 0.74, r);
          float alpha = edgeFade * (0.80 + boundary * 0.30 + ribLine * 0.18);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 2.7, 180, 100), this.material);
    this.group.add(this.mesh);

    const rimMaterial = new THREE.MeshBasicMaterial({
      color: "#6d8fff",
      transparent: true,
      opacity: 0.30,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.rim = new THREE.Mesh(new THREE.TorusGeometry(1.67, 0.006, 8, 220), rimMaterial);
    this.rim.scale.y = 0.47;
    this.rim.position.z = 0.035;
    this.group.add(this.rim);

    const basinMaterial = new THREE.MeshBasicMaterial({
      color: "#000003",
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    });
    this.basin = new THREE.Mesh(new THREE.CircleGeometry(0.72, 96), basinMaterial);
    this.basin.scale.y = 0.48;
    this.basin.position.z = 0.012;
    this.group.add(this.basin);

    this.stressLines = createStressLines();
    this.group.add(this.stressLines.lines);
  }

  update(time, state) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPressure.value = state.pressure;
    this.material.uniforms.uOutput.value = state.output;
    this.material.uniforms.uTool.value = state.tool;
    this.material.uniforms.uCall.value = state.call;
    this.material.uniforms.uThinking.value = state.thinking;
    this.material.uniforms.uDigestion.value = state.digestion;
    this.material.uniforms.uQueued.value = state.queued;
    this.material.uniforms.uError.value = state.error;
    this.material.uniforms.uReset.value = state.reset;
    this.group.rotation.z = Math.sin(time * 0.035) * 0.012 + state.tool * 0.025 - state.call * 0.018;
    this.group.scale.setScalar(1.0 + state.pressure * 0.035 - state.call * 0.018 + state.reset * 0.025);
    this.rim.material.opacity = 0.26 + state.pressure * 0.30 + state.thinking * 0.14 + state.tool * 0.14 + state.call * 0.12 + state.reset * 0.22;
    this.rim.scale.x = 1 + state.pressure * 0.035 - state.call * 0.025 + state.reset * 0.04;
    this.rim.scale.y = 0.47 + state.pressure * 0.02 + state.output * 0.025 + state.reset * 0.035;
    this.basin.material.opacity = 0.52 + state.pressure * 0.13 + state.thinking * 0.05 - state.output * 0.12 - state.reset * 0.16;
    updateStressLines(this.stressLines, time, state);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.rim.geometry.dispose();
    this.rim.material.dispose();
    this.basin.geometry.dispose();
    this.basin.material.dispose();
    this.stressLines.geometry.dispose();
    this.stressLines.material.dispose();
  }
}

function createStressLines() {
  const count = 48;
  const positions = new Float32Array(count * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: "#b9ccff",
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return {
    lines: new THREE.LineSegments(geometry, material),
    geometry,
    material,
    positions,
    count,
  };
}

function updateStressLines(stress, time, state) {
  const activity = Math.max(state.thinking * 0.45, state.tool, state.call, state.output * 0.7, state.reset * 0.8, state.error);
  for (let index = 0; index < stress.count; index += 1) {
    const lane = index / stress.count;
    const angle = lane * Math.PI * 2 + Math.sin(time * 0.07 + index) * 0.035;
    const wobble = Math.sin(time * (0.48 + state.call * 1.45) + index * 1.77) * (0.018 + activity * 0.058);
    const inner = 0.83 + wobble;
    const outer = 1.03 + state.pressure * 0.14 + activity * 0.13 + Math.sin(index * 3.1) * 0.025;
    const yScale = 0.47 + state.output * 0.04 + state.reset * 0.04;
    const base = index * 6;
    stress.positions[base] = Math.cos(angle) * inner * 1.67;
    stress.positions[base + 1] = Math.sin(angle) * inner * 1.67 * yScale;
    stress.positions[base + 2] = 0.045;
    stress.positions[base + 3] = Math.cos(angle + wobble * 0.25) * outer * 1.67;
    stress.positions[base + 4] = Math.sin(angle + wobble * 0.25) * outer * 1.67 * yScale;
    stress.positions[base + 5] = 0.06 + activity * 0.06;
  }
  stress.geometry.attributes.position.needsUpdate = true;
  stress.material.opacity = 0.15 + activity * 0.28 + state.pressure * 0.10;
  stress.lines.rotation.z = time * (0.006 + state.tool * 0.024 + state.call * 0.026);
}

function spawnImpact(livePulses, impact) {
  if (!impact) return;
  const call = impact.toolCallMass ?? 0;
  const tool = impact.toolResultMass ?? 0;
  livePulses.push({
    age: 0,
    life: 3.5 + (impact.inputMass ?? 0) * 4.8,
    pressure: 0.055 + (impact.inputMass ?? 0) * 0.72 + (impact.replayMass ?? 0) * 0.34,
    output: (impact.outputMass ?? 0) * 0.76,
    tool: tool * 1.18,
    call: call * 1.35,
    reset: impact.status === "finished" ? 0.7 : 0,
  });
}

function spawnPacket(livePulses, packet) {
  if (!packet) return;
  const mass = packet.mass ?? packet.amp ?? 0;
  livePulses.push({
    age: 0,
    life: 1.1 + mass * 2.3,
    pressure: mass * 0.08,
    output: packet.kind === "assistant_output" ? 0.10 + mass * 0.95 : 0,
    tool: packet.kind === "tool_result" ? 0.18 + mass * 1.0 : 0,
    call: packet.kind === "tool_call" ? 0.20 + mass * 1.1 : 0,
    reset: 0,
  });
}

function decayPulses(livePulses, dt) {
  for (const pulse of livePulses) pulse.age += dt;
  for (let index = livePulses.length - 1; index >= 0; index -= 1) {
    if (livePulses[index].age > pulseLife(livePulses[index])) livePulses.splice(index, 1);
  }
}

function pulseStateFrom(livePulses) {
  const next = { pressure: 0.045, output: 0, tool: 0, call: 0, reset: 0 };
  for (const pulse of livePulses) {
    const tail = easeOutCubic(clamp01(1 - pulse.age / pulseLife(pulse)));
    next.pressure += pulse.pressure * tail * 0.065;
    next.output += pulse.output * tail * 0.11;
    next.tool += pulse.tool * tail * 0.12;
    next.call += pulse.call * tail * 0.13;
    next.reset += (pulse.reset ?? 0) * tail * 0.18;
  }
  next.pressure = clamp01(next.pressure);
  next.output = clamp01(next.output);
  next.tool = clamp01(next.tool);
  next.call = clamp01(next.call);
  next.reset = clamp01(next.reset);
  return next;
}

function pulseLife(pulse) {
  return pulse.life ?? 2;
}

function mergeServerState(target, posture, serverState) {
  if (!serverState) return;
  if (typeof serverState.mode === "string") {
    posture.mode = serverState.mode;
    posture.updatedAt = performance.now() / 1000;
  }
  target.pressure = Math.max(target.pressure, (serverState.pressure ?? 0) * 0.86);
  target.output = Math.max(target.output, serverState.output ?? 0);
  target.tool = Math.max(target.tool, serverState.tool ?? 0);
  target.call = Math.max(target.call, serverState.call ?? 0);
  target.thinking = Math.max(target.thinking, serverState.thinking ?? 0);
  target.digestion = Math.max(target.digestion, serverState.digestion ?? 0);
  target.queued = Math.max(target.queued, serverState.queued ?? 0);
  target.error = Math.max(target.error, serverState.error ?? 0);
}

function postureTargets(posture, now) {
  const age = now - posture.updatedAt;
  const freshMode = age < 6 ? posture.mode : "listening";
  const targets = {
    pressure: 0.045,
    output: 0,
    tool: 0,
    call: 0,
    thinking: 0,
    digestion: 0,
    queued: 0,
    listening: 0.9,
    error: 0,
  };

  if (freshMode === "queued") {
    targets.pressure = 0.095;
    targets.queued = 0.78;
    targets.listening = 0.55;
    return targets;
  }
  if (freshMode === "thinking") {
    targets.pressure = 0.24;
    targets.thinking = 0.9;
    targets.listening = 0.22;
    return targets;
  }
  if (freshMode === "digesting") {
    targets.pressure = 0.18;
    targets.digestion = 0.86;
    targets.thinking = 0.34;
    targets.listening = 0.28;
    return targets;
  }
  if (freshMode === "tool_call") {
    targets.pressure = 0.34;
    targets.thinking = 0.64;
    targets.call = 1.0;
    targets.listening = 0.12;
    return targets;
  }
  if (freshMode === "tool_result") {
    targets.pressure = 0.21;
    targets.tool = 0.92;
    targets.thinking = 0.42;
    targets.listening = 0.18;
    return targets;
  }
  if (freshMode === "output") {
    targets.pressure = 0.14;
    targets.output = 0.86;
    targets.listening = 0.24;
    return targets;
  }
  if (freshMode === "error") {
    targets.pressure = 0.4;
    targets.error = 0.95;
    targets.call = 0.5;
    targets.listening = 0.1;
    return targets;
  }
  return targets;
}

function damp(current, target, factor) {
  return current + (target - current) * factor;
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
