// 3D model viewer (three.js), loaded on demand as a separate chunk.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { h } from '../dom.js';

export function modelViewer(file) {
  const host = h('div', { class: 'view-body', style: { overflow: 'hidden' } });
  const info = h('span', { class: 'muted num' }, 'Loading…');
  let wire = false;
  const wireBtn = h('button', { 'aria-pressed': 'false', onclick: () => { wire = !wire; wireBtn.setAttribute('aria-pressed', String(wire)); scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.wireframe = wire; }); }); } }, 'Wireframe');
  const bar = h('div', { class: 'view-bar' }, h('span', { class: 'path' }, file.path), info, h('div', { class: 'seg' }, wireBtn));
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(3, 5, 4);
  scene.add(dir);
  const grid = new THREE.GridHelper(10, 20, 0x3fd3c1, 0x334050);
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let raf = 0, alive = true;
  const resize = () => {
    const w = host.clientWidth || 600, hh = host.clientHeight || 400;
    renderer.setSize(w, hh, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };

  const frame = (obj) => {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const center = box.getCenter(new THREE.Vector3());
    obj.position.sub(center);
    grid.scale.setScalar(size / 6);
    grid.position.y = -box.getSize(new THREE.Vector3()).y / 2;
    camera.position.set(size * 0.7, size * 0.5, size * 0.9);
    camera.near = size / 1000; camera.far = size * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    let verts = 0, tris = 0;
    obj.traverse((o) => { if (o.geometry) { const p = o.geometry.attributes.position; verts += p ? p.count : 0; tris += o.geometry.index ? o.geometry.index.count / 3 : (p ? p.count / 3 : 0); } });
    info.textContent = `${verts.toLocaleString()} vertices · ${Math.round(tris).toLocaleString()} triangles`;
  };

  const mat = () => new THREE.MeshStandardMaterial({ color: 0xb8c4d4, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
  (async () => {
    try {
      const buf = await file.blob.arrayBuffer();
      const name = file.name.toLowerCase();
      let obj;
      if (file.meshJSON) {
        obj = meshFromJSON(JSON.parse(new TextDecoder().decode(buf)), mat());
      } else if (name.endsWith('.glb') || name.endsWith('.gltf')) {
        const g = await new GLTFLoader().parseAsync(buf, '');
        obj = g.scene;
      } else if (name.endsWith('.obj')) {
        obj = new OBJLoader().parse(new TextDecoder().decode(buf));
        obj.traverse((o) => { if (o.isMesh) o.material = mat(); });
      } else if (name.endsWith('.fbx')) {
        obj = new FBXLoader().parse(buf, '');
      } else if (name.endsWith('.stl')) {
        obj = new THREE.Mesh(new STLLoader().parse(buf), mat());
      } else if (name.endsWith('.ply')) {
        const g = new PLYLoader().parse(buf);
        g.computeVertexNormals();
        obj = new THREE.Mesh(g, mat());
      } else throw new Error('unsupported model format');
      scene.add(obj);
      frame(obj);
      resize();
      loop();
    } catch (e) {
      info.textContent = 'Could not display this model: ' + e.message;
    }
  })();
  return {
    el: [bar, host],
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
}

// Mesh JSON produced by the engine (Unity meshes): {positions, normals?, uvs?, indices, submeshes?}
function meshFromJSON(m, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  if (m.normals && m.normals.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
  if (m.uvs && m.uvs.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
  if (m.indices && m.indices.length) g.setIndex(m.indices);
  if (!m.normals || !m.normals.length) g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}
