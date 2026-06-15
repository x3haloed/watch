import * as THREE from "../../node_modules/three/build/three.module.js";

const darkPalette = {
  theme: "dark",
  clear: "#020205",
  fog: "#020205",
  ambient: { color: "#6b7280", intensity: 0.72 },
  key: { color: "#f8fafc", intensity: 1.65 },
  outputLight: { color: "#d1d5db", intensity: 4.4 },
  toolLight: { color: "#94a3b8", intensity: 2.6 },
  shader: {
    base: "#101216",
    rib: "#cbd5e1",
    edge: "#f8fafc",
    call: "#e5e7eb",
    output: "#94a3b8",
  },
  halo: { color: "#e5e7eb", opacity: 0.11 },
};

const lightPalette = {
  theme: "light",
  clear: "#f8fafc",
  fog: "#f8fafc",
  ambient: { color: "#94a3b8", intensity: 0.72 },
  key: { color: "#ffffff", intensity: 2.15 },
  outputLight: { color: "#64748b", intensity: 4.2 },
  toolLight: { color: "#111827", intensity: 2.6 },
  shader: {
    base: "#111827",
    rib: "#8b95a1",
    edge: "#e5e7eb",
    call: "#1f2937",
    output: "#aeb8c4",
  },
  halo: { color: "#64748b", opacity: 0.16 },
};

const purplePalette = {
  theme: "purple",
  clear: "#020205",
  fog: "#020205",
  ambient: { color: "#465f80", intensity: 0.55 },
  key: { color: "#c2d8ff", intensity: 1.2 },
  outputLight: { color: "#8a59ff", intensity: 5.2 },
  toolLight: { color: "#51f0a0", intensity: 2.1 },
  shader: {
    base: "#05040a",
    rib: "#6b33fa",
    edge: "#1f73eb",
    call: "#ff731f",
    output: "#b3a0ff",
  },
  halo: { color: "#4123a6", opacity: 0.12 },
};

export const darkRibbedSphereVisualization = {
  id: "ribbed-sphere-dark",
  name: "Dark sphere",
  theme: darkPalette.theme,
  mount(host) {
    return mountRibbedSphere(host, darkPalette);
  },
};

export const lightRibbedSphereVisualization = {
  id: "ribbed-sphere-light",
  name: "Light sphere",
  theme: lightPalette.theme,
  mount(host) {
    return mountRibbedSphere(host, lightPalette);
  },
};

export const purpleRibbedSphereVisualization = {
  id: "ribbed-sphere-purple",
  name: "Purple sphere",
  theme: purplePalette.theme,
  mount(host) {
    return mountRibbedSphere(host, purplePalette);
  },
};

function mountRibbedSphere(host, palette) {
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
  scene.fog = new THREE.FogExp2(palette.fog, 0.035);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.set(0, 0.05, 5.6);

  const ambient = new THREE.AmbientLight(palette.ambient.color, palette.ambient.intensity);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(palette.key.color, palette.key.intensity);
  key.position.set(4, 5, 5);
  scene.add(key);

  const outputLight = new THREE.PointLight(palette.outputLight.color, palette.outputLight.intensity, 12);
  outputLight.position.set(-2.2, 1.6, 3.6);
  scene.add(outputLight);

  const toolLight = new THREE.PointLight(palette.toolLight.color, palette.toolLight.intensity, 9);
  toolLight.position.set(2.2, -1.4, 3);
  scene.add(toolLight);

  const sphere = new RibbedSphere(palette);
  scene.add(sphere.group);

  let disposed = false;
  let previousFrameTime = performance.now() / 1000;
  let elapsedTime = 0;
  const livePulses = [];
  const state = {
    pressure: 0.16,
    output: 0,
    tool: 0,
    call: 0,
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
    state.pressure = damp(state.pressure, Math.max(0.12, pulseState.pressure), 0.08);
    state.output = damp(state.output, pulseState.output, 0.12);
    state.tool = damp(state.tool, pulseState.tool, 0.12);
    state.call = damp(state.call, pulseState.call, 0.12);

    sphere.update(elapsedTime, state);
    outputLight.intensity = palette.outputLight.intensity + state.output * 8 + state.pressure * 2.4;
    toolLight.intensity = palette.toolLight.intensity + state.tool * 7;
    camera.position.x = Math.sin(elapsedTime * 0.07) * 0.12;
    camera.position.y = 0.05 + Math.sin(elapsedTime * 0.11) * 0.07;
    camera.lookAt(0, 0, 0);
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
        if (snapshotState) mergeServerState(state, snapshotState);
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
        mergeServerState(state, event.data?.state ?? event.state);
      }
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      sphere.dispose();
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
    camera.position.z = width < 420 ? 5.9 : 5.4;
    camera.updateProjectionMatrix();
  }
}

