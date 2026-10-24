import * as THREE from 'three'

/** Original night pitch. Geometry, colours, and the ball pattern are drawn in code. three.js is MIT. */

export type ShotPlan = {
  outcome: 'goal' | 'saved' | 'miss'
  target: string
  keeper: string
}

export type ZoneScreen = { key: string; left: number; top: number }

const AIM: Record<string, { x: number; y: number }> = {
  'top-left': { x: -2.35, y: 1.95 },
  'top-center': { x: 0, y: 2.05 },
  'top-right': { x: 2.35, y: 1.95 },
  'mid-left': { x: -2.7, y: 1.25 },
  'mid-center': { x: 0, y: 1.22 },
  'mid-right': { x: 2.7, y: 1.25 },
  'bottom-left': { x: -2.4, y: 0.42 },
  'bottom-center': { x: 0, y: 0.32 },
  'bottom-right': { x: 2.4, y: 0.42 },
}

const DIVES: Record<string, { x: number; y: number; z: number; rz: number; rx: number }> = {
  'top-left': { x: -1.7, y: 0.85, z: 0.35, rz: 1.05, rx: -0.55 },
  'top-center': { x: 0.05, y: 1.05, z: 0.25, rz: 0.1, rx: -0.75 },
  'top-right': { x: 1.7, y: 0.85, z: 0.35, rz: -1.05, rx: -0.55 },
  'mid-left': { x: -2.05, y: 0.12, z: 0.4, rz: 1.35, rx: -0.1 },
  'mid-center': { x: 0, y: 0.18, z: 0.4, rz: 0, rx: -0.2 },
  'mid-right': { x: 2.05, y: 0.12, z: 0.4, rz: -1.35, rx: -0.1 },
  'bottom-left': { x: -1.9, y: 0, z: 0.45, rz: 1.5, rx: 0.45 },
  'bottom-center': { x: 0, y: 0, z: 0.5, rz: 0.05, rx: 0.65 },
  'bottom-right': { x: 1.9, y: 0, z: 0.45, rz: -1.5, rx: 0.45 },
}

const RUN_END = 0.85
const FLIGHT_START = 1.05
const FLIGHT_END = 3.45
const DIVE_START = 1.25
const DIVE_END = 2.05
const TOTAL = 4.2
const BALL_R = 0.11

type NetNode = { x: number; y: number; z: number; bx: number; by: number; bz: number; vz: number }
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }
type Rig = {
  group: any
  leftHip: any
  rightHip: any
  leftKnee: any
  rightKnee: any
  leftArm: any
  rightArm: any
}

function smooth(u: number) {
  const t = Math.min(1, Math.max(0, u))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, u: number) {
  return a + (b - a) * u
}

function makeBallTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(0, 0, 256, 128)
  ctx.strokeStyle = '#d7d2c8'
  ctx.lineWidth = 2
  for (let x = 16; x < 256; x += 32) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 128)
    ctx.stroke()
  }
  ctx.fillStyle = '#161616'
  const spots = [
    [48, 36], [128, 28], [200, 40], [84, 78], [160, 70], [32, 96], [116, 104], [196, 100], [230, 78],
  ]
  for (const [x, y] of spots) {
    ctx.beginPath()
    ctx.moveTo(x, y - 11)
    ctx.lineTo(x + 9, y - 3)
    ctx.lineTo(x + 6, y + 9)
    ctx.lineTo(x - 6, y + 9)
    ctx.lineTo(x - 9, y - 3)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

function limb(length: number, radius: number, material: any) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.05, length - radius * 2), 3, 6), material)
  mesh.position.y = -length / 2
  return mesh
}

