import * as THREE from "../../node_modules/three/build/three.module.js";

const terminusPalette = {
  theme: "terminus",
  clear: "#020306",
  fog: "#020306",
  ambient: { color: "#718096", intensity: 0.68 },
  key: { color: "#f8fafc", intensity: 1.5 },
  outputLight: { color: "#7dd3fc", intensity: 4.5 },
  toolLight: { color: "#93c5fd", intensity: 2.9 },
  shader: {
    base: "#090d12",
    rib: "#b8c2cf",
    edge: "#f8fafc",
    call: "#f59e0b",
    output: "#7dd3fc",
    tool: "#93c5fd",
  },
  halo: { color: "#dbeafe", opacity: 0.09 },
  ring: { color: "#dbeafe", opacity: 0.2 },
};

export const terminusVisualization = {
  id: "terminus",
  name: "Terminus",
  theme: terminusPalette.theme,
  mount(host) {
    return mountTerminus(host, terminusPalette);
  },
};

function mountTerminus(host, palette) {
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
  scene.fog = new THREE.FogExp2(palette.fog, 0.036);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(-0.06, 0.04, 5.55);

  const ambient = new THREE.AmbientLight(palette.ambient.color, palette.ambient.intensity);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(palette.key.color, palette.key.intensity);
  key.position.set(4, 5, 5);
  scene.add(key);

  const outputLight = new THREE.PointLight(palette.outputLight.color, palette.outputLight.intensity, 12);
  outputLight.position.set(-2.1, 1.7, 3.6);
  scene.add(outputLight);

  const toolLight = new THREE.PointLight(palette.toolLight.color, palette.toolLight.intensity, 9);
  toolLight.position.set(2.2, -1.4, 3);
  scene.add(toolLight);

  const terminus = new TerminusSphere(palette);
  scene.add(terminus.group);

  let disposed = false;
  let previousFrameTime = performance.now() / 1000;
  let elapsedTime = 0;
  const livePulses = [];
  const state = {
    pressure: 0.14,
    output: 0,
    tool: 0,
    call: 0,
    thinking: 0,
    digestion: 0,
    queued: 0,
    listening: 1,
    error: 0,
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
    state.pressure = damp(state.pressure, Math.max(postureState.pressure, pulseState.pressure), 0.075);
    state.output = damp(state.output, Math.max(postureState.output, pulseState.output), 0.12);
    state.tool = damp(state.tool, Math.max(postureState.tool, pulseState.tool), 0.12);
    state.call = damp(state.call, Math.max(postureState.call, pulseState.call), 0.12);
    state.thinking = damp(state.thinking, postureState.thinking, 0.09);
    state.digestion = damp(state.digestion, postureState.digestion, 0.09);
    state.queued = damp(state.queued, postureState.queued, 0.09);
    state.listening = damp(state.listening, postureState.listening, 0.045);
    state.error = damp(state.error, postureState.error, 0.12);

    terminus.update(elapsedTime, state);
    outputLight.intensity = palette.outputLight.intensity + state.output * 7.5 + state.pressure * 2.1;
    toolLight.intensity = palette.toolLight.intensity + state.tool * 6.5 + state.call * 2.2;
    camera.position.x = -0.06 + Math.sin(elapsedTime * 0.055) * 0.08;
    camera.position.y = 0.04 + Math.sin(elapsedTime * 0.09) * 0.055;
    camera.lookAt(-0.03, 0, 0);
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
      if (event.type === "visualization.state") {
        mergeServerState(state, posture, event.data?.state ?? event.state);
      }
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      terminus.dispose();
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
    camera.position.z = width < 420 ? 5.95 : 5.55;
    camera.updateProjectionMatrix();
  }
}

