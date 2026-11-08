// Interaction/physics adapted from paper-crumple-demo (MIT); see THIRD_PARTY_NOTICES.md.
import * as T from "three";
import * as C from "cannon-es";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { deskKey, diffDeskItems, type DeskItem, type PileItem } from "../desk-items";
import { getDict, type Locale } from "../../../lib/i18n";
import { loadVAT, makeGeometry, setFrame } from "./vat";
import { drawFace } from "./card-face";
import { pileYaw, scatterPosition, fitOpenBand, type OpenBand } from "./layout";
import { isEverythingAtRest } from "./rest";
import { settleBody } from "./settling";
export interface DeskScene {
  sync(items: DeskItem[], pile: PileItem[]): void;
  open(key: string): void;
  setOpenBand(band: OpenBand): void;
  file(key: string): void;
  trash(key: string): void;
  putBack(): void;
  focus(key: string | null): void;
  dispose(): void;
}
type Pose = {
  position: T.Vector3;
  quaternion: T.Quaternion;
  scale: number;
  frame: number;
};
type Paper = {
  item: DeskItem;
  mesh: T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>;
  body: C.Body;
  frame: number;
  state: "rest" | "open" | "moving" | "grab" | "gone";
  animation?: {
    from: Pose;
    to: Pose;
    elapsed: number;
    end: "rest" | "open" | "gone";
  };
  settled: number;
  dropDelay: number;
};
export async function createDeskScene(
  host: HTMLElement,
  locale: Locale,
  onOpen: (key: string) => void,
  onLibrary: () => void = () => {}
): Promise<DeskScene> {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
  let vat: Awaited<ReturnType<typeof loadVAT>>;
  try {
    vat = await loadVAT();
  } catch (e) {
    renderer.dispose();
    throw e;
  }
  // Frame 4 has relief: fit its real bounds, not just the nominal flat rectangle.
  const openGeometry = makeGeometry(vat);
  setFrame(openGeometry, vat, 4);
  openGeometry.computeBoundingBox();
  const openSize = openGeometry.boundingBox!.getSize(new T.Vector3());
  const openCenter = openGeometry.boundingBox!.getCenter(new T.Vector3());
  openGeometry.dispose();
  const canvas = renderer.domElement;
  canvas.tabIndex = -1;
  host.append(canvas);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const scene = new T.Scene();
  scene.background = new T.Color("#f3b44a");
  const camera = new T.PerspectiveCamera(40, 1, 0.01, 30);
  const world = new C.World({ gravity: new C.Vec3(0, -7, 0), allowSleep: true });
  const paperMaterial = new C.Material(),
    groundMaterial = new C.Material();
  world.addContactMaterial(
    new C.ContactMaterial(paperMaterial, paperMaterial, { friction: 0.35, restitution: 0.3 })
  );
  world.addContactMaterial(
    new C.ContactMaterial(paperMaterial, groundMaterial, { friction: 0.5, restitution: 0.12 })
  );
  const ambient = new T.AmbientLight("#fff8ec", 1.25);
  scene.add(ambient);
  const light = new T.DirectionalLight("#ffffff", 1.15);
  light.position.set(-2, 2.6, 1.4);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.bias = -0.001;
  light.shadow.camera.left = -4;
  light.shadow.camera.right = 4;
  light.shadow.camera.top = 4;
  light.shadow.camera.bottom = -4;
  scene.add(light);
  function surface(w: number, h: number, color: string, emissive: number) {
    const m = new T.Mesh(
      new T.PlaneGeometry(w, h),
      new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: emissive, side: T.DoubleSide })
    );
    m.receiveShadow = true;
    scene.add(m);
    return m;
  }
  const floor = surface(20, 20, "#ece6d6", 0.18);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.1;
  const wall = surface(20, 10, "#f3b44a", 0.55);
  wall.position.set(0, 4.9, -1.1);
  const ground = new C.Body({ mass: 0, material: groundMaterial, shape: new C.Plane() });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.position.y = -0.1;
  world.addBody(ground);
  const pileBody = new C.Body({
    mass: 0,
    material: groundMaterial,
    shape: new C.Box(new C.Vec3(0.3, 0.05, 0.4))
  });
  world.addBody(pileBody);
  let mobile = false,
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    disposed = false,
    looping = false,
    stopQueued = false,
    lastTime = 0,
    active: Paper | undefined;
  let composer: EffectComposer | undefined, ssao: SSAOPass | undefined;
  const output = new OutputPass(),
    renderPass = new RenderPass(scene, camera);
  const papers = new Map<string, Paper>(),
    pileMeshes: T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>[] = [];
  let previous: DeskItem[] = [];
  let latestPile: PileItem[] = [];
  let lastSync = "";
  let openBand: OpenBand = { top: 0, bottom: host.clientHeight };
  const deskHome = host.closest<HTMLElement>(".desk-home");
  const focusRing = new T.Mesh(
    new T.TorusGeometry(vat.crumple.radius * 0.95, 0.008, 8, 48),
    new T.MeshBasicMaterial({ color: "#f3b44a", depthTest: false })
  );
  focusRing.visible = false;
  focusRing.renderOrder = 10;
  scene.add(focusRing);
  let focused: string | null = null;
  const radius = vat.crumple.radius * 0.82,
    maxFrame = vat.frameCount - 1;
  const pilePosition = new T.Vector3();
  const pose = (p: Paper): Pose => ({
    position: p.mesh.position.clone(),
    quaternion: p.mesh.quaternion.clone(),
    scale: p.mesh.scale.x,
    frame: p.frame
  });
  function paint(p: Paper, expanded = false) {
    p.mesh.material.map?.dispose();
    const map = drawFace(
      p.item,
      locale,
      expanded ? (mobile ? 760 : 1024) : 512,
      mobile,
      Math.min(
        fitOpenBand(openBand, host.clientWidth, host.clientHeight, vat.flat.width / vat.flat.depth).width,
        host.clientWidth * 0.9
      )
    );
    p.mesh.material.map = map;
    p.mesh.material.emissiveMap = map;
    p.mesh.material.needsUpdate = true;
  }
  function openPose(): Pose {
    const direction = camera.getWorldDirection(new T.Vector3()),
      up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
      normal = direction.clone().negate(),
      right = new T.Vector3().crossVectors(normal, up);
    const height = 2 * Math.tan(T.MathUtils.degToRad(20)) * 1.5;
    const band = fitOpenBand(openBand, host.clientWidth, host.clientHeight, openSize.x / openSize.z);
    const pixelsToWorld = height / Math.max(1, host.clientHeight);
    const offset = (host.clientHeight / 2 - band.top - band.height / 2) * pixelsToWorld;
    const targetHeight = band.height * pixelsToWorld, targetWidth = band.width * pixelsToWorld;
    const relief = openSize.y / 2, distance = 1.5;
    // Nearer creases magnify both the sheet and its off-axis center. Reserve that
    // perspective expansion so every bounding-box corner stays within the band.
    const scale = Math.min(
      targetHeight * distance / (openSize.z * distance + (targetHeight + 2 * Math.abs(offset)) * relief),
      targetWidth * distance / (openSize.x * distance + targetWidth * relief)
    );
    const quaternion = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(right, normal, up));
    return {
      position: camera.position.clone().addScaledVector(direction, distance).addScaledVector(up, offset)
        .sub(openCenter.clone().multiplyScalar(scale).applyQuaternion(quaternion)),
      quaternion,
      scale,
      frame: 4
    };
  }

  function apply(p: Paper, target: Pose) {
    p.mesh.position.copy(target.position);
    p.mesh.quaternion.copy(target.quaternion);
    p.mesh.scale.setScalar(target.scale);
    if (p.frame !== target.frame) {
      p.frame = target.frame;
      setFrame(p.mesh.geometry, vat, p.frame);
    }
  }
  function finish(p: Paper, end: "rest" | "open" | "gone") {
    p.animation = undefined;
    p.state = end;
    p.mesh.castShadow = end === "rest";
    if (end === "rest") {
      p.body.position.copy(new C.Vec3(...p.mesh.position.toArray()));
      p.body.quaternion.set(...p.mesh.quaternion.toArray());
      p.body.type = C.Body.DYNAMIC;
      p.body.mass = 0.16;
      p.body.updateMassProperties();
      p.body.collisionResponse = true;
      p.body.wakeUp();
      paint(p);
    }
    if (end === "gone") p.mesh.visible = false;
  }
  function animate(p: Paper, to: Pose, end: "rest" | "open" | "gone") {
    if (p.dropDelay > 0) { p.dropDelay = 0; world.addBody(p.body); }
    p.body.type = C.Body.KINEMATIC;
    p.body.collisionResponse = false;
    p.body.velocity.setZero();
    p.body.angularVelocity.setZero();
    p.mesh.visible = true;
    p.mesh.castShadow = false;
    p.animation = { from: pose(p), to, elapsed: 0, end };
    p.state = "moving";
    if (reduced) {
      apply(p, to);
      finish(p, end);
      canvas.animate?.([{ opacity: 0.65 }, { opacity: 1 }], { duration: 150 });
    }
    wake();
  }
  function putBack() {
    if (!active) return;
    const p = active;
    active = undefined;
    animate(
      p,
      {
        position: new T.Vector3(p.body.position.x, radius + 0.1, p.body.position.z),
        quaternion: new T.Quaternion(),
        scale: 0.82,
        frame: maxFrame
      },
      "rest"
    );
  }
  function open(key: string) {
    const p = papers.get(key);
    if (!p) return;
    if (active !== p) putBack();
    active = p;
    paint(p, true);
    animate(p, openPose(), "open");
  }
  function exit(key: string, file: boolean) {
    const p = papers.get(key);
    if (!p) return;
    if (active === p) active = undefined;
    animate(
      p,
      {
        position: file
          ? pilePosition.clone().add(new T.Vector3(0, 0.08, 0))
          : new T.Vector3(p.mesh.position.x, 2, -3),
        quaternion: new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), file ? pileYaw(0) : 0),
        scale: file ? (mobile ? 0.48 : 0.5) : 0.82,
        frame: file ? 0 : maxFrame
      },
      "gone"
    );
  }
  function spawn(item: DeskItem, index: number) {
    const geometry = makeGeometry(vat);
    setFrame(geometry, vat, maxFrame);
    const material = new T.MeshStandardMaterial({
      roughness: 0.9,
      side: T.DoubleSide,
      emissive: "white",
      emissiveIntensity: 0.2
    });
    const mesh = new T.Mesh(geometry, material);
    mesh.scale.setScalar(0.82);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const { x, z } = scatterPosition(mobile, radius,
      [...papers.values()].filter(p => p.state !== "gone").map(p => p.body.position), pilePosition);
    mesh.rotation.set(0, Math.PI + (Math.random() - .5) * .5, (Math.random() - .5) * .36);
    const body = new C.Body({
      mass: 0.16,
      material: paperMaterial,
      shape: new C.Sphere(radius),
      position: new C.Vec3(x, reduced ? radius - 0.1 : 3.5 + Math.random() * 3, z),
      linearDamping: 0.04,
      angularDamping: 0.08,
      allowSleep: true,
      sleepSpeedLimit: 0.018,
      sleepTimeLimit: 0.35
    });
    body.quaternion.set(...mesh.quaternion.toArray());
    mesh.position.set(x, body.position.y, z);
    const dropDelay = reduced ? 0 : index * .07;
    mesh.visible = dropDelay <= 0;
    if (dropDelay <= 0) world.addBody(body);
    const p: Paper = { item, mesh, body, frame: maxFrame, state: "rest", settled: 0, dropDelay };
    paint(p);
    papers.set(deskKey(item), p);
    return p;
  }
  function destroyPaper(p: Paper) {
    world.removeBody(p.body);
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.map?.dispose();
    p.mesh.material.dispose();
  }
  function sync(items: DeskItem[], pile: PileItem[]) {
    const signature = JSON.stringify([items, pile]);
    if (signature === lastSync) return;
    lastSync = signature;
    latestPile = pile;
    let spawnOrder = 0;
    for (const change of diffDeskItems(previous, items, pile)) {
      if (change.kind === "spawn") spawn(change.item, spawnOrder++);
      else if (change.kind === "file" || change.kind === "trash") exit(change.key, change.kind === "file");
      else if ("item" in change) {
        const p = papers.get(change.key);
        if (!p) {
          spawn(change.item, spawnOrder++);
          continue;
        }
        papers.delete(change.key);
        papers.set(deskKey(change.item), p);
        const changed = JSON.stringify(p.item) !== JSON.stringify(change.item);
        p.item = change.item;
        if (p.state === "gone" && changed) {
          p.mesh.visible = true;
          finish(p, "rest");
        }
        if (changed) paint(p, p === active);
        if (change.kind === "promote" && change.item.kind === "pending" && !reduced && p !== active) {
          p.body.wakeUp();
          p.body.velocity.y = 1.2;
        }
      }
    }
    previous = items;
    for (const mesh of pileMeshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    pileMeshes.length = 0;
    pile
      .slice()
      .reverse()
      .forEach((item, i) => {
        const geo = makeGeometry(vat);
        setFrame(geo, vat, 0);
        const map = drawFace(item, locale, 512, mobile),
          mesh = new T.Mesh(
            geo,
            new T.MeshStandardMaterial({
              map,
              emissiveMap: map,
              emissive: "white",
              emissiveIntensity: 0.2,
              roughness: 0.9,
              side: T.DoubleSide
            })
          );
        mesh.position.copy(pilePosition).add(new T.Vector3(0, i * 0.006, 0));
        mesh.scale.setScalar(mobile ? 0.48 : 0.5);
        mesh.rotation.y = pileYaw(i);
        mesh.receiveShadow = true;
        scene.add(mesh);
        pileMeshes.push(mesh);
      });
    wake();
  }
  function setOpenBand(band: OpenBand) {
    if (band.top === openBand.top && band.bottom === openBand.bottom) return;
    openBand = band;
    if (active) {
      const target = openPose();
      if (active.animation) active.animation.to = target;
      else apply(active, target);
      paint(active, true);
      wake();
    }
  }
  function resize() {
    mobile = host.clientWidth < 700;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
    camera.position.set(0, mobile ? 4.6 : 2.25, mobile ? 4.3 : 3.7);
    camera.lookAt(0, mobile ? -0.05 : 0.3, 0);
    camera.updateProjectionMatrix();
    pilePosition.set(mobile ? 0.42 : 1.3, -0.07, mobile ? 1.3 : 0.95);
    pileBody.position.set(pilePosition.x, -0.06, pilePosition.z);
    if (!mobile && !composer) {
      composer = new EffectComposer(renderer);
      ssao = new SSAOPass(scene, camera, host.clientWidth, host.clientHeight);
      ssao.kernelRadius = 0.01;
      ssao.minDistance = 0.0001;
      ssao.maxDistance = 0.08;
      composer.addPass(renderPass);
      composer.addPass(ssao);
      composer.addPass(output);
    }
    if (mobile && composer) {
      ssao?.dispose();
      composer.dispose();
      composer = undefined;
      ssao = undefined;
    }
    composer?.setSize(host.clientWidth, host.clientHeight);
    pileMeshes.forEach((m, i) => {
      m.position.copy(pilePosition).y += i * 0.006;
      m.scale.setScalar(mobile ? 0.48 : 0.5);
    });
    if (active) {
      apply(active, openPose());
      active.animation = undefined;
      active.state = "open";
      paint(active, true);
    }
    wake();
  }
  const ray = new T.Raycaster(),
    pointer = new T.Vector2(),
    plane = new T.Plane(new T.Vector3(0, 1, 0), -(radius + 0.2)),
    hit = new T.Vector3();
  let pilePressed = false;
  let drag:
    | {
        p: Paper;
        x: number;
        y: number;
        moving: boolean;
        time: number;
        last: T.Vector3;
        velocity: T.Vector3;
      }
    | undefined;
  function point(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, (-(e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
  }
  function pick() {
    const hit = ray.intersectObjects(
      [...papers.values()].filter((p) => p.state !== "gone" && p.dropDelay <= 0).map((p) => p.mesh)
    )[0];
    return hit ? [...papers.values()].find((p) => p.mesh === hit.object) : undefined;
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    point(e);
    const p = pick();
    pilePressed = !p && ray.intersectObjects(pileMeshes).length > 0;
    if (!p || p === active) return;
    drag = {
      p,
      x: e.clientX,
      y: e.clientY,
      moving: false,
      time: e.timeStamp,
      last: p.mesh.position.clone(),
      velocity: new T.Vector3()
    };
    canvas.setPointerCapture(e.pointerId);
    wake();
  }
  function move(e: PointerEvent) {
    point(e);
    if (!drag) {
      const overPile = ray.intersectObjects(pileMeshes).length > 0;
      canvas.style.cursor = pick() ? "grab" : overPile ? "pointer" : "default";
      canvas.title = overPile ? getDict(locale).desk.openLibrary : "";
      return;
    }
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 6) drag.moving = true;
    if (!drag.moving || !ray.ray.intersectPlane(plane, hit)) return;
    const p = drag.p;
    p.animation = undefined;
    p.state = "grab";
    p.body.type = C.Body.KINEMATIC;
    p.body.collisionResponse = true;
    const bound = mobile ? 0.95 : 2.4;
    hit.x = T.MathUtils.clamp(hit.x, -bound + radius, bound - radius);
    hit.z = T.MathUtils.clamp(hit.z, -1.1 + radius, 1.7 - radius);
    const dt = Math.max(0.008, (e.timeStamp - drag.time) / 1000);
    drag.velocity.copy(hit).sub(drag.last).divideScalar(dt).clampLength(0, 5);
    p.body.velocity.set(drag.velocity.x, 0, drag.velocity.z);
    p.body.position.set(hit.x, hit.y, hit.z);
    p.mesh.position.copy(hit);
    drag.last.copy(hit);
    drag.time = e.timeStamp;
    canvas.style.cursor = "grabbing";
    wake();
  }
  function up(e: PointerEvent) {
    if (pilePressed) {
      point(e);
      pilePressed = false;
      if (e.type !== "pointercancel" && ray.intersectObjects(pileMeshes).length > 0) onLibrary();
    }
    if (!drag) return;
    const { p, moving, velocity, time } = drag;
    drag = undefined;
    if (moving) {
      finish(p, "rest");
      if (e.type !== "pointercancel" && e.timeStamp - time < 100)
        p.body.velocity.set(velocity.x, 0.3, velocity.z);
    } else {
      open(deskKey(p.item));
      onOpen(deskKey(p.item));
    }
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "grab";
    wake();
  }
  function tick(time: number) {
    if (disposed || document.hidden) {
      stopAfterFrame();
      return;
    }
    const dt = Math.min(0.033, (time - lastTime) / 1000 || 1 / 60);
    lastTime = time;
    world.step(1 / 60, dt, 3);
    for (const [key, p] of papers) {
      if (p.dropDelay > 0) {
        p.dropDelay = Math.max(0, p.dropDelay - dt);
        if (p.dropDelay === 0) { world.addBody(p.body); p.mesh.visible = true; }
        continue;
      }
      if (p.animation) {
        const a = p.animation;
        a.elapsed += dt;
        const t = Math.min(1, a.elapsed / 0.75),
          ease = 1 - Math.pow(1 - t, 3);
        apply(p, {
          position: a.from.position
            .clone()
            .lerp(a.to.position, ease)
            .add(new T.Vector3(0, a.end === "gone" ? Math.sin(t * Math.PI) * 0.45 : 0, 0)),
          quaternion: a.from.quaternion.clone().slerp(a.to.quaternion, ease),
          scale: T.MathUtils.lerp(a.from.scale, a.to.scale, ease),
          frame: T.MathUtils.lerp(a.from.frame, a.to.frame, ease)
        });
        if (t === 1) finish(p, a.end);
      } else if (p.state === "grab") {
        // A stationary pointer must not leave a kinematic body drifting away from its mesh.
        p.body.position.set(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z);
        p.body.velocity.setZero();
      } else if (p.state === "rest") {
        const b = p.body;
        const bound = mobile ? 0.95 : 2.4;
        for (const axis of ["x", "z"] as const) {
          const low = axis === "x" ? -bound : -1.1,
            high = axis === "x" ? bound : mobile ? 1.75 : 1.7;
          if (b.position[axis] < low + radius || b.position[axis] > high - radius) {
            b.position[axis] = T.MathUtils.clamp(b.position[axis], low + radius, high - radius);
            b.velocity[axis] *= -0.3;
          }
        }
        p.settled = settleBody(b, world.contacts, radius, p.settled, dt);
        p.mesh.position.set(b.position.x, b.position.y, b.position.z);
        p.mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      } else if (p.state === "gone" && !previous.some((i) => deskKey(i) === key)) {
        destroyPaper(p);
        papers.delete(key);
      }
    }
    const focusedPaper = focused ? papers.get(focused) : undefined;
    focusRing.visible = !!focusedPaper && focusedPaper.state !== "gone";
    if (focusedPaper) {
      focusRing.position.copy(focusedPaper.mesh.position);
      focusRing.quaternion.copy(camera.quaternion);
    }
    if (composer) composer.render();
    else renderer.render(scene, camera);
    host.dataset.frames = String(Number(host.dataset.frames ?? 0) + 1);
    if (isEverythingAtRest([...papers.values()].map(p => ({
      state: p.state, sleeping: p.body.sleepState === C.Body.SLEEPING,
      animating: !!p.animation, dropDelay: p.dropDelay
    })), !!drag)) stopAfterFrame();
  }
  // three.js requests the next frame only after the loop callback returns, so stopping from inside
  // tick() would cancel the frame that already fired and leave an empty rAF chain running forever.
  // Defer the stop to a microtask, which runs after three.js has queued that next frame.
  function stopAfterFrame() {
    if (stopQueued) return;
    stopQueued = true;
    queueMicrotask(() => {
      if (stopQueued) stop();
    });
  }
  function stop() {
    stopQueued = false;
    renderer.setAnimationLoop(null);
    looping = false;
    host.dataset.animating = "false";
    if (deskHome) deskHome.dataset.deskRendering = "off";
  }
  function wake() {
    stopQueued = false;
    if (disposed || document.hidden || looping) return;
    looping = true;
    lastTime = performance.now();
    host.dataset.animating = "true";
    if (deskHome) deskHome.dataset.deskRendering = "on";
    renderer.setAnimationLoop(tick);
  }
  function visibility() {
    if (document.hidden) stop();
    else wake();
  }
  function motion(e: MediaQueryListEvent) {
    reduced = e.matches;
    wake();
  }
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", motion);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  document.addEventListener("visibilitychange", visibility);
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  const fonts = getComputedStyle(document.documentElement);
  void Promise.all([
    document.fonts.load(`600 62px ${fonts.getPropertyValue("--font-general-sans")}`),
    document.fonts.load(`500 36px ${fonts.getPropertyValue("--font-plex-mono")}`)
  ])
    .then(() => {
      if (!disposed) {
        papers.forEach((p) => paint(p, p === active));
        lastSync = "";
        sync(previous, latestPile);
        wake();
      }
    })
    .catch(() => {});
  resize();
  return {
    sync,
    setOpenBand,
    open,
    file: (key) => exit(key, true),
    trash: (key) => exit(key, false),
    putBack,
    focus: (key) => {
      focused = key;
      papers.forEach((p, k) => {
        p.mesh.material.emissive.set(k === key ? "#f3b44a" : "white");
        p.mesh.material.emissiveIntensity = k === key ? 0.6 : 0.2;
      });
      wake();
    },
    dispose() {
      disposed = true;
      stop();
      observer.disconnect();
      media.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      papers.forEach(destroyPaper);
      scene.traverse((o) => {
        if (o instanceof T.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            m.map?.dispose();
            m.dispose();
          }
        }
      });
      ssao?.dispose();
      composer?.dispose();
      output.dispose();
      light.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    }
  };
}