function makeRig(colors: { shirt: number; short: number; sock: number; skin: number; glove: number | null }): Rig {
  const group = new THREE.Group()
  const shirt = new THREE.MeshLambertMaterial({ color: colors.shirt })
  const shorts = new THREE.MeshLambertMaterial({ color: colors.short })
  const skin = new THREE.MeshLambertMaterial({ color: colors.skin })
  const sock = new THREE.MeshLambertMaterial({ color: colors.sock })
  const boot = new THREE.MeshLambertMaterial({ color: 0x1b1b1b })
  const glove = new THREE.MeshLambertMaterial({ color: colors.glove ?? colors.skin })
  const handMat = colors.glove === null ? skin : glove
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.42, 4, 8), shirt)
  torso.position.y = 1.22
  group.add(torso)
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.2), shorts)
  hips.position.y = 0.92
  group.add(hips)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), skin)
  head.position.y = 1.62
  group.add(head)
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.136, 10, 8), new THREE.MeshLambertMaterial({ color: 0x1a120c }))
  hair.position.y = 1.71
  hair.scale.y = 0.5
  group.add(hair)

  function leg(x: number) {
    const hip = new THREE.Group()
    hip.position.set(x, 0.9, 0)
    const thigh = limb(0.42, 0.07, shorts)
    hip.add(thigh)
    const knee = new THREE.Group()
    knee.position.y = -0.42
    knee.add(limb(0.4, 0.055, sock))
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.22), boot)
    foot.position.set(0, -0.42, 0.05)
    knee.add(foot)
    hip.add(knee)
    group.add(hip)
    return { hip, knee }
  }

  function arm(x: number) {
    const shoulder = new THREE.Group()
    shoulder.position.set(x, 1.42, 0)
    shoulder.add(limb(0.34, 0.05, shirt))
    const elbow = new THREE.Group()
    elbow.position.y = -0.34
    elbow.add(limb(0.3, 0.045, handMat))
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), handMat)
    hand.position.y = -0.32
    elbow.add(hand)
    shoulder.add(elbow)
    group.add(shoulder)
    return shoulder
  }

  const left = leg(-0.12)
  const right = leg(0.12)
  return {
    group,
    leftHip: left.hip,
    rightHip: right.hip,
    leftKnee: left.knee,
    rightKnee: right.knee,
    leftArm: arm(-0.28),
    rightArm: arm(0.28),
  }
}

function pitchLine(x1: number, z1: number, x2: number, z2: number, material: any) {
  const dx = x2 - x1
  const dz = z2 - z1
  const len = Math.hypot(dx, dz) || 0.01
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.015, 0.1), material)
  mesh.position.set((x1 + x2) / 2, 0.03, (z1 + z2) / 2)
  mesh.rotation.y = Math.atan2(-dz, dx)
  return mesh
}

