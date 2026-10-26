// Port of PesaBetPro src/lib/penaltyAudio.ts.
// Commentary MP3s are not published on the site, so a missing file falls back to speech.
// Stadium ambience and the kick are procedural WebAudio, as in that module.

export interface PenaltyAudioSettings {
  commentaryOn: boolean
  stadiumOn: boolean
  effectsOn: boolean
  commentaryVol: number
  stadiumVol: number
  effectsVol: number
}

const DEFAULTS: PenaltyAudioSettings = {
  commentaryOn: true,
  stadiumOn: true,
  effectsOn: true,
  commentaryVol: 0.9,
  stadiumVol: 0.35,
  effectsVol: 0.7,
}

const STORAGE_KEY = 'penalty_audio_settings_v1'

export type CommentaryEvent =
  | 'pre' | 'shoot' | 'goal' | 'save' | 'miss'
  | 'mult_5' | 'mult_10' | 'mult_20' | 'mult_35'

const LINES: Record<CommentaryEvent, string[]> = {
  pre: ['Here we go!', "He's stepping up for the penalty!", 'This could be a big one!'],
  shoot: ['He shoots!', 'Here comes the strike!', 'He takes it!'],
  goal: ['Goooaaal!', 'What a finish!', 'He has found the back of the net!'],
  save: ['Saved!', 'What a save!', 'The goalkeeper has stopped it!'],
  miss: ["He's missed!", 'Wide!', "Oh no! He couldn't find the target!"],
  mult_5: ['Five times!'],
  mult_10: ['Ten times! What a shot!'],
  mult_20: ['Twenty times! Unbelievable!'],
  mult_35: ['Thirty-five times! Absolutely incredible!'],
}

const FILES: Record<CommentaryEvent, string[]> = {
  pre: ['pre_1', 'pre_2', 'pre_3'],
  shoot: ['shoot_1', 'shoot_2', 'shoot_3'],
  goal: ['goal_1', 'goal_2', 'goal_3'],
  save: ['save_1', 'save_2', 'save_3'],
  miss: ['miss_1', 'miss_2', 'miss_3'],
  mult_5: ['mult_5'],
  mult_10: ['mult_10'],
  mult_20: ['mult_20'],
  mult_35: ['mult_35'],
}

