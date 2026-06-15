import * as THREE from "../../node_modules/three/build/three.module.js";

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
  core: { color: "#010007", edge: "#8a59ff", glow: "#51f0a0" },
  tendril: { primary: "#51f0a0", secondary: "#8a59ff", tertiary: "#1f73eb" },
};

export const asterVisualization = {
  id: "aster",
  name: "Aster",
  theme: purplePalette.theme,
  mount(host) {
    return mountAster(host, purplePalette);
  },
};

function mountAster(host, palette) {
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

  const sphere = new AsterSphere(palette);
  scene.add(sphere.group);

  const tendrils = new AsterTendrils(palette);
  scene.add(tendrils.group);

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

    const heartbeat = heartbeatAt(elapsedTime);
    sphere.update(elapsedTime, state, heartbeat);
    tendrils.update(dt, elapsedTime);
    outputLight.intensity = palette.outputLight.intensity + state.output * 8 + heartbeat * 1.6;
    toolLight.intensity = palette.toolLight.intensity + state.tool * 7 + heartbeat * 0.8;
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
          spawnNovelty(tendrils, impact);
        }
        for (const packet of event.data?.snapshot?.outputPackets ?? event.snapshot?.outputPackets ?? []) {
          spawnPacket(livePulses, packet);
        }
        const snapshotState = event.data?.snapshot?.state ?? event.snapshot?.state;
        if (snapshotState) mergeServerState(state, snapshotState);
        return;
      }
      if (event.type === "visualization.impact") {
        const impact = event.data?.impact ?? event.impact;
        spawnImpact(livePulses, impact);
        spawnNovelty(tendrils, impact);
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
      tendrils.dispose();
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
    camera.position.z = camera.aspect < 0.8 ? 8.2 : width < 420 ? 5.9 : 5.4;
    camera.updateProjectionMatrix();
  }
}