export class PenaltyScene {
  private renderer: any
  private scene: any
  private camera: any
  private raf = 0
  private disposed = false
  private observer: ResizeObserver
  private t0 = 0
  private last = 0
  private playing = false
  private held = false
  private plan: ShotPlan | null = null
  private resolveShot: (() => void) | null = null
  private taker: Rig
  private keeper: Rig
  private takerShadow: any
  private keeperShadow: any
  private ball: any
  private ballRig: any
  private ghosts: any[]
  private ballShadow: any
  private rings: { key: string; mesh: any }[]
  private netNodes: NetNode[] = []
  private netPairs: number[] = []
  private netPos = new Float32Array(0)
  private netGeom: any
  private lights: any[]
  private wash: any
  private particles: Particle[]
  private particlePos: Float32Array
  private particleGeom: any
  private audio: AudioContext | null = null
  private pulsed = false
  private cheered = false
  private trail: any[] = []
  private prevBall = new THREE.Vector3()
  private aimVisible = true
  private readonly tmp = new THREE.Vector3() as any
  onMarkers?: (markers: ZoneScreen[]) => void

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x070b14)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x070b14)
    this.scene.fog = new THREE.Fog(0x0b1020, 24, 78)
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120)
    this.camera.position.set(0, 1.7, 15.8)
    this.camera.lookAt(0, 1.15, 2)

    this.scene.add(new THREE.AmbientLight(0xc5d4ee, 0.72))
    const sun = new THREE.DirectionalLight(0xfff4dd, 1.15)
    sun.position.set(8, 18, 10)
    this.scene.add(sun)

    const grass = new THREE.Mesh(new THREE.PlaneGeometry(92, 78, 1, 1), new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: `
        varying vec3 vWorld;
        void main() {
          float stripe = step(0.5, fract(vWorld.z * 0.085));
          vec3 a = vec3(0.09, 0.40, 0.15);
          vec3 b = vec3(0.16, 0.52, 0.20);
          vec3 col = mix(a, b, stripe);
          float n = fract(sin(dot(floor(vWorld.xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453);
          float pool = 0.62 + 0.38 * smoothstep(32.0, 6.0, length(vWorld.xz - vec2(0.0, 8.0)));
          gl_FragColor = vec4(col * pool * (0.94 + 0.08 * n), 1.0);
        }
      `,
    }))
    grass.rotation.x = -Math.PI / 2
    grass.position.set(0, 0, 8)
    this.scene.add(grass)

    const white = new THREE.MeshLambertMaterial({ color: 0xf4f7fb })
    const addLine = (x1: number, z1: number, x2: number, z2: number) => this.scene.add(pitchLine(x1, z1, x2, z2, white))
    addLine(-26, 0, 26, 0)
    addLine(-9.16, 0, -9.16, 5.5)
    addLine(9.16, 0, 9.16, 5.5)
    addLine(-9.16, 5.5, 9.16, 5.5)
    addLine(-20.16, 0, -20.16, 16.5)
    addLine(20.16, 0, 20.16, 16.5)
    addLine(-20.16, 16.5, 20.16, 16.5)
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 20), new THREE.MeshBasicMaterial({ color: 0xf4f7fb }))
    spot.rotation.x = -Math.PI / 2
    spot.position.set(0, 0.035, 11)
    this.scene.add(spot)
    const arc = new THREE.Mesh(new THREE.RingGeometry(9.15, 9.27, 40, 1, Math.PI * 0.18, Math.PI * 0.64), new THREE.MeshBasicMaterial({ color: 0xf4f7fb, side: THREE.DoubleSide }))
    arc.rotation.x = -Math.PI / 2
    arc.position.set(0, 0.032, 11)
    this.scene.add(arc)

    const postMat = new THREE.MeshLambertMaterial({ color: 0xf7f7f7 })
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.44, 10)
    const leftPost = new THREE.Mesh(postGeo, postMat)
    leftPost.position.set(-3.72, 1.22, 0)
    const rightPost = new THREE.Mesh(postGeo, postMat)
    rightPost.position.set(3.72, 1.22, 0)
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7.56, 10), postMat)
    bar.rotation.z = Math.PI / 2
    bar.position.set(0, 2.44, 0)
    this.scene.add(leftPost, rightPost, bar)
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 2.5), new THREE.MeshBasicMaterial({ color: 0x07080d }))
    mouth.position.set(0, 1.22, -1.85)
    this.scene.add(mouth)

    this.netGeom = this.buildNet()
    this.scene.add(new THREE.LineSegments(this.netGeom, new THREE.LineBasicMaterial({ color: 0xf3f3f3, transparent: true, opacity: 0.82 })))
    this.scene.add(this.buildStaticNet())

    this.addStadium()
    this.lights = this.addFloods()

    this.taker = makeRig({ shirt: 0x1c2c4a, short: 0xf4f4f4, sock: 0x1c2c4a, skin: 0xc68642, glove: null })
    this.keeper = makeRig({ shirt: 0xf0c014, short: 0x1a1a1a, sock: 0xf0c014, skin: 0xc68642, glove: 0xff6a00 })
    this.scene.add(this.taker.group, this.keeper.group)
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
    this.takerShadow = new THREE.Mesh(new THREE.CircleGeometry(0.38, 16), blobMat)
    this.keeperShadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), blobMat.clone())
    for (const blob of [this.takerShadow, this.keeperShadow]) {
      blob.rotation.x = -Math.PI / 2
      blob.position.y = 0.025
      this.scene.add(blob)
    }

    const ballMap = makeBallTexture()
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshLambertMaterial({ color: 0xffffff, map: ballMap ?? undefined }),
    )
    this.ballRig = new THREE.Group()
    this.ballRig.add(this.ball)
    this.scene.add(this.ballRig)
    this.ghosts = [0.28, 0.16, 0.08].map((opacity) => {
      const ghost = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false }),
      )
      ghost.visible = false
      this.scene.add(ghost)
      return ghost
    })
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }))
    this.ballShadow.rotation.x = -Math.PI / 2
    this.ballShadow.position.y = 0.026
    this.scene.add(this.ballShadow)

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xf5d76e, transparent: true, opacity: 0.92 })
    this.rings = Object.keys(AIM).map((key) => {
      const aim = AIM[key]
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 8, 18), ringMat.clone())
      mesh.position.set(aim.x, aim.y, 0.16)
      this.scene.add(mesh)
      return { key, mesh }
    })

    this.particles = Array.from({ length: 72 }, () => ({ x: 0, y: -4, z: 0, vx: 0, vy: 0, vz: 0, life: 0 }))
    this.particlePos = new Float32Array(this.particles.length * 3)
    this.particleGeom = new THREE.BufferGeometry()
    this.particleGeom.setAttribute('position', new THREE.BufferAttribute(this.particlePos, 3))
    this.scene.add(new THREE.Points(this.particleGeom, new THREE.PointsMaterial({ color: 0xffd56a, size: 0.09, transparent: true, opacity: 0.95, depthWrite: false })))

    this.wash = new THREE.Mesh(new THREE.PlaneGeometry(46, 14), new THREE.MeshBasicMaterial({ color: 0xffe1a8, transparent: true, opacity: 0, depthWrite: false }))
    this.wash.position.set(0, 5, -7.2)
    this.scene.add(this.wash)

    this.resetPoses()
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas.parentElement ?? canvas)
    this.resize()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  armAudio() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    try {
      if (!this.audio) this.audio = new Ctx()
      void this.audio.resume()
    } catch {
      this.audio = null
    }
  }

  setAimVisible(on: boolean) {
    this.aimVisible = on
    for (const ring of this.rings) ring.mesh.visible = on
  }

  shoot(plan: ShotPlan) {
    if (this.resolveShot) this.resolveShot()
    this.plan = plan
    this.playing = true
    this.held = false
    this.pulsed = false
    this.cheered = false
    this.trail = []
    this.t0 = performance.now()
    this.resetPoses()
    return new Promise<void>((resolve) => {
      this.resolveShot = resolve
    })
  }

  resize() {
    const canvas = this.renderer.domElement
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 640
    const height = canvas.clientHeight || canvas.parentElement?.clientHeight || 420
    if (width < 2 || height < 2) return
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.resolveShot?.()
    this.resolveShot = null
    this.scene.traverse((obj: any) => {
      const mesh = obj
      mesh.geometry?.dispose?.()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((entry: any) => entry.dispose?.())
      else material?.dispose?.()
    })
    this.renderer.dispose()
    try { this.audio?.close() } catch { /* ignore */ }
  }

  private frame = (now: number) => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (this.playing) {
      const t = Math.min((now - this.t0) / 1000, TOTAL)
      this.apply(t, now)
      if (t >= TOTAL && this.resolveShot) {
        const done = this.resolveShot
        this.resolveShot = null
        this.playing = false
        this.held = true
        done()
      }
    } else if (!this.held) {
      this.idle(now)
    }
    this.simNet(dt)
    this.simParticles(dt)
    this.wash.material.opacity = Math.max(0, this.wash.material.opacity - dt * 0.35)
    this.project()
    this.renderer.render(this.scene, this.camera)
  }

  private idle(now: number) {
    const sway = Math.sin(now * 0.0017)
    this.keeper.group.position.set(sway * 0.16, 0, 0.55)
    this.keeper.group.rotation.set(0, 0, sway * 0.05)
    this.keeper.leftHip.rotation.x = 0.08
    this.keeper.rightHip.rotation.x = -0.05
    this.keeper.leftArm.rotation.x = -0.35 + sway * 0.08
    this.keeper.rightArm.rotation.x = -0.35 - sway * 0.08
    this.taker.group.position.set(0, 0, 13.7)
    this.taker.group.rotation.set(0.08, 0, 0)
    const breathe = Math.sin(now * 0.002)
    this.taker.leftHip.rotation.x = 0.15
    this.taker.rightHip.rotation.x = -0.1
    this.taker.leftKnee.rotation.x = 0.2
    this.taker.rightKnee.rotation.x = 0.15
    this.taker.leftArm.rotation.z = 0.15
    this.taker.rightArm.rotation.z = -0.15
    this.taker.group.position.y = breathe * 0.01
    this.ballRig.position.set(0, BALL_R, 11)
    this.ball.scale.set(1, 1, 1)
    this.placeShadows()
    this.camera.position.set(0, 1.7, 15.8)
    this.camera.fov = 48
    this.camera.lookAt(0, 1.15, 2)
    this.camera.updateProjectionMatrix()
    for (const ghost of this.ghosts) ghost.visible = false
  }

  private apply(t: number, now: number) {
    const plan = this.plan
    if (!plan) return
    const run = smooth(Math.min(t / RUN_END, 1))
    this.taker.group.position.set(0, Math.abs(Math.sin(t * 14)) * 0.04 * (1 - run * 0.3), lerp(14.05, 11.55, run))
    this.taker.group.rotation.set(0.16, 0, 0)
    if (t < RUN_END) {
      const phase = t * 12
      this.taker.leftHip.rotation.x = Math.sin(phase) * 0.75
      this.taker.rightHip.rotation.x = Math.sin(phase + Math.PI) * 0.75
      this.taker.leftKnee.rotation.x = Math.max(0, Math.sin(phase + 0.5)) * 1.05
      this.taker.rightKnee.rotation.x = Math.max(0, Math.sin(phase + Math.PI + 0.5)) * 1.05
      this.taker.leftArm.rotation.x = Math.sin(phase + Math.PI) * 0.7
      this.taker.rightArm.rotation.x = Math.sin(phase) * 0.7
      this.taker.leftArm.rotation.z = 0.2
      this.taker.rightArm.rotation.z = -0.2
    } else {
      const kick = smooth((t - 0.72) / 0.4)
      this.taker.rightHip.rotation.x = lerp(0.35, 1.25, kick)
      this.taker.rightKnee.rotation.x = lerp(1.15, 0.12, kick)
      this.taker.leftHip.rotation.x = -0.35
      this.taker.leftKnee.rotation.x = 0.25
      this.taker.leftArm.rotation.x = lerp(0.2, -0.8, kick)
      this.taker.rightArm.rotation.x = lerp(-0.2, 0.4, kick)
      this.taker.group.position.z = lerp(11.55, 11.72, kick)
    }

    const dive = DIVES[plan.keeper] ?? DIVES['mid-center']
    const du = smooth(t <= DIVE_START ? 0 : (t - DIVE_START) / (DIVE_END - DIVE_START))
    const sway = Math.sin(now * 0.0017) * (1 - du)
    this.keeper.group.position.set(lerp(sway * 0.16, dive.x, du), lerp(0, dive.y, du), lerp(0.55, dive.z, du))
    this.keeper.group.rotation.set(lerp(0, dive.rx, du), 0, lerp(sway * 0.05, dive.rz, du))
    const reach = du > 0.2 ? 1 : 0
    this.keeper.leftArm.rotation.x = lerp(-0.4, -1.15, du)
    this.keeper.rightArm.rotation.x = lerp(-0.4, -1.15, du)
    this.keeper.leftArm.rotation.z = 0.5 * reach * (dive.rz >= 0 ? 1 : 0.2)
    this.keeper.rightArm.rotation.z = -0.5 * reach * (dive.rz <= 0 ? 1 : 0.2)
    this.keeper.leftHip.rotation.x = lerp(0.1, 0.45, du)
    this.keeper.rightHip.rotation.x = lerp(-0.05, 0.2, du)

    const aim = AIM[plan.target] ?? AIM['mid-center']
    const from = new THREE.Vector3(0, BALL_R, 11)
    let dest = new THREE.Vector3(aim.x, aim.y, -1.05)
    let lift = aim.y > 1.6 ? 0.85 : 0.45
    if (plan.outcome === 'miss') {
      const over = plan.target.startsWith('top-') || plan.target.endsWith('center')
      dest = over
        ? new THREE.Vector3(aim.x * 0.8, 3.65, -1.1)
        : new THREE.Vector3(Math.sign(aim.x || 1) * 4.85, Math.max(aim.y, 0.55), 0.35)
      lift = over ? 1.35 : 0.4
    }
    const bend = Math.abs(aim.x) < 0.25 ? 0.35 : Math.sign(aim.x) * 0.55
    const u = t <= FLIGHT_START ? 0 : t >= FLIGHT_END ? 1 : 1 - Math.pow(1 - (t - FLIGHT_START) / (FLIGHT_END - FLIGHT_START), 2.6)
    this.prevBall.copy(this.ballRig.position)
    if (t < FLIGHT_START) {
      this.ballRig.position.copy(from)
      this.ball.scale.set(1, t > 0.98 ? 0.82 : 1, 1)
    } else if (plan.outcome === 'saved') {
      const hands = new THREE.Vector3(aim.x * 0.86, Math.max(0.4, aim.y), 0.82)
      const away = new THREE.Vector3(aim.x * -0.15, hands.y + 1.15, 5.2)
      const split = 0.74
      const pos = u < split
        ? this.arc(from, hands, bend, u / split, lift)
        : this.arc(hands, away, bend * 0.2, (u - split) / (1 - split), 0.7)
      this.ballRig.position.copy(pos)
    } else {
      this.ballRig.position.copy(this.arc(from, dest, bend, u, lift))
    }
    const speed = this.ballRig.position.distanceTo(this.prevBall)
    if (t >= FLIGHT_START) {
      this.ball.rotation.x += 0.35 + speed * 8
      this.ball.rotation.y += bend * 0.15
      this.ball.scale.set(1, 1, 1 + Math.min(0.7, speed * 5))
      this.trail.unshift(this.ballRig.position.clone())
      if (this.trail.length > 4) this.trail.pop()
    }
    this.ghosts.forEach((ghost, i) => {
      const point = this.trail[i + 1]
      ghost.visible = Boolean(point) && t >= FLIGHT_START
      if (point) ghost.position.copy(point)
    })
    this.placeShadows()

    const flight = t <= FLIGHT_START ? 0 : Math.min(1, (t - FLIGHT_START) / (FLIGHT_END - FLIGHT_START))
    this.camera.position.set(this.ballRig.position.x * 0.04, 1.68 + flight * 0.2, 15.75 - flight * 0.7)
    this.camera.fov = 48 - flight * 6
    this.camera.lookAt(this.ballRig.position.x * 0.22, 1.05 + this.ballRig.position.y * 0.08, Math.min(5.5, this.ballRig.position.z))
    this.camera.updateProjectionMatrix()

    if (!this.pulsed && u > 0.96 && plan.outcome === 'goal') {
      this.pulsed = true
      this.kickNet(this.ballRig.position.x, this.ballRig.position.y)
      this.burst(this.ballRig.position, 1)
      this.roar('goal')
    }
    if (!this.cheered && u > 0.72 && plan.outcome === 'saved') {
      this.cheered = true
      this.burst(this.ballRig.position, 0.45)
      this.roar('saved')
    }
    if (!this.cheered && u > 0.9 && plan.outcome === 'miss') {
      this.cheered = true
      this.roar('miss')
    }
    for (const light of this.lights) {
      const base = 28
      light.intensity = base * (1 + this.wash.material.opacity * 1.4 + Math.sin(now * 0.004 + light.position.x) * 0.04)
    }
  }

  private arc(a: any, b: any, bend: number, u: number, lift: number) {
    const mid = this.tmp.set((a.x + b.x) / 2 + bend, Math.max(a.y, b.y) * 0.5 + lift, (a.z + b.z) / 2)
    const abx = lerp(a.x, mid.x, u)
    const aby = lerp(a.y, mid.y, u)
    const abz = lerp(a.z, mid.z, u)
    const bcx = lerp(mid.x, b.x, u)
    const bcy = lerp(mid.y, b.y, u)
    const bcz = lerp(mid.z, b.z, u)
    return new THREE.Vector3(lerp(abx, bcx, u), lerp(aby, bcy, u), lerp(abz, bcz, u))
  }

  private placeShadows() {
    this.takerShadow.position.set(this.taker.group.position.x, 0.025, this.taker.group.position.z)
    this.keeperShadow.position.set(this.keeper.group.position.x, 0.025, this.keeper.group.position.z)
    this.ballShadow.position.set(this.ballRig.position.x, 0.026, this.ballRig.position.z)
    const scale = 1 + Math.max(0, this.ballRig.position.y - BALL_R) * 0.35
    this.ballShadow.scale.set(scale, scale, scale)
    this.ballShadow.material.opacity = Math.max(0.12, 0.42 - this.ballRig.position.y * 0.08)
  }

  private resetPoses() {
    this.ballRig.position.set(0, BALL_R, 11)
    this.ball.rotation.set(0, 0, 0)
    this.ball.scale.set(1, 1, 1)
    this.taker.group.position.set(0, 0, 14.05)
    this.taker.group.rotation.set(0, 0, 0)
    this.keeper.group.position.set(0, 0, 0.55)
    this.keeper.group.rotation.set(0, 0, 0)
    for (const node of this.netNodes) {
      node.x = node.bx
      node.y = node.by
      node.z = node.bz
      node.vz = 0
    }
    this.writeNet()
    for (const ghost of this.ghosts) ghost.visible = false
    this.trail = []
    this.placeShadows()
  }

  private kickNet(x: number, y: number) {
    for (const node of this.netNodes) {
      const d = Math.hypot(node.x - x, node.y - y)
      if (d < 1.55) node.vz -= (1.55 - d) * 2.1
    }
    this.wash.material.opacity = 0.42
  }

  private burst(at: any, power: number) {
    for (const p of this.particles) {
      p.x = at.x + (Math.random() - 0.5) * 0.4
      p.y = at.y + (Math.random() - 0.5) * 0.3
      p.z = at.z
      p.vx = (Math.random() - 0.5) * 2.4 * power
      p.vy = (0.8 + Math.random() * 2.4) * power
      p.vz = (Math.random() - 0.2) * 1.6 * power
      p.life = 0.8 + Math.random() * 0.7
    }
    this.wash.material.opacity = Math.max(this.wash.material.opacity, 0.18 * power)
  }

  private simNet(dt: number) {
    const step = Math.min(dt, 0.033)
    let moving = false
    for (const node of this.netNodes) {
      node.vz += (node.bz - node.z) * 9 * step
      node.vz *= Math.max(0, 1 - 2.4 * step)
      node.z += node.vz * step * 8
      if (Math.abs(node.vz) > 0.002 || Math.abs(node.z - node.bz) > 0.002) moving = true
    }
    if (moving || this.playing) this.writeNet()
  }

  private writeNet() {
    const pos = this.netPos
    for (let i = 0; i < this.netPairs.length; i += 2) {
      const a = this.netNodes[this.netPairs[i]]
      const b = this.netNodes[this.netPairs[i + 1]]
      const o = i * 3
      pos[o] = a.x
      pos[o + 1] = a.y
      pos[o + 2] = a.z
      pos[o + 3] = b.x
      pos[o + 4] = b.y
      pos[o + 5] = b.z
    }
    const attr = this.netGeom?.attributes?.position
    if (attr) attr.needsUpdate = true
  }

  private simParticles(dt: number) {
    let live = false
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (p.life <= 0) {
        this.particlePos[i * 3 + 1] = -8
        continue
      }
      live = true
      p.life -= dt
      p.vy -= 2.2 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      this.particlePos[i * 3] = p.x
      this.particlePos[i * 3 + 1] = p.y
      this.particlePos[i * 3 + 2] = p.z
    }
    if (live) this.particleGeom.attributes.position.needsUpdate = true
  }

  private roar(kind: 'goal' | 'saved' | 'miss') {
    const ctx = this.audio
    if (!ctx || ctx.state !== 'running') return
    try {
      const dur = kind === 'goal' ? 1.5 : 0.55
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) {
        const env = Math.sin((i / data.length) * Math.PI)
        data[i] = (Math.random() * 2 - 1) * env
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = kind === 'goal' ? 900 : 420
      filter.Q.value = 0.7
      const gain = ctx.createGain()
      gain.gain.value = kind === 'goal' ? 0.22 : 0.08
      src.connect(filter)
      filter.connect(gain)
      gain.connect(ctx.destination)
      src.start()
      if (kind === 'goal') {
        const osc = ctx.createOscillator()
        osc.type = 'triangle'
        osc.frequency.value = 196
        const og = ctx.createGain()
        og.gain.setValueAtTime(0.04, ctx.currentTime)
        og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
        osc.connect(og)
        og.connect(ctx.destination)
        osc.start()
        osc.stop(ctx.currentTime + dur)
      }
    } catch {
      /* The picture carries the roar if audio is blocked. */
    }
  }

  private project() {
    if (!this.onMarkers) return
    const canvas = this.renderer.domElement
    const width = canvas.clientWidth || 1
    const height = canvas.clientHeight || 1
    const markers: ZoneScreen[] = []
    for (const ring of this.rings) {
      this.tmp.set(ring.mesh.position.x, ring.mesh.position.y, ring.mesh.position.z)
      this.tmp.project(this.camera)
      if (this.tmp.z > 1) continue
      markers.push({
        key: ring.key,
        left: (this.tmp.x * 0.5 + 0.5) * width,
        top: (-this.tmp.y * 0.5 + 0.5) * height,
      })
    }
    this.onMarkers(markers)
  }

  private buildNet() {
    const cols = 15
    const rows = 9
    const nodes: NetNode[] = []
    const index = (c: number, r: number) => r * cols + c
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -3.6 + (c / (cols - 1)) * 7.2
        const y = (r / (rows - 1)) * 2.4
        const sag = Math.sin((c / (cols - 1)) * Math.PI) * Math.sin((r / (rows - 1)) * Math.PI) * 0.45
        const z = -1.15 - sag
        nodes.push({ x, y, z, bx: x, by: y, bz: z, vz: 0 })
      }
    }
    const pairs: number[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) pairs.push(index(c, r), index(c + 1, r))
        if (r + 1 < rows) pairs.push(index(c, r), index(c, r + 1))
      }
    }
    this.netNodes = nodes
    this.netPairs = pairs
    this.netPos = new Float32Array(pairs.length * 3)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(this.netPos, 3))
    this.writeNet()
    return geom
  }

  private buildStaticNet() {
    const data: number[] = []
    const seg = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
      data.push(x1, y1, z1, x2, y2, z2)
    }
    for (const x of [-3.66, 3.66]) {
      for (let i = 0; i <= 6; i++) seg(x, (i / 6) * 2.4, 0, x, (i / 6) * 2.2, -1.5)
      for (let i = 0; i <= 4; i++) seg(x, 0, -1.5 * (i / 4), x, 2.35 - i * 0.04, -1.5 * (i / 4))
    }
    for (let i = 0; i <= 8; i++) {
      const x = -3.66 + (i / 8) * 7.32
      seg(x, 2.44, 0, x, 2.15, -1.5)
    }
    for (let i = 0; i <= 4; i++) seg(-3.66, 2.44 - i * 0.07, -1.5 * (i / 4), 3.66, 2.44 - i * 0.07, -1.5 * (i / 4))
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(data, 3))
    return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xdedede, transparent: true, opacity: 0.55 }))
  }

  private addStadium() {
    const seatGeo = new THREE.BoxGeometry(0.42, 0.28, 0.4)
    const seatMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    const palette = [0x1d3d6e, 0x163024, 0x4a1d2a, 0x2c2618, 0x123044, 0x1a1a1a, 0xc4b8a5, 0x234e38]
    const dummy = new THREE.Object3D()
    const spots: { x: number; y: number; z: number }[] = []
    for (let row = 0; row < 11; row++) {
      for (let col = 0; col < 34; col++) {
        const x = (col - 16.5) * 0.72
        spots.push({ x, y: 1.15 + row * 0.42, z: -4.4 - row * 0.72 - Math.abs(x) * 0.03 })
      }
    }
    for (const side of [-1, 1]) {
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 18; col++) {
          const z = 2 + col * 0.7
          spots.push({ x: side * (12 + row * 0.55), y: 0.9 + row * 0.4, z })
        }
      }
    }
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, spots.length)
    spots.forEach((spot, i) => {
      dummy.position.set(spot.x, spot.y, spot.z)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      seats.setMatrixAt(i, dummy.matrix)
      seats.setColorAt(i, new THREE.Color(palette[(i * 3 + spot.y) % palette.length]))
    })
    if (seats.instanceColor) seats.instanceColor.needsUpdate = true
    this.scene.add(seats)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x12161e })
    const back = new THREE.Mesh(new THREE.BoxGeometry(52, 16, 1.2), wallMat)
    back.position.set(0, 7, -13.5)
    this.scene.add(back)
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 28), wallMat)
      wall.position.set(side * 18, 4.5, 6)
      this.scene.add(wall)
    }
    const boardMat = [0x123044, 0xf4f4f4, 0x1c2c4a, 0x2f6b3a]
    for (let i = 0; i < 8; i++) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.7, 0.12), new THREE.MeshLambertMaterial({ color: boardMat[i % boardMat.length] }))
      board.position.set(-11 + i * 3.2, 0.45, -2.15)
      this.scene.add(board)
    }
  }

  private addFloods() {
    const lights: any[] = []
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 })
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xb7c0cc })
    for (const [x, z] of [[-16, 6], [16, 6], [-12, -2], [12, -2]] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 12, 6), poleMat)
      pole.position.set(x, 6, z)
      this.scene.add(pole)
      for (const dx of [-0.35, 0.35]) {
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), lampMat)
        lamp.position.set(x + dx, 12.1, z)
        this.scene.add(lamp)
      }
      const light = new THREE.PointLight(0xfff1cc, 28, 70, 2)
      light.position.set(x, 12, z)
      this.scene.add(light)
      lights.push(light)
    }
    return lights
  }
}