class RibbedSphere {
  constructor(palette) {
    this.group = new THREE.Group();
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uPressure: { value: 0 },
        uOutput: { value: 0 },
        uCall: { value: 0 },
        uBaseColor: { value: new THREE.Color(palette.shader.base) },
        uRibColor: { value: new THREE.Color(palette.shader.rib) },
        uEdgeColor: { value: new THREE.Color(palette.shader.edge) },
        uCallColor: { value: new THREE.Color(palette.shader.call) },
        uOutputColor: { value: new THREE.Color(palette.shader.output) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPos;
        varying float vRib;
        uniform float uTime;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uCall;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec3 p = position;
          float lat = atan(p.y, length(p.xz));
          float lon = atan(p.z, p.x);
          float broad = sin(lat * 18.0 + sin(lon * 6.0 + uTime * 0.8) * 1.8 - uTime * (0.7 + uOutput * 4.0));
          float fine = sin(lat * 58.0 + lon * 4.0 + uTime * (1.1 + uCall * 8.0));
          float rib = broad * 0.72 + fine * 0.28;
          float dent = -uPressure * (0.23 + 0.1 * sin(lon * 3.0 + uTime));
          p += normal * (rib * (0.055 + uOutput * 0.12) + dent + uCall * 0.06 * sin(lon * 11.0));
          vRib = rib;
          vPos = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPos;
        varying float vRib;
        uniform float uTime;
        uniform float uPressure;
        uniform float uOutput;
        uniform float uCall;
        uniform vec3 uBaseColor;
        uniform vec3 uRibColor;
        uniform vec3 uEdgeColor;
        uniform vec3 uCallColor;
        uniform vec3 uOutputColor;

        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.2);
          float ribLine = smoothstep(0.62, 0.95, abs(vRib));
          vec3 color = uBaseColor + uRibColor * (0.24 + ribLine * 0.75) + uEdgeColor * fresnel * 0.75 + uCallColor * uCall * 0.4;
          color += uOutputColor * uOutput * ribLine * 0.7;
          float alpha = 0.72 + fresnel * 0.28 - uPressure * 0.1;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1.7, 128, 80), this.material);
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
  }

  update(time, state) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPressure.value = state.pressure;
    this.material.uniforms.uOutput.value = state.output;
    this.material.uniforms.uCall.value = state.call;
    this.group.rotation.y = time * 0.13;
    this.group.rotation.x = Math.sin(time * 0.19) * 0.08;
    this.group.scale.setScalar(1 + state.pressure * 0.14 - state.output * 0.04);
    this.halo.scale.setScalar(1.02 + state.output * 0.14 + state.call * 0.2);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
  }
}

function spawnImpact(livePulses, impact) {
  if (!impact) return;
  livePulses.push({
    age: 0,
    life: 4.2 + (impact.inputMass ?? 0) * 5.8,
    pressure: 0.16 + (impact.inputMass ?? 0) * 0.86 + (impact.replayMass ?? 0) * 0.46,
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
    life: 1.4 + mass * 2.8,
    pressure: mass * 0.18,
    output: packet.kind === "assistant_output" ? 0.18 + mass * 0.92 : 0,
    tool: packet.kind === "tool_result" ? 0.24 + mass * 0.86 : 0,
    call: packet.kind === "tool_call" ? 0.2 + mass * 0.82 : 0,
  });
}

function decayPulses(livePulses, dt) {
  for (const pulse of livePulses) pulse.age += dt;
  for (let index = livePulses.length - 1; index >= 0; index -= 1) {
    if (livePulses[index].age > livePulses[index].life) livePulses.splice(index, 1);
  }
}

function pulseStateFrom(livePulses) {
  const next = { pressure: 0.12, output: 0, tool: 0, call: 0 };
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

function mergeServerState(target, serverState) {
  if (!serverState) return;
  target.pressure = Math.max(target.pressure, serverState.pressure ?? 0);
  target.output = Math.max(target.output, serverState.output ?? 0);
  target.tool = Math.max(target.tool, serverState.tool ?? 0);
  target.call = Math.max(target.call, serverState.call ?? 0);
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