class TerminusSphere {
  constructor(palette) {
    this.group = new THREE.Group();
    this.group.position.x = -0.03;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uPressure: { value: 0 },
        uOutput: { value: 0 },
        uTool: { value: 0 },
        uCall: { value: 0 },
        uThinking: { value: 0 },
        uDigestion: { value: 0 },
        uError: { value: 0 },
        uBaseColor: { value: new THREE.Color(palette.shader.base) },
        uRibColor: { value: new THREE.Color(palette.shader.rib) },
        uEdgeColor: { value: new THREE.Color(palette.shader.edge) },
        uCallColor: { value: new THREE.Color(palette.shader.call) },
        uOutputColor: { value: new THREE.Color(palette.shader.output) },
        uToolColor: { value: new THREE.Color(palette.shader.tool) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPos;
        varying float vRib;
        varying float vBand;
        uniform float uTime;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uTool;
        uniform float uCall;
        uniform float uThinking;
        uniform float uDigestion;
        uniform float uError;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec3 p = position;
          float lat = atan(p.y, length(p.xz));
          float lon = atan(p.z, p.x);
          float broad = sin(lat * 16.0 + sin(lon * 5.0 + uTime * 0.55) * 1.5 - uTime * (0.48 + uOutput * 3.4));
          float fine = sin(lat * 62.0 + lon * 3.5 + uTime * (0.84 + uCall * 7.2));
          float meridian = sin(lon * 8.0 + uTime * (0.36 + uTool * 3.8));
          float rib = broad * 0.58 + fine * 0.29 + meridian * 0.13;
          float band = smoothstep(0.94, 1.0, abs(sin(lat * 11.0 + uTime * 0.28)));
          float dent = -uPressure * (0.18 + 0.09 * sin(lon * 2.0 + uTime * 0.6));
          float digestionFold = uDigestion * 0.045 * sin(lat * 7.0 - uTime * 0.22);
          float offAxis = 0.035 * sin(lon * 2.0 - uTime * 0.35);
          p.x += offAxis * (0.5 + uPressure);
          p += normal * (rib * (0.05 + uOutput * 0.1 + uThinking * 0.025) + band * uTool * 0.035 + dent + digestionFold + uCall * 0.045 * sin(lon * 10.0));
          vRib = rib;
          vBand = band;
          vPos = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPos;
        varying float vRib;
        varying float vBand;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uTool;
        uniform float uCall;
        uniform float uThinking;
        uniform float uDigestion;
        uniform float uError;
        uniform vec3 uBaseColor;
        uniform vec3 uRibColor;
        uniform vec3 uEdgeColor;
        uniform vec3 uCallColor;
        uniform vec3 uOutputColor;
        uniform vec3 uToolColor;

        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.35);
          float ribLine = smoothstep(0.58, 0.94, abs(vRib));
          vec3 color = uBaseColor + uRibColor * (0.2 + ribLine * 0.64) + uEdgeColor * fresnel * 0.72;
          color += uOutputColor * uOutput * ribLine * 0.62;
          color += uToolColor * uTool * vBand * 0.5;
          color += uCallColor * uCall * (0.24 + fresnel * 0.22);
          color += uRibColor * uThinking * 0.12;
          color += uToolColor * uDigestion * (0.08 + vBand * 0.16);
          color += uCallColor * uError * 0.45;
          float alpha = 0.74 + fresnel * 0.24 - uPressure * 0.08;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1.68, 128, 80), this.material);
    this.group.add(this.mesh);

    const haloMaterial = new THREE.MeshBasicMaterial({
      color: palette.halo.color,
      transparent: true,
      opacity: palette.halo.opacity,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1.94, 96, 48), haloMaterial);
    this.group.add(this.halo);

    this.rings = [
      createInstrumentRing(palette, 1.92, 0.0, 0.0, 0.18),
      createInstrumentRing(palette, 2.03, Math.PI / 2.7, 0.16, 0.13),
      createInstrumentRing(palette, 2.14, -Math.PI / 3.4, -0.14, 0.1),
    ];
    for (const ring of this.rings) this.group.add(ring);
  }

  update(time, state) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPressure.value = state.pressure;
    this.material.uniforms.uOutput.value = state.output;
    this.material.uniforms.uTool.value = state.tool;
    this.material.uniforms.uCall.value = state.call;
    this.material.uniforms.uThinking.value = state.thinking;
    this.material.uniforms.uDigestion.value = state.digestion;
    this.material.uniforms.uError.value = state.error;
    this.group.rotation.y = time * (0.075 + state.thinking * 0.07 + state.tool * 0.08);
    this.group.rotation.x = Math.sin(time * (0.12 + state.digestion * 0.08)) * (0.052 + state.pressure * 0.03);
    this.group.rotation.z = -0.035 + Math.sin(time * 0.08) * 0.025;
    this.group.scale.setScalar(1.04 + state.pressure * 0.11 - state.output * 0.035 - state.digestion * 0.035);
    this.halo.scale.setScalar(1.02 + state.output * 0.13 + state.call * 0.16 + state.queued * 0.05);

    const ringEnergy = Math.max(state.output, state.tool, state.call);
    for (const [index, ring] of this.rings.entries()) {
      ring.rotation.z += 0.0013 + index * 0.0005 + state.tool * 0.008 + state.call * 0.01 + state.digestion * 0.001;
      ring.material.opacity = ring.userData.baseOpacity + ringEnergy * (0.11 - index * 0.02) + state.queued * 0.035 + state.thinking * 0.025;
      ring.scale.setScalar(1 + state.pressure * 0.04 + state.tool * 0.035);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    for (const ring of this.rings) {
      ring.geometry.dispose();
      ring.material.dispose();
    }
  }
}