class AsterSphere {
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
        uHeartbeat: { value: 0 },
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
        uniform float uHeartbeat;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec3 p = position;
          float lat = atan(p.y, length(p.xz));
          float lon = atan(p.z, p.x);
          float broad = sin(lat * 18.0 + sin(lon * 6.0 + uTime * 0.55) * 1.2 - uTime * (0.35 + uOutput * 2.1));
          float fine = sin(lat * 58.0 + lon * 4.0 + uTime * (0.8 + uCall * 6.0));
          float rib = broad * 0.72 + fine * 0.28;
          float corePull = -uPressure * 0.1 - uHeartbeat * 0.035;
          p += normal * (rib * (0.045 + uOutput * 0.08) + corePull + uCall * 0.05 * sin(lon * 11.0));
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
        uniform float uHeartbeat;
        uniform vec3 uBaseColor;
        uniform vec3 uRibColor;
        uniform vec3 uEdgeColor;
        uniform vec3 uCallColor;
        uniform vec3 uOutputColor;

        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.2);
          float ribLine = smoothstep(0.62, 0.95, abs(vRib));
          float voidShadow = smoothstep(1.26, 0.16, length(vPos.xy));
          vec3 color = uBaseColor + uRibColor * (0.2 + ribLine * 0.7) + uEdgeColor * fresnel * 0.72 + uCallColor * uCall * 0.4;
          color += uOutputColor * uOutput * ribLine * 0.7;
          color *= 1.0 - voidShadow * (0.36 + uHeartbeat * 0.22);
          color += uOutputColor * uHeartbeat * voidShadow * 0.16;
          float alpha = 0.7 + fresnel * 0.28 - uPressure * 0.08 - voidShadow * 0.18;
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

    this.coreMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uHeartbeat: { value: 0 },
        uCoreColor: { value: new THREE.Color(palette.core.color) },
        uEdgeColor: { value: new THREE.Color(palette.core.edge) },
        uGlowColor: { value: new THREE.Color(palette.core.glow) },
      },
      vertexShader: `
        varying vec3 vNormal;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        uniform float uHeartbeat;
        uniform vec3 uCoreColor;
        uniform vec3 uEdgeColor;
        uniform vec3 uGlowColor;

        void main() {
          float facing = abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)));
          float rim = pow(1.0 - facing, 2.8);
          vec3 color = uCoreColor * 0.85 + uEdgeColor * rim * (0.45 + uHeartbeat * 0.7) + uGlowColor * uHeartbeat * 0.08;
          float alpha = 0.78 + rim * 0.18 + uHeartbeat * 0.12;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.76, 80, 40), this.coreMaterial);
    this.mesh.renderOrder = 1;
    this.core.renderOrder = 2;
    this.group.add(this.core);
  }

  update(time, state, heartbeat) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPressure.value = state.pressure;
    this.material.uniforms.uOutput.value = state.output;
    this.material.uniforms.uCall.value = state.call;
    this.material.uniforms.uHeartbeat.value = heartbeat;
    this.coreMaterial.uniforms.uHeartbeat.value = heartbeat;
    this.group.rotation.y = time * 0.13;
    this.group.rotation.x = Math.sin(time * 0.19) * 0.08;
    this.group.scale.setScalar(1 + state.pressure * 0.06 - state.output * 0.03);
    this.core.scale.setScalar(1 + heartbeat * 0.18 + state.pressure * 0.05);
    this.halo.scale.setScalar(1.02 + state.output * 0.1 + state.call * 0.16 + heartbeat * 0.04);
    this.halo.material.opacity = 0.1 + state.output * 0.04 + heartbeat * 0.035;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    this.core.geometry.dispose();
    this.coreMaterial.dispose();
  }
}

class AsterTendrils {
  constructor(palette) {
    this.group = new THREE.Group();
    this.tendrils = [];
    this.colors = [
      new THREE.Color(palette.tendril.primary),
      new THREE.Color(palette.tendril.secondary),
      new THREE.Color(palette.tendril.tertiary),
    ];
  }

  spawn(amount, novelty) {
    const count = Math.max(2, Math.min(18, Math.ceil(amount * 16)));
    for (let index = 0; index < count; index += 1) {
      const color = this.colors[(this.tendrils.length + index) % this.colors.length];
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const geometry = new THREE.BufferGeometry();
      const points = new Float32Array(11 * 3);
      geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
      const line = new THREE.Line(geometry, material);
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.2 + Math.random() * 1.25;
      const lean = (Math.random() - 0.5) * 0.52;
      const life = 2.4 + Math.random() * 1.6 + novelty * 1.4;
      const height = 1.35 + novelty * 1.45 + Math.random() * 0.8;
      this.group.add(line);
      this.tendrils.push({
        age: 0,
        life,
        line,
        angle,
        radius,
        lean,
        height,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  update(dt, time) {
    for (const tendril of this.tendrils) {
      tendril.age += dt;
      const p = clamp01(tendril.age / tendril.life);
      const rise = easeOutCubic(p);
      const fadeIn = smoothstep(0, 0.16, p);
      const fadeOut = 1 - smoothstep(0.58, 1, p);
      const alpha = fadeIn * fadeOut;
      tendril.line.material.opacity = alpha * 0.72;
      updateTendrilGeometry(tendril, rise, time);
    }

    for (let index = this.tendrils.length - 1; index >= 0; index -= 1) {
      const tendril = this.tendrils[index];
      if (tendril.age <= tendril.life) continue;
      this.group.remove(tendril.line);
      tendril.line.geometry.dispose();
      tendril.line.material.dispose();
      this.tendrils.splice(index, 1);
    }
  }

  dispose() {
    for (const tendril of this.tendrils) {
      this.group.remove(tendril.line);
      tendril.line.geometry.dispose();
      tendril.line.material.dispose();
    }
    this.tendrils.splice(0);
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

function spawnNovelty(tendrils, impact) {
  if (!impact) return;
  const freshInput = Math.max(impact.inputMass ?? 0, impact.userMass ?? 0);
  const novelty = clamp01((impact.newShare ?? 0.5) * 0.7 + freshInput * 0.45);
  if (freshInput <= 0.01 && novelty <= 0.18) return;
  tendrils.spawn(0.25 + freshInput * 0.75 + novelty * 0.55, novelty);
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

function heartbeatAt(time) {
  const beat = time % 1;
  const systole = Math.exp(-Math.pow((beat - 0.08) / 0.055, 2));
  const echo = Math.exp(-Math.pow((beat - 0.23) / 0.085, 2)) * 0.36;
  return clamp01(systole + echo);
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function updateTendrilGeometry(tendril, rise, time) {
  const position = tendril.line.geometry.attributes.position;
  const baseY = -1.72;
  const visibleHeight = tendril.height * rise;
  const baseX = Math.cos(tendril.angle) * tendril.radius;
  const baseZ = Math.sin(tendril.angle) * tendril.radius * 0.46;

  for (let index = 0; index < position.count; index += 1) {
    const t = index / (position.count - 1);
    const sway = Math.sin(time * 2.2 + tendril.phase + t * 4.4) * 0.055 * t;
    const curl = Math.sin(t * Math.PI) * tendril.lean * rise;
    position.setXYZ(
      index,
      baseX + Math.cos(tendril.angle + Math.PI * 0.5) * curl + sway,
      baseY + visibleHeight * t,
      baseZ + Math.sin(tendril.angle + Math.PI * 0.5) * curl + sway * 0.6,
    );
  }
  position.needsUpdate = true;
  tendril.line.geometry.computeBoundingSphere();
}