class PenaltyAudio {
  private settings: PenaltyAudioSettings = { ...DEFAULTS }
  private ctx: AudioContext | null = null
  private ambienceGain: GainNode | null = null
  private ambienceSrc: AudioBufferSourceNode | null = null
  private clips = new Map<string, HTMLAudioElement>()
  private current: HTMLAudioElement | null = null
  private speaking = false
  private unlocked = false

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.settings = { ...DEFAULTS, ...JSON.parse(raw) }
    } catch { /* keep defaults */ }
  }

  getSettings(): PenaltyAudioSettings {
    return { ...this.settings }
  }

  setSettings(patch: Partial<PenaltyAudioSettings>) {
    this.settings = { ...this.settings, ...patch }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)) } catch { /* ignore */ }
    if (this.ambienceGain && this.ctx) {
      this.ambienceGain.gain.value = this.settings.stadiumOn ? this.settings.stadiumVol * 0.35 : 0
    }
    if (!this.settings.stadiumOn) this.stopAmbience()
    if (!this.settings.commentaryOn) this.stopCommentary()
  }

  unlock() {
    if (this.unlocked) return
    this.unlocked = true
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctx()
      void this.ctx.resume()
    } catch { /* autoplay policies */ }
    this.preload()
  }

  preload() {
    const keys = ['shoot_1', 'shoot_2', 'shoot_3', 'goal_1', 'save_1', 'miss_1', 'pre_1']
    keys.forEach((key) => this.clipFor(key))
  }

  private clipFor(name: string): HTMLAudioElement {
    let audio = this.clips.get(name)
    if (!audio) {
      audio = new Audio(`/sounds/penalty/${name}.mp3`)
      audio.preload = 'auto'
      this.clips.set(name, audio)
    }
    return audio
  }

  stopCommentary() {
    if (this.current) {
      try { this.current.pause(); this.current.currentTime = 0 } catch { /* ignore */ }
      this.current = null
    }
    if (this.speaking) {
      try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
      this.speaking = false
    }
  }

  say(event: CommentaryEvent, delay = 0) {
    if (!this.settings.commentaryOn) return
    const run = () => {
      const idx = Math.floor(Math.random() * FILES[event].length)
      const file = FILES[event][idx]
      const text = LINES[event][idx] ?? LINES[event][0]
      this.stopCommentary()
      const audio = this.clipFor(file)
      audio.volume = Math.min(1, this.settings.commentaryVol)
      audio.currentTime = 0
      const played = audio.play()
      if (played && typeof played.then === 'function') {
        played.then(() => { this.current = audio }).catch(() => this.speak(text))
      } else {
        this.current = audio
      }
    }
    if (delay > 0) window.setTimeout(run, delay)
    else run()
  }

  private speak(text: string) {
    try {
      const synth = window.speechSynthesis
      if (!synth) return
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1.15
      utterance.pitch = 1.25
      utterance.volume = Math.min(1, this.settings.commentaryVol)
      const voices = synth.getVoices()
      const english = voices.find((voice) => /en-GB/i.test(voice.lang)) || voices.find((voice) => /^en/i.test(voice.lang))
      if (english) utterance.voice = english
      utterance.onend = () => { this.speaking = false }
      this.speaking = true
      synth.speak(utterance)
    } catch { /* ignore */ }
  }

  private noiseBuffer(seconds: number): AudioBuffer | null {
    if (!this.ctx) return null
    const len = Math.floor(this.ctx.sampleRate * seconds)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.2
    }
    return buf
  }

  startAmbience() {
    if (!this.settings.stadiumOn) return
    this.unlock()
    if (!this.ctx || this.ambienceSrc) return
    const buf = this.noiseBuffer(4)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 700
    filter.Q.value = 0.6
    const gain = this.ctx.createGain()
    gain.gain.value = this.settings.stadiumVol * 0.35
    src.connect(filter).connect(gain).connect(this.ctx.destination)
    src.start()
    this.ambienceSrc = src
    this.ambienceGain = gain
  }

  stopAmbience() {
    try { this.ambienceSrc?.stop() } catch { /* already stopped */ }
    this.ambienceSrc = null
    this.ambienceGain = null
  }

  crowd(intensity: number, duration = 2) {
    if (!this.settings.stadiumOn || !this.ctx) return
    const buf = this.noiseBuffer(duration)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 500 + intensity * 900
    filter.Q.value = 0.5
    const gain = this.ctx.createGain()
    const now = this.ctx.currentTime
    const peak = Math.max(0.001, this.settings.stadiumVol * intensity)
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + duration * 0.18)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
    src.connect(filter).connect(gain).connect(this.ctx.destination)
    src.start(now)
    src.stop(now + duration + 0.05)
  }

  crowdGroan() {
    if (!this.settings.stadiumOn || !this.ctx) return
    const buf = this.noiseBuffer(1.6)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    const now = this.ctx.currentTime
    filter.frequency.setValueAtTime(700, now)
    filter.frequency.exponentialRampToValueAtTime(180, now + 1.4)
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, this.settings.stadiumVol * 0.7), now + 0.2)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.6)
    src.connect(filter).connect(gain).connect(this.ctx.destination)
    src.start(now)
    src.stop(now + 1.7)
  }

  private thud(freq: number, duration: number, type: OscillatorType, vol: number) {
    if (!this.settings.effectsOn || !this.ctx) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    const now = this.ctx.currentTime
    osc.type = type
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.25), now + duration)
    gain.gain.setValueAtTime(Math.max(0.001, vol * this.settings.effectsVol), now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
    osc.connect(gain).connect(this.ctx.destination)
    osc.start(now)
    osc.stop(now + duration + 0.02)
  }

  private burst(duration: number, freq: number, vol: number) {
    if (!this.settings.effectsOn || !this.ctx) return
    const buf = this.noiseBuffer(duration)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = freq
    const gain = this.ctx.createGain()
    const now = this.ctx.currentTime
    gain.gain.setValueAtTime(Math.max(0.001, vol * this.settings.effectsVol), now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
    src.connect(filter).connect(gain).connect(this.ctx.destination)
    src.start(now)
    src.stop(now + duration + 0.02)
  }

  kick() { this.unlock(); this.thud(180, 0.16, 'sine', 0.9); this.burst(0.08, 1800, 0.35) }
  net() { this.burst(0.4, 900, 0.45); this.thud(120, 0.25, 'triangle', 0.4) }
  keeperSave() { this.thud(150, 0.2, 'square', 0.5); this.burst(0.18, 1200, 0.4) }

  stopAll() {
    this.stopCommentary()
    this.stopAmbience()
  }
}

export const penaltyAudio = new PenaltyAudio()