function createInstrumentRing(palette, radius, rotationX, rotationY, opacity) {
  const material = new THREE.MeshBasicMaterial({
    color: palette.ring.color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.006, 8, 180), material);
  ring.rotation.x = rotationX;
  ring.rotation.y = rotationY;
  ring.userData.baseOpacity = opacity;
  return ring;
}

function spawnImpact(livePulses, impact) {
  if (!impact) return;
  livePulses.push({
    age: 0,
    life: 4.2 + (impact.inputMass ?? 0) * 5.8,
    pressure: 0.14 + (impact.inputMass ?? 0) * 0.8 + (impact.replayMass ?? 0) * 0.44,
    output: impact.outputMass ?? 0,
    tool: impact.toolResultMass ?? 0,
    call: impact.toolCallMass ?? 0,
  });
}

function spawnPacket(livePulses, packet) {
  if (!packet) return;
  const mass = packet.mass ?? packet.amp ?? 0;
  livePulses.push({
    age: 0,
    life: 1.35 + mass * 2.6,
    pressure: mass * 0.16,
    output: packet.kind === "assistant_output" ? 0.16 + mass * 0.9 : 0,
    tool: packet.kind === "tool_result" ? 0.22 + mass * 0.84 : 0,
    call: packet.kind === "tool_call" ? 0.18 + mass * 0.78 : 0,
  });
}

function decayPulses(livePulses, dt) {
  for (const pulse of livePulses) pulse.age += dt;
  for (let index = livePulses.length - 1; index >= 0; index -= 1) {
    if (livePulses[index].age > livePulses[index].life) livePulses.splice(index, 1);
  }
}

function pulseStateFrom(livePulses) {
  const next = { pressure: 0.1, output: 0, tool: 0, call: 0 };
  for (const pulse of livePulses) {
    const tail = easeOutCubic(clamp01(1 - pulse.age / pulse.life));
    next.pressure += pulse.pressure * tail * 0.08;
    next.output += pulse.output * tail * 0.1;
    next.tool += pulse.tool * tail * 0.1;
    next.call += pulse.call * tail * 0.1;
  }
  next.pressure = clamp01(next.pressure);
  next.output = clamp01(next.output);
  next.tool = clamp01(next.tool);
  next.call = clamp01(next.call);
  return next;
}

function mergeServerState(target, posture, serverState) {
  if (!serverState) return;
  if (typeof serverState.mode === "string") {
    posture.mode = serverState.mode;
    posture.updatedAt = performance.now() / 1000;
  }
  target.pressure = Math.max(target.pressure, serverState.pressure ?? 0);
  target.output = Math.max(target.output, serverState.output ?? 0);
  target.tool = Math.max(target.tool, serverState.tool ?? 0);
  target.call = Math.max(target.call, serverState.call ?? 0);
  target.thinking = Math.max(target.thinking, serverState.thinking ?? 0);
  target.digestion = Math.max(target.digestion, serverState.digestion ?? 0);
  target.queued = Math.max(target.queued, serverState.queued ?? 0);
}

function postureTargets(posture, now) {
  const age = now - posture.updatedAt;
  const freshMode = age < 6 ? posture.mode : "listening";
  const targets = {
    pressure: 0.1,
    output: 0,
    tool: 0,
    call: 0,
    thinking: 0,
    digestion: 0,
    queued: 0,
    listening: 0.8,
    error: 0,
  };

  if (freshMode === "queued") {
    targets.pressure = 0.16;
    targets.queued = 0.85;
    targets.listening = 0.55;
    return targets;
  }
  if (freshMode === "thinking") {
    targets.pressure = 0.28;
    targets.thinking = 0.9;
    targets.listening = 0.25;
    return targets;
  }
  if (freshMode === "digesting") {
    targets.pressure = 0.22;
    targets.digestion = 0.88;
    targets.thinking = 0.35;
    targets.listening = 0.28;
    return targets;
  }
  if (freshMode === "tool_call") {
    targets.pressure = 0.34;
    targets.thinking = 0.65;
    targets.call = 0.9;
    targets.listening = 0.15;
    return targets;
  }
  if (freshMode === "tool_result") {
    targets.pressure = 0.24;
    targets.tool = 0.82;
    targets.thinking = 0.45;
    targets.listening = 0.2;
    return targets;
  }
  if (freshMode === "output") {
    targets.pressure = 0.18;
    targets.output = 0.8;
    targets.listening = 0.22;
    return targets;
  }
  if (freshMode === "error") {
    targets.pressure = 0.4;
    targets.error = 0.9;
    targets.call = 0.45;
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
