import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import heightmapUrl from './assets/heightmap.png';
import groundTexUrl from './assets/ground_color.jpg';
import rockTexUrl from './assets/rock_color.jpg';

// ---------------------------------------------------------------------------
// AUDIO SYSTEM (Procedural Atmosphere & Effects)
// ---------------------------------------------------------------------------
class SoundEffects {
  constructor() {
    this.ctx = null;
    this.noiseBuffer = null;
    this.windGain = null;
    this.windFilter = null;
    this.creekGain = null;
    this.creekFilter = null;
    this.genOsc = null;
    this.genGain = null;
    this.lastBirdTime = 0;
    this.lastOwlTime = 0;
    this.lastWolfTime = 0;
    this.titleWindGain = null;
    this.titleWindFilter = null;
    this.titleWindSource = null;
    this.titleDroneGain = null;
    this.titleDroneOscs = [];
    this.titleCrackleTimeout = null;
    this.titleWolfInterval = null;
    this.isTitlePlaying = false;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.initAmbient();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  initAmbient() {
    if (!this.ctx) return;
    try {
      // 2 seconds looping pink/white noise buffer for wind and water
      const bufferSize = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        data[i] = (b0 + b1 + b2 + white * 0.5362) * 0.11;
      }

      // 1. Continuous Alpine Wind Channel
      const windSource = this.ctx.createBufferSource();
      windSource.buffer = this.noiseBuffer;
      windSource.loop = true;
      this.windFilter = this.ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.setValueAtTime(260, this.ctx.currentTime);
      this.windGain = this.ctx.createGain();
      this.windGain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      windSource.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.ctx.destination);
      windSource.start();

      // 2. Continuous River Creek / Rapids Channel
      const creekSource = this.ctx.createBufferSource();
      creekSource.buffer = this.noiseBuffer;
      creekSource.loop = true;
      this.creekFilter = this.ctx.createBiquadFilter();
      this.creekFilter.type = 'bandpass';
      this.creekFilter.frequency.setValueAtTime(420, this.ctx.currentTime);
      this.creekFilter.Q.setValueAtTime(1.8, this.ctx.currentTime);
      this.creekGain = this.ctx.createGain();
      this.creekGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      creekSource.connect(this.creekFilter);
      this.creekFilter.connect(this.creekGain);
      this.creekGain.connect(this.ctx.destination);
      creekSource.start();
    } catch (e) {
      console.warn('Ambient audio init warning:', e);
    }
  }

  updateAmbient(playerPos, altitude, timeOfDay) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Wind volume & frequency scales with altitude (peaks on ridges, muffles in valley)
    if (this.windGain && this.windFilter) {
      const targetGain = Math.min(0.25, Math.max(0.05, 0.06 + (altitude - 8) * 0.004));
      const targetFreq = Math.min(750, Math.max(200, 220 + altitude * 9));
      this.windGain.gain.setTargetAtTime(targetGain, now, 0.5);
      this.windFilter.frequency.setTargetAtTime(targetFreq, now, 0.5);
    }

    // Creek / River sound (loudest near river line: x in [-35, -15], z in [10, 50])
    if (this.creekGain) {
      const distToRiver = Math.hypot(playerPos.x - (-25), playerPos.z - 25);
      const creekTarget = Math.max(0.001, Math.min(0.24, (1.0 - distToRiver / 60) * 0.24));
      this.creekGain.gain.setTargetAtTime(creekTarget, now, 0.35);
    }

    // Camp Generator Hum (proportional to distance when fixed)
    if (this.genGain) {
      const distToGen = Math.hypot(playerPos.x - (-70), playerPos.z - (-235));
      const genTarget = Math.max(0.001, Math.min(0.22, (1.0 - distToGen / 45) * 0.22));
      this.genGain.gain.setTargetAtTime(genTarget, now, 0.3);
    }

    // Day & Night Wildlife Audio Triggers
    const isNight = timeOfDay < 6 || timeOfDay > 18;
    const realNow = performance.now();
    if (!isNight) {
      if (realNow - this.lastBirdTime > 6500 + Math.random() * 6000) {
        this.playBirdChirp();
        this.lastBirdTime = realNow;
      }
    } else {
      if (realNow - this.lastOwlTime > 12000 + Math.random() * 8000) {
        this.playOwlHoot();
        this.lastOwlTime = realNow;
      }
      if (realNow - this.lastWolfTime > 24000 + Math.random() * 12000) {
        this.playWolfHowl();
        this.lastWolfTime = realNow;
      }
    }
  }

  startGeneratorHum() {
    if (!this.ctx || this.genOsc) return;
    try {
      this.genOsc = this.ctx.createOscillator();
      this.genOsc.type = 'sawtooth';
      this.genOsc.frequency.setValueAtTime(58, this.ctx.currentTime);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(170, this.ctx.currentTime);
      this.genGain = this.ctx.createGain();
      this.genGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      this.genOsc.connect(filter);
      filter.connect(this.genGain);
      this.genGain.connect(this.ctx.destination);
      this.genOsc.start();
    } catch (e) {
      console.warn('Gen hum start:', e);
    }
  }

  playBirdChirp() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    const t0 = this.ctx.currentTime;
    osc.frequency.setValueAtTime(2800 + Math.random() * 500, t0);
    osc.frequency.exponentialRampToValueAtTime(3700, t0 + 0.05);
    osc.frequency.exponentialRampToValueAtTime(2400, t0 + 0.11);
    gain.gain.setValueAtTime(0.06, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.11);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  }

  playOwlHoot() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    [0, 0.32].forEach((offset, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      const freq = idx === 0 ? 370 : 330;
      osc.frequency.setValueAtTime(freq, t0 + offset);
      osc.frequency.linearRampToValueAtTime(freq - 25, t0 + offset + 0.22);
      gain.gain.setValueAtTime(0.001, t0 + offset);
      gain.gain.linearRampToValueAtTime(0.07, t0 + offset + 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.24);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.25);
    });
  }

  startTitleAmbience() {
    if (this.isTitlePlaying) return;
    this.init();
    if (!this.ctx) return;
    this.isTitlePlaying = true;

    try {
      // 1. Alpine Mountain Wind Ambience for Title Screen
      if (this.noiseBuffer && !this.titleWindGain) {
        const titleWindSource = this.ctx.createBufferSource();
        titleWindSource.buffer = this.noiseBuffer;
        titleWindSource.loop = true;
        this.titleWindFilter = this.ctx.createBiquadFilter();
        this.titleWindFilter.type = 'lowpass';
        this.titleWindFilter.frequency.setValueAtTime(260, this.ctx.currentTime);
        this.titleWindGain = this.ctx.createGain();
        this.titleWindGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
        this.titleWindGain.gain.exponentialRampToValueAtTime(0.12, this.ctx.currentTime + 2.5);
        titleWindSource.connect(this.titleWindFilter);
        this.titleWindFilter.connect(this.titleWindGain);
        this.titleWindGain.connect(this.ctx.destination);
        titleWindSource.start();
        this.titleWindSource = titleWindSource;
      }

      // 2. Cinematic Atmospheric Minor Chord Drone (D minor: D2 73.4Hz, A2 110Hz, F3 174.6Hz)
      const freqs = [73.4, 110.0, 174.6];
      this.titleDroneGain = this.ctx.createGain();
      this.titleDroneGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      this.titleDroneGain.gain.linearRampToValueAtTime(0.055, this.ctx.currentTime + 3.0);
      const droneFilter = this.ctx.createBiquadFilter();
      droneFilter.type = 'lowpass';
      droneFilter.frequency.setValueAtTime(220, this.ctx.currentTime);
      this.titleDroneGain.connect(droneFilter);
      droneFilter.connect(this.ctx.destination);

      this.titleDroneOscs = freqs.map((f, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = i === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(f, this.ctx.currentTime);
        osc.connect(this.titleDroneGain);
        osc.start();
        return osc;
      });

      // 3. Realistic Campfire Crackle & Ember Pops
      const triggerCrackle = () => {
        if (!this.isTitlePlaying || !this.ctx) return;
        this.playFireCrackle(Math.random() < 0.25 ? 0.08 : 0.035);
        const nextDelay = 80 + Math.random() * 220;
        this.titleCrackleTimeout = setTimeout(triggerCrackle, nextDelay);
      };
      triggerCrackle();

      // 4. Distant Alpine Wolf Howl
      setTimeout(() => {
        if (this.isTitlePlaying) this.playWolfHowl(0.07);
      }, 3000);

      this.titleWolfInterval = setInterval(() => {
        if (this.isTitlePlaying) this.playWolfHowl(0.065 + Math.random() * 0.03);
      }, 18000);
    } catch (e) {
      console.warn('Title ambience error:', e);
    }
  }

  playFireCrackle(vol = 0.04) {
    if (!this.ctx) return;
    try {
      const bufferSize = Math.floor(this.ctx.sampleRate * (0.015 + Math.random() * 0.025));
      const popBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = popBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
      }
      const popSrc = this.ctx.createBufferSource();
      popSrc.buffer = popBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(1400 + Math.random() * 1200, this.ctx.currentTime);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.035);
      popSrc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      popSrc.start();
    } catch (e) {}
  }

  stopTitleAmbience() {
    if (!this.isTitlePlaying) return;
    this.isTitlePlaying = false;
    clearTimeout(this.titleCrackleTimeout);
    clearInterval(this.titleWolfInterval);

    if (this.ctx && this.titleDroneGain) {
      try {
        this.titleDroneGain.gain.setValueAtTime(this.titleDroneGain.gain.value, this.ctx.currentTime);
        this.titleDroneGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.2);
        setTimeout(() => {
          this.titleDroneOscs.forEach(o => { try { o.stop(); o.disconnect(); } catch (e) {} });
          this.titleDroneOscs = [];
        }, 1300);
      } catch (e) {}
    }

    if (this.ctx && this.titleWindGain) {
      try {
        this.titleWindGain.gain.setValueAtTime(this.titleWindGain.gain.value, this.ctx.currentTime);
        this.titleWindGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.2);
        setTimeout(() => {
          if (this.titleWindSource) {
            try { this.titleWindSource.stop(); this.titleWindSource.disconnect(); } catch (e) {}
            this.titleWindSource = null;
          }
          this.titleWindGain = null;
        }, 1300);
      } catch (e) {}
    }
  }

  playWolfHowl(vol = 0.08) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(450, this.ctx.currentTime);
    filter.Q.setValueAtTime(3.0, this.ctx.currentTime);
    osc.type = 'sawtooth';
    const t0 = this.ctx.currentTime;
    osc.frequency.setValueAtTime(220, t0);
    osc.frequency.exponentialRampToValueAtTime(480, t0 + 1.2);
    osc.frequency.exponentialRampToValueAtTime(320, t0 + 2.8);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.8);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 2.9);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 3.0);
  }

  playWaterSplash() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, this.ctx.currentTime);
    osc.type = 'triangle';
    const t0 = this.ctx.currentTime;
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.16);
    gain.gain.setValueAtTime(0.12, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.17);
  }

  playFootstep() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(70 + Math.random() * 30, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(25, this.ctx.currentTime + 0.1);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, this.ctx.currentTime);

    gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  }

  playTorchIgnite() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(320, this.ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.25);
  }

  playPickup() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, this.ctx.currentTime);
    osc.frequency.setValueAtTime(780, this.ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.2);
  }

  playAttack() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(250, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.18, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.18);
  }

  playBeaconVictory() {
    if (!this.ctx) return;
    const notes = [261.63, 329.63, 392.00, 523.25, 659.25];
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime + i * 0.12);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + i * 0.12 + 0.9);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(this.ctx.currentTime + i * 0.12);
      osc.stop(this.ctx.currentTime + i * 0.12 + 0.9);
    });
  }

  playJump() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(340, this.ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.14);
  }

  playHardLanding() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(28, this.ctx.currentTime + 0.35);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(260, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.35, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.35);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.35);
  }

  playRadioStatic(duration = 2.5) {
    if (!this.ctx || !this.noiseBuffer) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1400, this.ctx.currentTime);
      filter.Q.setValueAtTime(2.5, this.ctx.currentTime);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.09, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      src.start();
      src.stop(this.ctx.currentTime + duration);

      // Squelch intro beep
      const beep = this.ctx.createOscillator();
      const bGain = this.ctx.createGain();
      beep.frequency.setValueAtTime(1050, this.ctx.currentTime);
      bGain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      bGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.12);
      beep.connect(bGain);
      bGain.connect(this.ctx.destination);
      beep.start();
      beep.stop(this.ctx.currentTime + 0.12);
    } catch (e) {
      console.warn('Radio static error:', e);
    }
  }

  playRadioSpeech(text = "Winter storm is coming. All villagers, move out now.") {
    this.playRadioStatic(3.5);
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 0.92;
        utter.pitch = 0.88;
        utter.volume = 1.0;
        const voices = window.speechSynthesis.getVoices();
        const en = voices.find(v => v.lang.startsWith('en'));
        if (en) utter.voice = en;
        window.speechSynthesis.speak(utter);
      } catch (e) {
        console.warn('Speech synthesis error:', e);
      }
    }
  }

  playRockslideRumble() {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(65, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(22, this.ctx.currentTime + 2.2);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(140, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.45, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 2.2);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 2.2);
    } catch (e) {}
  }

  playDrawbridgeLower() {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, this.ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(45, this.ctx.currentTime + 1.8);
      gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.8);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 1.8);
    } catch (e) {}
  }

  playHelicopterRotor() {
    if (!this.ctx || this.heliOsc) return;
    try {
      this.heliOsc = this.ctx.createOscillator();
      this.heliGain = this.ctx.createGain();
      this.heliFilter = this.ctx.createBiquadFilter();

      this.heliOsc.type = 'sawtooth';
      this.heliOsc.frequency.setValueAtTime(38, this.ctx.currentTime); // Low engine fundamental

      this.heliFilter.type = 'lowpass';
      this.heliFilter.frequency.setValueAtTime(220, this.ctx.currentTime);

      this.heliGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      this.heliGain.gain.linearRampToValueAtTime(0.28, this.ctx.currentTime + 2.0);

      this.heliOsc.connect(this.heliFilter);
      this.heliFilter.connect(this.heliGain);
      this.heliGain.connect(this.ctx.destination);

      this.heliOsc.start();
    } catch (e) {
      console.warn('Helicopter audio error:', e);
    }
  }

  stopHelicopterRotor() {
    if (this.ctx && this.heliGain) {
      try {
        this.heliGain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 1.5);
        setTimeout(() => {
          if (this.heliOsc) {
            this.heliOsc.stop();
            this.heliOsc.disconnect();
            this.heliOsc = null;
          }
        }, 1600);
      } catch (e) {}
    }
  }
}

// ---------------------------------------------------------------------------
// 2D PERLIN NOISE & FBM (Continuous, Deterministic Mountain Heightfield)
// ---------------------------------------------------------------------------
const NOISE_PERM = [
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
  8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,
  35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,
  134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,
  55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,
  18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,
  250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,
  189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
  228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,
  107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180
];
const P_NOISE = new Uint8Array(512);
for (let i = 0; i < 256; i++) {
  P_NOISE[i] = NOISE_PERM[i];
  P_NOISE[i + 256] = NOISE_PERM[i];
}

function noiseFade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function noiseLerp(a, b, t) { return a + t * (b - a); }
function noiseGrad(hash, x, y) {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function perlin2D(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = noiseFade(xf);
  const v = noiseFade(yf);
  const aa = P_NOISE[P_NOISE[X] + Y];
  const ab = P_NOISE[P_NOISE[X] + Y + 1];
  const ba = P_NOISE[P_NOISE[X + 1] + Y];
  const bb = P_NOISE[P_NOISE[X + 1] + Y + 1];
  return noiseLerp(
    noiseLerp(noiseGrad(aa, xf, yf), noiseGrad(ba, xf - 1, yf), u),
    noiseLerp(noiseGrad(ab, xf, yf - 1), noiseGrad(bb, xf - 1, yf - 1), u),
    v
  );
}

function fbm2D(x, y, octaves = 5) {
  let total = 0;
  let freq = 1;
  let amp = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    total += perlin2D(x * freq, y * freq) * amp;
    maxAmp += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return total / maxAmp;
}

// ---------------------------------------------------------------------------
// 512x512 GRAYSCALE HEIGHTMAP & BILINEAR SAMPLER (WITH MULTI-OCTAVE NOISE FALLBACK)
// ---------------------------------------------------------------------------
let heightmapPixels = null;
let heightmapLoaded = false;

function sampleMultiOctaveNoise(x, z) {
  // Multi-octave simplex/perlin noise fallback
  let total = 0;
  let freq = 0.0035;
  let amp = 26.0;
  for (let o = 0; o < 5; o++) {
    total += perlin2D(x * freq, z * freq) * amp;
    freq *= 2.05;
    amp *= 0.48;
  }
  return total;
}

function sampleHeightmapBilinear(x, z) {
  if (!heightmapPixels) {
    return sampleMultiOctaveNoise(x, z);
  }
  // World bounds [-600, 600] mapped to [0, 1] UV
  const u = Math.max(0, Math.min(1, (x + 600) / 1200));
  const v = Math.max(0, Math.min(1, (z + 600) / 1200));

  const fx = u * 511;
  const fz = v * 511;
  const x0 = Math.floor(fx);
  const x1 = Math.min(511, x0 + 1);
  const z0 = Math.floor(fz);
  const z1 = Math.min(511, z0 + 1);

  const tx = fx - x0;
  const tz = fz - z0;

  const h00 = heightmapPixels[z0 * 512 + x0];
  const h10 = heightmapPixels[z0 * 512 + x1];
  const h01 = heightmapPixels[z1 * 512 + x0];
  const h11 = heightmapPixels[z1 * 512 + x1];

  const hTop = h00 * (1 - tx) + h10 * tx;
  const hBot = h01 * (1 - tx) + h11 * tx;
  const val = hTop * (1 - tz) + hBot * tz;

  // Map 0..1 grayscale to altitude (-8m valley up to +38m peaks)
  return val * 46.0 - 8.0;
}

function initHeightmap(onLoaded) {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 512, 512);
      const imgData = ctx.getImageData(0, 0, 512, 512);
      heightmapPixels = new Float32Array(512 * 512);
      for (let i = 0; i < 512 * 512; i++) {
        heightmapPixels[i] = imgData.data[i * 4] / 255.0;
      }
      heightmapLoaded = true;
      if (onLoaded) onLoaded();
      if (window.gameInstance) {
        window.gameInstance.rebuildTerrainMesh();
      }
    } catch (e) {
      console.warn('Heightmap decode error, falling back to multi-octave noise:', e);
    }
  };
  img.onerror = () => {
    console.warn('Heightmap image missing or load failed, using multi-octave noise fallback');
  };
  img.src = heightmapUrl;
}

initHeightmap();

// ---------------------------------------------------------------------------
// ROAD PATH DEFINITION (1728m Winding Route Connecting 5 Distinct Zones)
// ---------------------------------------------------------------------------
const ROAD_WAYPOINTS = [
  // Zone 1: Crash Site & Rockslide (z: 520 -> 380)
  new THREE.Vector3(-180, 0, 520),    // 0: Crashed Truck
  new THREE.Vector3(-120, 3, 440),    // 1: Rockslide Debris Field
  new THREE.Vector3(-60, 6, 380),     // 2: Flare Mast & Forest Gate

  // Zone 2: Dense Pine Forest & Meadows (z: 380 -> 140)
  new THREE.Vector3(40, 9, 330),      // 3: Pine Forest Entry
  new THREE.Vector3(160, 11, 290),    // 4: Watchtower Clearing
  new THREE.Vector3(240, 13, 210),    // 5: Whispering Meadow Curve
  new THREE.Vector3(180, 14, 140),    // 6: Meadow Descent

  // Zone 3: Frozen River Valley, Bridge & Lake (z: 140 -> -100)
  new THREE.Vector3(80, 12, 80),      // 7: Glacial Valley Entry
  new THREE.Vector3(-20, 10, 20),     // 8: Wooden River Bridge Crossing
  new THREE.Vector3(-120, 11, -40),   // 9: West Lake Shoreline
  new THREE.Vector3(-180, 13, -100),  // 10: Hunter Camp Approach

  // Zone 4: Hunter Camp & Workshop (z: -100 -> -320)
  new THREE.Vector3(-140, 16, -180),  // 11: Camp Workshop Perimeter
  new THREE.Vector3(-60, 18, -240),   // 12: Hunter Cabin Clearing
  new THREE.Vector3(40, 21, -280),    // 13: Windmill Ridge Pass
  new THREE.Vector3(120, 24, -340),   // 14: Crag Canyon Entry

  // Zone 5: Khai Ridge & Tower Peak (z: -340 -> -560)
  new THREE.Vector3(90, 27, -420),    // 15: Khai Cliff Ledge Road
  new THREE.Vector3(40, 30, -490),    // 16: Glacial Summit Ascent
  new THREE.Vector3(0, 34, -560)      // 17: Radio Tower & Beacon Summit Peak
];

const RoadCurve = new THREE.CatmullRomCurve3(ROAD_WAYPOINTS);

// ---------------------------------------------------------------------------
// 800-POINT ROAD CURVE SAMPLING & CONTINUOUS SIGNED DISTANCE QUERY
// ---------------------------------------------------------------------------
const ROAD_SAMPLES_COUNT = 800;
const ROAD_SAMPLES = [];
const ROAD_SEGMENTS = [];

for (let i = 0; i < ROAD_SAMPLES_COUNT; i++) {
  const t = i / (ROAD_SAMPLES_COUNT - 1);
  const pt = RoadCurve.getPoint(t);
  ROAD_SAMPLES.push(pt);
}

for (let i = 0; i < ROAD_SAMPLES_COUNT - 1; i++) {
  const a = ROAD_SAMPLES[i];
  const b = ROAD_SAMPLES[i + 1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dz * dz;
  const len = Math.sqrt(lenSq) || 0.0001;
  const tx = dx / len;
  const tz = dz / len;
  // Left unit normal in horizontal XZ plane: (tz, -tx)
  const lx = tz;
  const lz = -tx;
  ROAD_SEGMENTS.push({ a, b, dx, dz, dy, lenSq, len, tx, tz, lx, lz });
}

function getRoadSignedDistance(x, z) {
  // Step 1: Coarse check every 10 samples
  let bestDistSq = Infinity;
  let bestIdx = 0;
  for (let k = 0; k < ROAD_SAMPLES_COUNT; k += 10) {
    const s = ROAD_SAMPLES[k];
    const dSq = (x - s.x) * (x - s.x) + (z - s.z) * (z - s.z);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = k;
    }
  }

  // Step 2: Fine segment projection in local window (+-20 segments)
  const startSeg = Math.max(0, bestIdx - 20);
  const endSeg = Math.min(ROAD_SEGMENTS.length - 1, bestIdx + 20);
  let minSegDistSq = Infinity;
  let bestPx = 0, bestPz = 0, bestPy = 0;
  let bestTx = 0, bestTz = -1, bestLx = -1, bestLz = 0;

  for (let s = startSeg; s <= endSeg; s++) {
    const seg = ROAD_SEGMENTS[s];
    const u = Math.max(0, Math.min(1, ((x - seg.a.x) * seg.dx + (z - seg.a.z) * seg.dz) / seg.lenSq));
    const px = seg.a.x + u * seg.dx;
    const pz = seg.a.z + u * seg.dz;
    const dSq = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (dSq < minSegDistSq) {
      minSegDistSq = dSq;
      bestPx = px;
      bestPz = pz;
      bestPy = seg.a.y + u * seg.dy;
      bestTx = seg.tx;
      bestTz = seg.tz;
      bestLx = seg.lx;
      bestLz = seg.lz;
    }
  }

  const vx = x - bestPx;
  const vz = z - bestPz;
  const signedDist = vx * bestLx + vz * bestLz;
  const roadDist = Math.sqrt(minSegDistSq);

  return {
    signedDist,
    roadDist,
    projX: bestPx,
    projY: bestPy,
    projZ: bestPz,
    tx: bestTx,
    tz: bestTz,
    lx: bestLx,
    lz: bestLz
  };
}

// ---------------------------------------------------------------------------
// HEIGHT + SLOPE TERRAIN SPLATTING (Grass, Dark Soil, Rock, Light High-Altitude Snow)
// ---------------------------------------------------------------------------
function getTerrainSlope(x, z) {
  const eps = 0.6;
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);
  const dhdx = (hR - hL) / (2 * eps);
  const dhdz = (hU - hD) / (2 * eps);
  return Math.hypot(dhdx, dhdz);
}

function getZoneGroundColor(x, z, y) {
  if (y === undefined) y = getTerrainHeight(x, z);

  // 1. Local Slope Estimation (0 = flat, 0.4 = ~22 deg, 0.8 = ~39 deg, > 1.1 = cliff)
  const slope = getTerrainSlope(x, z);

  // 2. Base Layer: Lush Alpine Grass, Forest Moss & Meadow Turf
  let r = 0.28;
  let g = 0.39;
  let b = 0.20;

  // Road signed distance query for trail/road soil splatting
  const road = getRoadSignedDistance(x, z);
  const absSignedDist = Math.abs(road.signedDist);

  // Zone-specific Base Turf / Soil variations
  if (z > 350) {
    // Zone 1: Crash site / lower valley damp rocky soil and alpine moss
    r = 0.30; g = 0.33; b = 0.24;
  } else if (z > 140) {
    // Zone 2: Dense pine forest & whispering golden meadow
    if (x > 30 && x < 130 && z > 190 && z < 290) {
      // Golden meadow clearing
      r = 0.42; g = 0.50; b = 0.22;
    } else {
      // Deep pine forest moss
      r = 0.24; g = 0.38; b = 0.18;
    }
  } else if (z > -100) {
    // Zone 3: River valley & lake shore silt / cold alpine turf
    const lakeDist = Math.hypot(x - (-35), z - 40);
    if (lakeDist < 65) {
      // Lake bed cold slate silt
      r = 0.20; g = 0.28; b = 0.30;
    } else {
      r = 0.27; g = 0.35; b = 0.24;
    }
  } else if (z > -320) {
    // Zone 4: Hunter camp workshop ground - dark soil, pine needles, sawdust
    const campDist = Math.hypot(x - (-70), z - (-235));
    if (campDist < 45) {
      r = 0.36; g = 0.28; b = 0.19; // Mud & sawdust
    } else {
      r = 0.26; g = 0.33; b = 0.20;
    }
  } else {
    // Zone 5: Khai ridge alpine tundra turf
    r = 0.28; g = 0.32; b = 0.25;
  }

  // 3. Road Surface & Trail Soil Splat
  if (absSignedDist < 2.3) {
    // Road center: dark packed gravel & soil
    const soilR = 0.24, soilG = 0.18, soilB = 0.13;
    r = soilR; g = soilG; b = soilB;
  } else if (absSignedDist < 3.8) {
    // Road shoulder blend into turf
    const t = (absSignedDist - 2.3) / 1.5;
    const soilR = 0.24, soilG = 0.18, soilB = 0.13;
    r = soilR * (1 - t) + r * t;
    g = soilG * (1 - t) + g * t;
    b = soilB * (1 - t) + b * t;
  }

  // 4. Slope Splat: Rock / Dark Slate / Mountain Granite
  // Moderate slopes (> 0.32) start showing rock; steep slopes and cliffs (> 0.74) are solid rock
  if (slope > 0.32) {
    const rockT = Math.min(1.0, (slope - 0.32) / 0.42);
    // Dark slate rock / granite crags
    let rockR = 0.29, rockG = 0.31, rockB = 0.33;
    // Extra dark granite for sheer cliffs or canyon drops (pahar / khai)
    if (slope > 0.85) {
      rockR = 0.21; rockG = 0.22; rockB = 0.24;
    }
    // Micro variation in rock shade via 2D noise
    const rockVar = perlin2D(x * 0.05, z * 0.05) * 0.04;
    rockR = Math.max(0.12, rockR + rockVar);
    rockG = Math.max(0.12, rockG + rockVar);
    rockB = Math.max(0.14, rockB + rockVar);

    r = r * (1 - rockT) + rockR * rockT;
    g = g * (1 - rockT) + rockG * rockT;
    b = b * (1 - rockT) + rockB * rockT;
  }

  // 5. LIGHT Snow Patches ONLY Above Altitude (y > 27m)
  // Wind-sculpted light snow patches on high mountain crests, leaving rock crags exposed
  if (y > 27.0) {
    const altFactor = Math.min(1.0, (y - 27.0) / 12.0); // 0 at 27m, 1 at 39m
    const patchNoise = perlin2D(x * 0.045, z * 0.045);
    // Snow only settles on gentler ledges (slope < 0.48)
    if (patchNoise > 0.18 && slope < 0.48) {
      const slopeFactor = 1.0 - slope / 0.48;
      const snowIntensity = Math.min(0.78, (patchNoise - 0.18) * 1.6 * altFactor * slopeFactor);
      const snowR = 0.84, snowG = 0.88, snowB = 0.94;
      r = r * (1 - snowIntensity) + snowR * snowIntensity;
      g = g * (1 - snowIntensity) + snowG * snowIntensity;
      b = b * (1 - snowIntensity) + snowB * snowIntensity;
    }
  }

  return [r, g, b];
}

// ---------------------------------------------------------------------------
// ONE MASTER ANALYTIC TERRAIN HEIGHT FUNCTION: getTerrainHeight(x, z)
// ---------------------------------------------------------------------------
function getTerrainHeight(x, z) {
  const baseTerrainY = sampleHeightmapBilinear(x, z);
  const road = getRoadSignedDistance(x, z);
  const s = road.signedDist;
  const py = road.projY;

  let corridorY = py;

  // ROAD SURFACE: Flat carved mountain road (width 4.4m, half-width 2.2m)
  if (Math.abs(s) <= 2.2) {
    corridorY = py;
  }
  // PAHAR (STEEP ROCK SLOPE) ALWAYS ON THE LEFT OF THE ROAD TANGENT (s > 2.2m)
  else if (s > 2.2) {
    if (s <= 3.8) {
      const shoulderT = (s - 2.2) / 1.6;
      corridorY = py + shoulderT * shoulderT * 0.8;
    } else {
      const cliffDist = s - 3.8;
      const rockRise = Math.min(38.0, Math.pow(cliffDist * 0.75, 1.25) * 2.4 + 0.8);
      const crag = perlin2D(x * 0.08, z * 0.08) * 1.8;
      corridorY = py + rockRise + crag;
    }
  }
  // KHAI (RAVINE, ~20M DEEP) ALWAYS ON THE RIGHT WITH 2-3M GENTLE LEDGE BEFORE THE DROP (s < -2.2m)
  else {
    const rightDist = -s;
    if (rightDist <= 4.8) {
      const ledgeT = (rightDist - 2.2) / 2.6;
      corridorY = py - ledgeT * 0.35;
    } else {
      const dropDist = rightDist - 4.8;

      // Hidden return route switchback: carved along canyon wall near z in [-490, -420]
      const isSwitchbackZone = z < -420 && z > -490 && rightDist >= 4.8 && rightDist <= 16.0;
      if (isSwitchbackZone) {
        const rampT = Math.max(0, Math.min(1.0, (-420 - z) / 70.0));
        const rampY = (py - 20.35) + (1.0 - rampT) * 20.0;
        corridorY = Math.max(rampY, py - 20.35);
      } else if (dropDist < 12.0) {
        const dropT = dropDist / 12.0;
        const plunge = (dropT * dropT * (3.0 - 2.0 * dropT)) * 20.0;
        corridorY = py - 0.35 - plunge;
      } else {
        const canyonDist = dropDist - 12.0;
        const floorDepth = 20.35;
        const canyonNoise = perlin2D(x * 0.05, z * 0.05) * 1.6;
        if (canyonDist < 18.0) {
          corridorY = py - floorDepth + canyonNoise;
        } else {
          const climbDist = canyonDist - 18.0;
          const climb = Math.min(26.0, Math.pow(climbDist * 0.4, 1.25) * 1.6);
          corridorY = py - floorDepth + canyonNoise + climb;
        }
      }
    }
  }

  // ZONE 1: Starting Landslide rock barrier behind crashed vehicle (z > 560)
  if (z > 560) {
    corridorY += Math.min(26.0, Math.pow((z - 560) * 0.85, 1.3));
  }

  // ZONE 2: Flat Whispering Meadow Clearing (smooth walking surface for alternate trail)
  if (z > 190 && z < 290 && x > 30 && x < 130) {
    const meadowDist = Math.hypot(x - 80, z - 240);
    if (meadowDist < 48) {
      const meadowWeight = Math.max(0, 1.0 - meadowDist / 48);
      const flatMeadowY = 10.2 + perlin2D(x * 0.04, z * 0.04) * 0.6;
      corridorY = corridorY * (1.0 - meadowWeight * 0.75) + flatMeadowY * (meadowWeight * 0.75);
    }
  }

  // ZONE 3: Glacial Lake Basin & River Gorge (drops down 4.5m below road for frozen lake ice)
  const lakeDist = Math.hypot(x - (-35), z - 40);
  if (lakeDist < 65) {
    const lakeWeight = Math.max(0, 1.0 - lakeDist / 65);
    const lakeFloorY = 4.8 + perlin2D(x * 0.03, z * 0.03) * 0.4;
    // Don't carve the road bridge path itself if roadDist < 4.0
    if (road.roadDist > 4.0) {
      corridorY = corridorY * (1.0 - lakeWeight * 0.85) + lakeFloorY * (lakeWeight * 0.85);
    }
  }

  // ZONE 4: Hunter Camp Clearing Plateau (smooth terrain around cabin & workshop)
  const campDist = Math.hypot(x - (-70), z - (-235));
  if (campDist < 45) {
    const campWeight = Math.max(0, 1.0 - campDist / 45);
    const campPlateauY = 18.0 + perlin2D(x * 0.04, z * 0.04) * 0.5;
    corridorY = corridorY * (1.0 - campWeight * 0.7) + campPlateauY * (campWeight * 0.7);
  }

  // ZONE 5: Radio Beacon Outpost Peak Summit (near x=0, z=-560)
  const summitDist = Math.hypot(x - 0, z - (-560));
  if (summitDist < 25.0) {
    const summitWeight = Math.max(0, 1.0 - summitDist / 25.0);
    const plateauY = 34.5 + (1.0 - summitDist / 25.0) * 1.2;
    corridorY = corridorY * (1.0 - summitWeight) + plateauY * summitWeight;
  }

  // Smooth blend between road corridor and base heightmap terrain
  const blendT = Math.max(0, Math.min(1, (road.roadDist - 36) / 36));
  const smoothBlend = blendT * blendT * (3 - 2 * blendT);

  return corridorY * (1.0 - smoothBlend) + baseTerrainY * smoothBlend;
}

// ---------------------------------------------------------------------------
// PROCEDURAL TEXTURE GENERATORS (God-Rays Sun Corona & Soft Snowflake Particles)
// ---------------------------------------------------------------------------
function createSunCoronaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const cx = 256, cy = 256;

  // Multi-stop soft golden radial glow
  const grad = ctx.createRadialGradient(cx, cy, 14, cx, cy, 256);
  grad.addColorStop(0.0, 'rgba(255, 255, 240, 1.0)');
  grad.addColorStop(0.12, 'rgba(255, 215, 120, 0.9)');
  grad.addColorStop(0.32, 'rgba(255, 140, 45, 0.55)');
  grad.addColorStop(0.65, 'rgba(255, 90, 20, 0.22)');
  grad.addColorStop(1.0, 'rgba(255, 60, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  // Soft god-rays crepuscular spokes
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    const rayLen = 252;
    const rayWidth = 0.065 + (i % 2) * 0.035;
    ctx.fillStyle = 'rgba(255, 185, 75, 0.26)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, rayLen, angle - rayWidth, angle + rayWidth);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  return new THREE.CanvasTexture(canvas);
}

function createSnowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.25)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// CINEMATIC POST-PROCESSING SHADER (SSAO Contact Occlusion, ACES Tone Mapping, Vignette)
// ---------------------------------------------------------------------------
const CinematicPostShader = {
  name: 'CinematicPostShader',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uTime: { value: 0 },
    vignetteStrength: { value: 0.35 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float uTime;
    uniform float vignetteStrength;
    varying vec2 vUv;

    void main() {
      vec4 baseColor = texture2D(tDiffuse, vUv);
      vec3 color = baseColor.rgb;

      // 1. Subtle SSAO / Edge Contact Occlusion Approximation
      vec2 texel = 1.0 / resolution;
      vec3 cN = texture2D(tDiffuse, vUv + vec2(0.0, texel.y) * 1.5).rgb;
      vec3 cS = texture2D(tDiffuse, vUv - vec2(0.0, texel.y) * 1.5).rgb;
      vec3 cE = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0) * 1.5).rgb;
      vec3 cW = texture2D(tDiffuse, vUv - vec2(texel.x, 0.0) * 1.5).rgb;
      float lC = dot(color, vec3(0.299, 0.587, 0.114));
      float lN = dot(cN, vec3(0.299, 0.587, 0.114));
      float lS = dot(cS, vec3(0.299, 0.587, 0.114));
      float lE = dot(cE, vec3(0.299, 0.587, 0.114));
      float lW = dot(cW, vec3(0.299, 0.587, 0.114));
      float edgeDiff = abs(lC - lN) + abs(lC - lS) + abs(lC - lE) + abs(lC - lW);
      float contactOcc = clamp(edgeDiff * 0.45, 0.0, 0.22);
      color *= (1.0 - contactOcc);

      // 2. ACES Split-Toning: Cool teal/blue in shadows, warm golden/amber in highlights
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec3 coolShadow = vec3(0.88, 0.94, 1.08);
      vec3 warmHighlight = vec3(1.10, 1.04, 0.92);
      vec3 graded = mix(color * coolShadow, color * warmHighlight, smoothstep(0.12, 0.85, lum));
      color = mix(color, graded, 0.65);

      // 3. Subtle ACES Filmic Tone Mapping Curve
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      color = clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);

      // 4. Subtle Vignette
      vec2 dUv = (vUv - 0.5) * 2.0;
      float vig = 1.0 - dot(dUv, dUv) * vignetteStrength * 0.45;
      color *= clamp(vig, 0.0, 1.0);

      gl_FragColor = vec4(color, baseColor.a);
    }
  `
};

// ---------------------------------------------------------------------------
// ANIMATED WATER MATERIAL (Scrolling Normal Map & Shoreline Foam)
// ---------------------------------------------------------------------------
function createWaterMaterial() {
  const texLoader = new THREE.TextureLoader();
  const waterNor = texLoader.load('./assets/textures/rock_nor.jpg');
  waterNor.wrapS = THREE.RepeatWrapping;
  waterNor.wrapT = THREE.RepeatWrapping;
  waterNor.repeat.set(12, 12);

  const customUniforms = {
    uTime: { value: 0 },
    uWaterNor: { value: waterNor }
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0x1e88e5,
    roughness: 0.10,
    metalness: 0.42,
    transparent: true,
    opacity: 0.86
  });

  mat.userData.customUniforms = customUniforms;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = customUniforms.uTime;
    shader.uniforms.uWaterNor = customUniforms.uWaterNor;
    shader.vertexShader = `
      uniform float uTime;
      varying vec3 vWorldPos;
      ${shader.vertexShader}
    `;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      // Flowing water wave perturbation
      float wave = sin(position.x * 0.45 + uTime * 2.2) * 0.08 + cos(position.y * 0.45 + uTime * 1.8) * 0.06;
      transformed.z += wave;
      `
    );

    shader.fragmentShader = `
      uniform float uTime;
      uniform sampler2D uWaterNor;
      varying vec3 vWorldPos;
      ${shader.fragmentShader}
    `;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      #include <normal_fragment_maps>
      // Dual-octave scrolling water normal maps
      vec2 wUv1 = vWorldPos.xz * 0.12 + vec2(uTime * 0.032, uTime * 0.018);
      vec2 wUv2 = vWorldPos.xz * 0.18 - vec2(uTime * 0.024, uTime * 0.038);
      vec3 wN1 = texture2D(uWaterNor, wUv1).xyz * 2.0 - 1.0;
      vec3 wN2 = texture2D(uWaterNor, wUv2).xyz * 2.0 - 1.0;
      vec3 wNormal = normalize(vec3(wN1.xy + wN2.xy, 1.0));
      normal = normalize(normalMatrix * wNormal);
      `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      // Shoreline wave foam fringe
      float waveCrest = sin(vWorldPos.x * 0.6 + uTime * 2.4) * cos(vWorldPos.z * 0.6 + uTime * 2.0);
      if (waveCrest > 0.62) {
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.98, 1.0), (waveCrest - 0.62) * 2.4);
      }
      `
    );
  };

  return mat;
}

// ---------------------------------------------------------------------------
// PBR SPLAT TERRAIN MATERIAL (Poly Haven Grass, Dirt, Rock, Snow Blended by Height, Slope & Noise)
// ---------------------------------------------------------------------------
function createPBRTerrainMaterial() {
  const texLoader = new THREE.TextureLoader();
  const loadWrapTex = (url, rep = 45) => {
    const t = texLoader.load(url);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    return t;
  };

  const grassDiff = loadWrapTex('./assets/textures/grass_diff.jpg', 60);
  grassDiff.colorSpace = THREE.SRGBColorSpace;
  const grassNor = loadWrapTex('./assets/textures/grass_nor.jpg', 60);

  const dirtDiff = loadWrapTex('./assets/textures/dirt_diff.jpg', 50);
  dirtDiff.colorSpace = THREE.SRGBColorSpace;
  const dirtNor = loadWrapTex('./assets/textures/dirt_nor.jpg', 50);

  const rockDiff = loadWrapTex('./assets/textures/rock_diff.jpg', 40);
  rockDiff.colorSpace = THREE.SRGBColorSpace;
  const rockNor = loadWrapTex('./assets/textures/rock_nor.jpg', 40);

  const snowDiff = loadWrapTex('./assets/textures/snow_diff.jpg', 45);
  snowDiff.colorSpace = THREE.SRGBColorSpace;
  const snowNor = loadWrapTex('./assets/textures/snow_nor.jpg', 45);

  const customUniforms = {
    uGrassDiff: { value: grassDiff },
    uGrassNor: { value: grassNor },
    uDirtDiff: { value: dirtDiff },
    uDirtNor: { value: dirtNor },
    uRockDiff: { value: rockDiff },
    uRockNor: { value: rockNor },
    uSnowDiff: { value: snowDiff },
    uSnowNor: { value: snowNor }
  };

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.08
  });

  mat.userData.customUniforms = customUniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, customUniforms);
    shader.vertexShader = `
      varying vec3 vWorldPos;
      varying vec3 vWorldNorm;
      ${shader.vertexShader}
    `;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vWorldNorm = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
      `
    );

    shader.fragmentShader = `
      uniform sampler2D uGrassDiff;
      uniform sampler2D uGrassNor;
      uniform sampler2D uDirtDiff;
      uniform sampler2D uDirtNor;
      uniform sampler2D uRockDiff;
      uniform sampler2D uRockNor;
      uniform sampler2D uSnowDiff;
      uniform sampler2D uSnowNor;
      varying vec3 vWorldPos;
      varying vec3 vWorldNorm;

      // Shared splat calculations across fragment stages
      float splatGrassW;
      float splatDirtW;
      float splatRockW;
      float splatSnowW;
      vec2 splatUvG;
      vec2 splatUvD;
      vec2 splatUvR;
      vec2 splatUvS;
      ${shader.fragmentShader}
    `;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      // PBR Splat weights based on height, slope, and organic noise
      float altitude = vWorldPos.y;
      float slope = 1.0 - abs(vWorldNorm.y); // 0 = flat, 1 = vertical cliff
      float noiseVal = sin(vWorldPos.x * 0.035) * cos(vWorldPos.z * 0.035) * 0.5 + 0.5;

      // 1. Rock on steep cliffs & hills (> 32-50 deg)
      float rockWeight = smoothstep(0.28, 0.52, slope);

      // 2. Light snow on cold peaks & high ridge above 40m
      float snowThresh = 42.0 - noiseVal * 10.0;
      float snowWeight = smoothstep(snowThresh - 6.0, snowThresh + 6.0, altitude) * (1.0 - rockWeight * 0.75);

      // 3. Dirt in valley hollows, damp road edges, and lower ground
      float dirtWeight = smoothstep(22.0, 5.0, altitude) * (0.35 + 0.45 * noiseVal);

      // 4. Grass on flat/gentle slopes
      float grassWeight = max(0.0, 1.0 - rockWeight - snowWeight - dirtWeight);
      float totalWeight = grassWeight + dirtWeight + rockWeight + snowWeight + 0.0001;
      splatGrassW = grassWeight / totalWeight;
      splatDirtW = dirtWeight / totalWeight;
      splatRockW = rockWeight / totalWeight;
      splatSnowW = snowWeight / totalWeight;

      splatUvG = vWorldPos.xz * 0.07;
      splatUvD = vWorldPos.xz * 0.055;
      splatUvR = vWorldPos.xz * 0.045;
      splatUvS = vWorldPos.xz * 0.065;

      vec4 texGrass = texture2D(uGrassDiff, splatUvG);
      vec4 texDirt  = texture2D(uDirtDiff, splatUvD);
      vec4 texRock  = texture2D(uRockDiff, splatUvR);
      vec4 texSnow  = texture2D(uSnowDiff, splatUvS);

      vec3 splatAlbedo = texGrass.rgb * splatGrassW +
                         texDirt.rgb * splatDirtW +
                         texRock.rgb * splatRockW +
                         texSnow.rgb * splatSnowW;

      // Multiply with zone vertex colors for regional atmospheric palettes
      diffuseColor.rgb = splatAlbedo * vColor.rgb * 1.5;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      #include <normal_fragment_maps>
      // Blended normal maps from PBR splat textures
      vec3 nG = texture2D(uGrassNor, splatUvG).xyz * 2.0 - 1.0;
      vec3 nD = texture2D(uDirtNor, splatUvD).xyz * 2.0 - 1.0;
      vec3 nR = texture2D(uRockNor, splatUvR).xyz * 2.0 - 1.0;
      vec3 nS = texture2D(uSnowNor, splatUvS).xyz * 2.0 - 1.0;

      vec3 splatNormal = normalize(nG * splatGrassW + nD * splatDirtW + nR * splatRockW + nS * splatSnowW);
      vec3 worldPerturb = vec3(splatNormal.x, 0.0, splatNormal.y);
      vec3 viewPerturb = (viewMatrix * vec4(worldPerturb, 0.0)).xyz;
      normal = normalize(normal + viewPerturb * 0.75);
      `
    );
  };

  return mat;
}

// ---------------------------------------------------------------------------
// ANIMALS: DEER HERD (State Machine: Idle/Graze, Alert, Flee)
// ---------------------------------------------------------------------------
class DeerHerd {
  constructor(scene) {
    this.scene = scene;
    this.deer = [];
    this.initHerd();
  }

  initHerd() {
    const deerMat = new THREE.MeshStandardMaterial({ color: 0x8a5832, roughness: 0.85 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x4a2e18, roughness: 0.9 });
    const antlerMat = new THREE.MeshStandardMaterial({ color: 0x3d2715, roughness: 0.8 });

    // Herd of 5 deer grazing in Zone 2 meadows
    const spawnPoints = [
      { x: 75, z: 230, isStag: true },
      { x: 88, z: 245, isStag: false },
      { x: 62, z: 220, isStag: false },
      { x: 105, z: 260, isStag: false },
      { x: 95, z: 215, isStag: false }
    ];

    spawnPoints.forEach((sp, idx) => {
      const group = new THREE.Group();
      const gy = getTerrainHeight(sp.x, sp.z);
      group.position.set(sp.x, gy, sp.z);

      // Body
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 1.5), deerMat);
      body.position.y = 1.05;
      body.castShadow = true;
      group.add(body);

      // White tail patch
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.15), new THREE.MeshStandardMaterial({ color: 0xf5eedc }));
      tail.position.set(0, 1.25, 0.8);
      group.add(tail);

      // Neck & Head group
      const neckGroup = new THREE.Group();
      neckGroup.position.set(0, 1.2, -0.65);

      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.65, 5), deerMat);
      neck.position.set(0, 0.25, -0.15);
      neck.rotation.x = 0.45;
      neckGroup.add(neck);

      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.55), deerMat);
      head.position.set(0, 0.55, -0.35);
      neckGroup.add(head);

      const snout = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.3), darkMat);
      snout.position.set(0, 0.48, -0.65);
      neckGroup.add(snout);

      // Ears
      [-0.18, 0.18].forEach(ex => {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 4), deerMat);
        ear.position.set(ex, 0.72, -0.25);
        ear.rotation.z = ex > 0 ? -0.4 : 0.4;
        neckGroup.add(ear);
      });

      // Antlers for Stag
      if (sp.isStag) {
        [-0.14, 0.14].forEach(ax => {
          const antler = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.65, 4), antlerMat);
          antler.position.set(ax, 0.88, -0.3);
          antler.rotation.z = ax > 0 ? -0.35 : 0.35;
          antler.rotation.x = -0.2;
          neckGroup.add(antler);

          const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.025, 0.3, 4), antlerMat);
          fork.position.set(ax * 1.5, 1.05, -0.22);
          fork.rotation.z = ax > 0 ? -0.8 : 0.8;
          neckGroup.add(fork);
        });
      }

      group.add(neckGroup);

      // 4 Slender Legs
      const legs = [];
      [[-0.26, -0.5], [0.26, -0.5], [-0.26, 0.5], [0.26, 0.5]].forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.05, 5), darkMat);
        leg.position.set(lx, 0.52, lz);
        leg.castShadow = true;
        group.add(leg);
        legs.push(leg);
      });

      this.scene.add(group);

      this.deer.push({
        id: `deer_${idx}`,
        mesh: group,
        neck: neckGroup,
        legs,
        isStag: sp.isStag,
        pos: new THREE.Vector3(sp.x, gy, sp.z),
        state: 'graze',
        grazeTimer: Math.random() * 5,
        alertTimer: 0,
        hopPhase: Math.random() * Math.PI * 2,
        vel: new THREE.Vector3()
      });
    });
  }

  update(delta, playerPos, isSprinting) {
    const time = performance.now() * 0.001;

    this.deer.forEach(d => {
      const distToPlayer = d.pos.distanceTo(playerPos);
      const fleeDist = isSprinting ? 24 : 15;

      // State transitions
      if (distToPlayer < fleeDist) {
        d.state = 'flee';
        d.alertTimer = 4.0;
      }

      if (d.state === 'flee') {
        // Run directly away from player
        const fleeDir = new THREE.Vector3().subVectors(d.pos, playerPos);
        fleeDir.y = 0;
        fleeDir.normalize();

        const speed = 7.5;
        d.vel.copy(fleeDir).multiplyScalar(speed);
        d.pos.x += d.vel.x * delta;
        d.pos.z += d.vel.z * delta;

        // Keep within meadow bounds
        d.pos.x = Math.max(20, Math.min(180, d.pos.x));
        d.pos.z = Math.max(160, Math.min(320, d.pos.z));

        // Bounding leap grounded on terrain
        d.hopPhase += delta * 11;
        const hopY = Math.abs(Math.sin(d.hopPhase)) * 0.45;
        d.pos.y = getTerrainHeight(d.pos.x, d.pos.z) + hopY;
        d.mesh.position.copy(d.pos);

        // Face movement direction
        d.mesh.rotation.y = Math.atan2(d.vel.x, d.vel.z);
        d.neck.rotation.x = 0.2;

        // Leg swings
        d.legs[0].rotation.x = Math.sin(d.hopPhase) * 0.5;
        d.legs[1].rotation.x = -Math.sin(d.hopPhase) * 0.5;
        d.legs[2].rotation.x = -Math.sin(d.hopPhase) * 0.5;
        d.legs[3].rotation.x = Math.sin(d.hopPhase) * 0.5;

        if (distToPlayer > 36) {
          d.state = 'alert';
        }
      } else if (d.state === 'alert') {
        d.alertTimer -= delta;
        d.neck.rotation.x = 0.35; // Head raised alertly
        d.mesh.lookAt(playerPos.x, d.pos.y, playerPos.z);
        d.pos.y = getTerrainHeight(d.pos.x, d.pos.z);
        d.mesh.position.copy(d.pos);

        if (d.alertTimer <= 0) {
          d.state = 'graze';
          d.grazeTimer = 3 + Math.random() * 4;
        }
      } else {
        // Graze / Idle
        d.grazeTimer -= delta;
        const grazeNeckAngle = -0.55 + Math.sin(time * 1.5 + d.hopPhase) * 0.08;
        d.neck.rotation.x = grazeNeckAngle; // Head down to turf
        d.pos.y = getTerrainHeight(d.pos.x, d.pos.z);
        d.mesh.position.copy(d.pos);

        d.mesh.rotation.y += Math.sin(time * 0.8 + d.hopPhase) * 0.003;

        if (d.grazeTimer <= 0) {
          const wanderAngle = Math.random() * Math.PI * 2;
          d.pos.x += Math.cos(wanderAngle) * 0.8;
          d.pos.z += Math.sin(wanderAngle) * 0.8;
          d.grazeTimer = 4 + Math.random() * 5;
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// ANIMALS: RABBIT COLONY (Arctic Hares, Hopping Motion & Brush Scatter)
// ---------------------------------------------------------------------------
class RabbitColony {
  constructor(scene) {
    this.scene = scene;
    this.rabbits = [];
    this.initRabbits();
  }

  initRabbits() {
    const furMat = new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.9 });
    const earMat = new THREE.MeshStandardMaterial({ color: 0xe2ded4, roughness: 0.95 });

    // 7 rabbits near shrubs in Zone 1 (crash site) and Zone 2 (forest edge)
    const spots = [
      { x: -160, z: 490 },
      { x: -145, z: 460 },
      { x: -130, z: 430 },
      { x: 30, z: 340 },
      { x: 50, z: 310 },
      { x: 120, z: 270 },
      { x: 140, z: 210 }
    ];

    spots.forEach((sp) => {
      const group = new THREE.Group();
      const gy = getTerrainHeight(sp.x, sp.z);
      group.position.set(sp.x, gy, sp.z);

      // Body
      const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 1), furMat);
      body.position.y = 0.22;
      body.scale.set(0.9, 0.8, 1.2);
      group.add(body);

      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 6), furMat);
      head.position.set(0, 0.35, -0.22);
      group.add(head);

      // Long Ears
      [-0.07, 0.07].forEach(ex => {
        const ear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.04), earMat);
        ear.position.set(ex, 0.54, -0.2);
        ear.rotation.z = ex > 0 ? -0.15 : 0.15;
        ear.rotation.x = -0.1;
        group.add(ear);
      });

      // Tail
      const tail = new THREE.Mesh(new THREE.SphereGeometry(0.08, 5, 5), furMat);
      tail.position.set(0, 0.26, 0.32);
      group.add(tail);

      this.scene.add(group);

      this.rabbits.push({
        mesh: group,
        pos: new THREE.Vector3(sp.x, gy, sp.z),
        hopTimer: Math.random() * 3,
        hopPhase: 0,
        heading: Math.random() * Math.PI * 2,
        isHopping: false
      });
    });
  }

  update(delta, playerPos) {
    this.rabbits.forEach(r => {
      const dist = r.pos.distanceTo(playerPos);

      if (dist < 8.0) {
        // Flee rapidly away from player
        const fleeDir = new THREE.Vector3().subVectors(r.pos, playerPos).normalize();
        r.pos.x += fleeDir.x * delta * 5.8;
        r.pos.z += fleeDir.z * delta * 5.8;
        r.heading = Math.atan2(fleeDir.x, fleeDir.z);
        r.hopPhase += delta * 14;
        const hopY = Math.abs(Math.sin(r.hopPhase)) * 0.32;
        r.pos.y = getTerrainHeight(r.pos.x, r.pos.z) + hopY;
        r.mesh.position.copy(r.pos);
        r.mesh.rotation.y = r.heading;
      } else {
        // Idle hopping / nibbling
        r.hopTimer -= delta;
        if (r.hopTimer <= 0) {
          r.isHopping = true;
          r.hopPhase = 0;
          r.heading += (Math.random() - 0.5) * 1.5;
          r.hopTimer = 2.5 + Math.random() * 3.5;
        }

        if (r.isHopping) {
          r.hopPhase += delta * 8;
          if (r.hopPhase < Math.PI) {
            const hopY = Math.sin(r.hopPhase) * 0.22;
            r.pos.x += Math.sin(r.heading) * delta * 1.6;
            r.pos.z += Math.cos(r.heading) * delta * 1.6;
            r.pos.y = getTerrainHeight(r.pos.x, r.pos.z) + hopY;
          } else {
            r.isHopping = false;
            r.pos.y = getTerrainHeight(r.pos.x, r.pos.z);
          }
        } else {
          r.pos.y = getTerrainHeight(r.pos.x, r.pos.z);
        }
        r.mesh.position.copy(r.pos);
        r.mesh.rotation.y = r.heading;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// BIRDS: FLOCKS OF 8-15 BOIDS (Circling Forest & Lake, Scatter on Run)
// ---------------------------------------------------------------------------
class BirdFlocks {
  constructor(scene) {
    this.scene = scene;
    this.flocks = [];
    this.initFlocks();
  }

  initFlocks() {
    // Flock 1: 14 Ravens circling Zone 2 Forest
    // Flock 2: 12 Lake Gulls circling Zone 3 Lake
    const flockConfigs = [
      { cx: 100, cz: 240, alt: 42, count: 14, radius: 55, color: 0x1e293b, wingColor: 0x0f172a },
      { cx: -35, cz: 40, alt: 32, count: 12, radius: 48, color: 0x94a3b8, wingColor: 0x64748b }
    ];

    const bodyGeom = new THREE.ConeGeometry(0.2, 0.9, 4);
    bodyGeom.rotateX(Math.PI / 2);
    const wingGeom = new THREE.BoxGeometry(0.9, 0.04, 0.35);

    flockConfigs.forEach((cfg, fIdx) => {
      const mat = new THREE.MeshBasicMaterial({ color: cfg.color });
      const wingMat = new THREE.MeshBasicMaterial({ color: cfg.wingColor });
      const birds = [];

      for (let i = 0; i < cfg.count; i++) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(bodyGeom, mat);
        group.add(body);

        const leftWing = new THREE.Mesh(wingGeom, wingMat);
        leftWing.position.set(-0.5, 0, 0);
        group.add(leftWing);

        const rightWing = new THREE.Mesh(wingGeom, wingMat);
        rightWing.position.set(0.5, 0, 0);
        group.add(rightWing);

        const angle = (i / cfg.count) * Math.PI * 2;
        const dist = cfg.radius + (Math.random() - 0.5) * 16;
        const px = cfg.cx + Math.cos(angle) * dist;
        const pz = cfg.cz + Math.sin(angle) * dist;
        const py = cfg.alt + (Math.random() - 0.5) * 6;

        group.position.set(px, py, pz);
        this.scene.add(group);

        birds.push({
          mesh: group,
          leftWing,
          rightWing,
          orbitAngle: angle,
          orbitRadius: dist,
          baseAlt: py,
          scatterTimer: 0,
          scatterVel: new THREE.Vector3(),
          wingPhase: Math.random() * Math.PI * 2
        });
      }

      this.flocks.push({
        cx: cfg.cx,
        cz: cfg.cz,
        birds,
        orbitSpeed: fIdx === 0 ? 0.35 : 0.42
      });
    });
  }

  update(delta, playerPos, isSprinting) {
    const time = performance.now() * 0.001;

    this.flocks.forEach(f => {
      const distToPlayer = Math.hypot(playerPos.x - f.cx, playerPos.z - f.cz);
      const shouldScatter = isSprinting && distToPlayer < 48;

      f.birds.forEach(b => {
        b.wingPhase += delta * 9;
        const flap = Math.sin(b.wingPhase) * 0.55;
        b.leftWing.rotation.z = flap;
        b.rightWing.rotation.z = -flap;

        if (shouldScatter) {
          b.scatterTimer = 3.5;
          b.scatterVel.set(
            (Math.random() - 0.5) * 14,
            6.0 + Math.random() * 4,
            (Math.random() - 0.5) * 14
          );
        }

        if (b.scatterTimer > 0) {
          b.scatterTimer -= delta;
          b.mesh.position.addScaledVector(b.scatterVel, delta);
          b.scatterVel.y = Math.max(0, b.scatterVel.y - delta * 2.0);
          b.mesh.rotation.y = Math.atan2(b.scatterVel.x, b.scatterVel.z);
        } else {
          // Gentle orbit
          b.orbitAngle += delta * f.orbitSpeed;
          const targetX = f.cx + Math.cos(b.orbitAngle) * b.orbitRadius;
          const targetZ = f.cz + Math.sin(b.orbitAngle) * b.orbitRadius;
          const targetY = b.baseAlt + Math.sin(time + b.orbitAngle) * 2.5;

          const tangentX = -Math.sin(b.orbitAngle);
          const tangentZ = Math.cos(b.orbitAngle);

          b.mesh.position.set(targetX, targetY, targetZ);
          b.mesh.rotation.y = Math.atan2(tangentX, tangentZ);
          b.mesh.rotation.z = 0.22;
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// INSTANCED FISH SCHOOL (24 Fish swimming along river & lake, scatter on entry)
// ---------------------------------------------------------------------------
class FishSchool {
  constructor(scene) {
    this.scene = scene;
    this.fishCount = 24;
    this.initFish();
  }

  initFish() {
    const bodyGeom = new THREE.ConeGeometry(0.16, 0.75, 5);
    bodyGeom.rotateX(-Math.PI / 2);

    const fishMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.35,
      metalness: 0.8,
      roughness: 0.25
    });

    this.instancedMesh = new THREE.InstancedMesh(bodyGeom, fishMat, this.fishCount);
    this.scene.add(this.instancedMesh);

    // River & Lake loop waypoints
    this.pathPoints = [
      new THREE.Vector3(5, 5.0, -10),
      new THREE.Vector3(-12, 5.0, 5),
      new THREE.Vector3(-20, 5.0, 20),
      new THREE.Vector3(-30, 5.0, 32),
      new THREE.Vector3(-45, 5.0, 48),
      new THREE.Vector3(-55, 5.0, 38),
      new THREE.Vector3(-40, 5.0, 24),
      new THREE.Vector3(-25, 5.0, 15),
      new THREE.Vector3(-10, 5.0, 0)
    ];
    this.curve = new THREE.CatmullRomCurve3(this.pathPoints, true);

    this.fishData = [];
    for (let i = 0; i < this.fishCount; i++) {
      this.fishData.push({
        u: i / this.fishCount,
        speed: 0.025 + Math.random() * 0.015,
        offsetRadius: (Math.random() - 0.5) * 5.5,
        depth: 4.8 + Math.random() * 0.3,
        scatterTimer: 0,
        scatterOffset: new THREE.Vector3()
      });
    }
    this.dummy = new THREE.Object3D();
  }

  update(delta, playerPos) {
    const time = performance.now() * 0.001;

    for (let i = 0; i < this.fishCount; i++) {
      const f = this.fishData[i];
      f.u = (f.u + f.speed * delta) % 1.0;

      const pt = this.curve.getPoint(f.u);
      const tangent = this.curve.getTangent(f.u);
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

      const fx = pt.x + normal.x * f.offsetRadius;
      const fz = pt.z + normal.z * f.offsetRadius;
      const fy = f.depth;

      // Scatter check: If player splashes into water near fish (< 6.5m)
      const distToPlayer = Math.hypot(playerPos.x - fx, playerPos.z - fz);
      if (distToPlayer < 6.5 && playerPos.y < 6.0) {
        f.scatterTimer = 2.5;
        f.scatterOffset.set(
          (fx - playerPos.x) * 1.5,
          -0.4,
          (fz - playerPos.z) * 1.5
        );
      }

      let posX = fx;
      let posY = fy;
      let posZ = fz;

      if (f.scatterTimer > 0) {
        f.scatterTimer -= delta;
        posX += f.scatterOffset.x;
        posY = Math.max(4.2, posY + f.scatterOffset.y);
        posZ += f.scatterOffset.z;
      }

      const wiggle = Math.sin(time * 9 + i) * 0.12;

      this.dummy.position.set(posX, posY, posZ);
      this.dummy.rotation.y = Math.atan2(tangent.x, tangent.z) + wiggle;
      this.dummy.scale.set(0.9, 0.9, 1.2);
      this.dummy.updateMatrix();

      this.instancedMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// REAL FLAME & EMBER PARTICLE SYSTEM (Torch & Campfire Safe Zones)
// ---------------------------------------------------------------------------
class FlameParticleSystem {
  constructor(scene, count = 28, spread = 0.35, speedY = 1.4, size = 0.22) {
    this.scene = scene;
    this.count = count;
    this.spread = spread;
    this.speedY = speedY;
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    this.vel = [];

    for (let i = 0; i < count; i++) {
      pos[i * 3] = 0;
      pos[i * 3 + 1] = Math.random() * 0.8;
      pos[i * 3 + 2] = 0;

      const isYellow = Math.random() > 0.45;
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = isYellow ? 0.75 + Math.random() * 0.25 : 0.35;
      colors[i * 3 + 2] = isYellow ? 0.1 : 0.02;

      this.vel.push({
        vx: (Math.random() - 0.5) * 0.18,
        vy: speedY * (0.6 + Math.random() * 0.8),
        vz: (Math.random() - 0.5) * 0.18,
        life: Math.random()
      });
    }

    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: size,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.points = new THREE.Points(geom, mat);
    this.scene.add(this.points);
  }

  update(delta, originPos, active = true) {
    if (!active) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    const pos = this.points.geometry.attributes.position;
    for (let i = 0; i < this.count; i++) {
      const v = this.vel[i];
      let x = pos.getX(i) + v.vx * delta;
      let y = pos.getY(i) + v.vy * delta;
      let z = pos.getZ(i) + v.vz * delta;

      if (y > originPos.y + 1.4) {
        x = originPos.x + (Math.random() - 0.5) * this.spread;
        y = originPos.y + 0.08;
        z = originPos.z + (Math.random() - 0.5) * this.spread;
      }
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
  }

}

// ---------------------------------------------------------------------------
// FIRST-PERSON ARMS & HELD ITEMS SYSTEM
// ---------------------------------------------------------------------------
class FirstPersonArmsSystem {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.position.set(0.20, -0.26, -0.38);
    this.camera.add(this.root);

    this.bobTime = 0;
    this.swingProgress = 1;
    this.useProgress = 1;
    this.equipProgress = 1;
    this.activeItem = 'torch';

    this.buildArms();
    this.buildHeldItems();
  }

  buildArms() {
    this.sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b, // Dark navy mountaineering parka
      roughness: 0.8,
      metalness: 0.1
    });
    this.cuffMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0, // Fur fleece cuff trim
      roughness: 0.95
    });
    this.gloveMat = new THREE.MeshStandardMaterial({
      color: 0x3a2e26, // Weathered brown leather survival gloves
      roughness: 0.65,
      metalness: 0.12
    });

    // 1. RIGHT ARM (Main hand holding item)
    this.rightArm = new THREE.Group();

    // Upper arm
    const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.056, 0.36, 8), this.sleeveMat);
    upperArm.position.set(0.08, -0.12, 0.14);
    upperArm.rotation.set(0.55, 0.15, -0.35);
    upperArm.castShadow = true;
    this.rightArm.add(upperArm);

    // Forearm
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.046, 0.32, 8), this.sleeveMat);
    forearm.position.set(0.01, -0.04, -0.06);
    forearm.rotation.set(-0.45, -0.1, 0.15);
    forearm.castShadow = true;
    this.rightArm.add(forearm);

    // Fleece cuff
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.052, 0.06, 8), this.cuffMat);
    cuff.position.set(-0.02, 0.07, -0.16);
    cuff.rotation.set(-0.45, -0.1, 0.15);
    this.rightArm.add(cuff);

    // Gloved Hand & Fingers wrapped in a grip
    this.rightHand = new THREE.Group();
    this.rightHand.position.set(-0.03, 0.10, -0.19);
    this.rightHand.rotation.set(-0.25, -0.18, 0.15);

    // Palm
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.085), this.gloveMat);
    palm.castShadow = true;
    this.rightHand.add(palm);

    // Curled fingers holding shaft
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.045, 0.065), this.gloveMat);
      finger.position.set(-0.028 + f * 0.018, 0.018, -0.04);
      finger.rotation.x = -0.55;
      this.rightHand.add(finger);
    }
    // Thumb
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.05), this.gloveMat);
    thumb.position.set(0.042, 0.01, -0.015);
    thumb.rotation.set(0.4, 0.6, -0.3);
    this.rightHand.add(thumb);

    this.rightArm.add(this.rightHand);
    this.root.add(this.rightArm);

    // 2. LEFT ARM (Supporting / natural off-hand visible in peripheral view)
    this.leftArm = new THREE.Group();
    this.leftArm.position.set(-0.45, -0.08, 0.05);

    const leftForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.046, 0.34, 8), this.sleeveMat);
    leftForearm.position.set(0.06, -0.06, -0.08);
    leftForearm.rotation.set(-0.55, 0.35, -0.25);
    this.leftArm.add(leftForearm);

    const leftCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.052, 0.06, 8), this.cuffMat);
    leftCuff.position.set(0.09, 0.06, -0.19);
    leftCuff.rotation.set(-0.55, 0.35, -0.25);
    this.leftArm.add(leftCuff);

    const leftPalm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.08), this.gloveMat);
    leftPalm.position.set(0.11, 0.09, -0.23);
    leftPalm.rotation.set(-0.35, 0.45, -0.15);
    this.leftArm.add(leftPalm);

    this.root.add(this.leftArm);
  }

  buildHeldItems() {
    this.itemContainer = new THREE.Group();
    this.rightHand.add(this.itemContainer);

    // 1. TORCH
    this.torchGroup = new THREE.Group();
    const stickMat = new THREE.MeshStandardMaterial({ color: 0x4a2e18, roughness: 0.95 });
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.58, 6), stickMat);
    stick.position.set(0, 0.12, -0.02);
    stick.rotation.x = 0.22;
    this.torchGroup.add(stick);

    const clothMat = new THREE.MeshStandardMaterial({ color: 0x221811, roughness: 0.95 });
    const clothWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.032, 0.12, 8), clothMat);
    clothWrap.position.set(0, 0.36, -0.06);
    clothWrap.rotation.x = 0.22;
    this.torchGroup.add(clothWrap);

    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9900 });
    this.flameMesh = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.15, 8), flameMat);
    this.flameMesh.position.set(0, 0.44, -0.08);
    this.flameMesh.rotation.x = 0.22;
    this.torchGroup.add(this.flameMesh);

    // Dedicated PointLight at the flame head that lights up the hands and surroundings
    this.handTorchLight = new THREE.PointLight(0xff9433, 2.6, 24, 1.8);
    this.handTorchLight.position.set(0, 0.46, -0.08);
    this.handTorchLight.castShadow = false;
    this.torchGroup.add(this.handTorchLight);

    this.itemContainer.add(this.torchGroup);

    // 2. MATCHES
    this.matchesGroup = new THREE.Group();
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.5 });
    const matchbox = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.075, 0.025), boxMat);
    matchbox.position.set(0, 0.06, -0.02);
    this.matchesGroup.add(matchbox);
    const matchStick = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.06, 4), new THREE.MeshStandardMaterial({ color: 0xd6c29a }));
    matchStick.position.set(0.02, 0.11, -0.02);
    this.matchesGroup.add(matchStick);
    const matchHead = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 6), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    matchHead.position.set(0.02, 0.14, -0.02);
    this.matchesGroup.add(matchHead);
    this.matchesGroup.visible = false;
    this.itemContainer.add(this.matchesGroup);

    // 3. FOOD (Hot Soup Can / Berries)
    this.foodGroup = new THREE.Group();
    const canMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.3 });
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.085, 12), canMat);
    can.position.set(0, 0.06, -0.02);
    this.foodGroup.add(can);
    this.foodGroup.visible = false;
    this.itemContainer.add(this.foodGroup);

    // 4. TOOLS (Diesel Jerrycan / Mountain Pick)
    this.toolsGroup = new THREE.Group();
    const canisMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.4, metalness: 0.5 });
    const canister = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.08), canisMat);
    canister.position.set(0, 0.05, -0.02);
    this.toolsGroup.add(canister);
    this.toolsGroup.visible = false;
    this.itemContainer.add(this.toolsGroup);
  }

  setHeldItem(type) {
    this.activeItem = type;
    this.torchGroup.visible = (type === 'torch');
    this.matchesGroup.visible = (type === 'matches');
    this.foodGroup.visible = (type === 'food' || type === 'berries' || type === 'soup' || type === 'ration');
    this.toolsGroup.visible = (type === 'diesel' || type === 'tools');
    this.equipProgress = 0;
  }

  triggerAttackSwing() {
    this.swingProgress = 0;
  }

  triggerUseAnimation() {
    this.useProgress = 0;
  }

  update(delta, isMoving, isSprinting, isTorchLit) {
    if (this.torchGroup.visible) {
      this.flameMesh.visible = isTorchLit;
      this.handTorchLight.intensity = isTorchLit ? 2.6 : 0;
      if (isTorchLit) {
        const time = performance.now() * 0.001;
        const flick = Math.sin(time * 23) * 0.2 + Math.sin(time * 41) * 0.15;
        this.handTorchLight.intensity = Math.max(1.8, 2.6 + flick);
        this.flameMesh.scale.set(1.0 + flick * 0.15, 1.0 + flick * 0.25, 1.0 + flick * 0.15);
      }
    }

    if (this.swingProgress < 1.0) this.swingProgress = Math.min(1.0, this.swingProgress + delta * 4.6);
    if (this.useProgress < 1.0) this.useProgress = Math.min(1.0, this.useProgress + delta * 3.0);
    if (this.equipProgress < 1.0) this.equipProgress = Math.min(1.0, this.equipProgress + delta * 3.8);

    const bobFreq = isSprinting ? 13.5 : (isMoving ? 7.8 : 1.6);
    this.bobTime += delta * bobFreq;

    let posX = 0.20;
    let posY = -0.26;
    let posZ = -0.38;
    let rotX = 0;
    let rotY = 0;
    let rotZ = 0;

    if (!isMoving) {
      posX += Math.sin(this.bobTime) * 0.012;
      posY += Math.cos(this.bobTime * 2.0) * 0.008;
      rotZ += Math.sin(this.bobTime) * 0.02;
    } else {
      const amp = isSprinting ? 0.042 : 0.024;
      posX += Math.cos(this.bobTime) * amp;
      posY += Math.abs(Math.sin(this.bobTime)) * amp * 1.2 - amp * 0.6;
      rotX += Math.sin(this.bobTime) * 0.04;
      rotZ += Math.cos(this.bobTime) * 0.035;

      if (isSprinting) {
        posY -= 0.04;
        posZ -= 0.05;
        rotX += 0.22;
        rotY -= 0.12;
      }
    }

    this.leftArm.position.y = -0.08 + Math.sin(this.bobTime + Math.PI * 0.5) * (isMoving ? 0.02 : 0.006);
    this.leftArm.position.x = -0.45 + Math.cos(this.bobTime) * (isMoving ? 0.015 : 0.004);

    if (this.equipProgress < 1.0) {
      const eq = 1.0 - Math.sin(this.equipProgress * Math.PI * 0.5);
      posY -= eq * 0.28;
      rotX += eq * 0.4;
    }

    if (this.useProgress < 1.0) {
      const u = Math.sin(this.useProgress * Math.PI);
      posY += u * 0.16;
      posZ += u * 0.14;
      posX -= u * 0.08;
      rotX += u * 0.35;
    }

    if (this.swingProgress < 1.0) {
      const s = Math.sin(this.swingProgress * Math.PI);
      posY += Math.sin(this.swingProgress * Math.PI * 2.0) * 0.08;
      posZ += (this.swingProgress < 0.4 ? -0.12 : 0.04) * s;
      rotX += -0.75 * s;
      rotY += 0.25 * s;
      rotZ += -0.35 * s;
    }

    this.root.position.set(posX, posY, posZ);
    this.root.rotation.set(rotX, rotY, rotZ);
  }
}

// ---------------------------------------------------------------------------
// THIRD-PERSON PLAYER CHARACTER (GLB Loader + Procedural Humanoid)
// ---------------------------------------------------------------------------
class ThirdPersonPlayerSystem {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.walkCycle = 0;
    this.isFirstPerson = true;
    this.modelYaw = 0;

    this.mixer = null;
    this.animations = {};
    this.activeAction = null;
    this.hasGLB = false;

    this.buildProceduralSurvivor();
    this.attemptLoadGLB();
    this.setFirstPerson(true);
  }

  buildProceduralSurvivor() {
    this.procGroup = new THREE.Group();

    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.7 });
    const parkaMat = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.75, metalness: 0.1 });
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.8 });
    const furMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.95 });
    const backpackMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x3a2e26, roughness: 0.7 });
    const ushankaMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.9 });
    const goggleMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.9, roughness: 0.15 });

    // Pelvis
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = 0.92;
    const hipMesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.24), pantsMat);
    hipMesh.castShadow = true;
    this.pelvis.add(hipMesh);

    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.05, 0.26), new THREE.MeshStandardMaterial({ color: 0x171717 }));
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.28), new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.8, roughness: 0.3 }));
    this.pelvis.add(belt);
    this.pelvis.add(buckle);

    // Left Leg
    this.legL = new THREE.Group();
    this.legL.position.set(-0.11, -0.08, 0);
    const thighL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.16), pantsMat);
    thighL.position.y = -0.21;
    thighL.castShadow = true;
    this.legL.add(thighL);
    const calfL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.38, 0.15), pantsMat);
    calfL.position.y = -0.52;
    calfL.castShadow = true;
    this.legL.add(calfL);
    const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.26), bootMat);
    bootL.position.set(0, -0.74, 0.04);
    bootL.castShadow = true;
    this.legL.add(bootL);
    this.pelvis.add(this.legL);

    // Right Leg
    this.legR = new THREE.Group();
    this.legR.position.set(0.11, -0.08, 0);
    const thighR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.16), pantsMat);
    thighR.position.y = -0.21;
    thighR.castShadow = true;
    this.legR.add(thighR);
    const calfR = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.38, 0.15), pantsMat);
    calfR.position.y = -0.52;
    calfR.castShadow = true;
    this.legR.add(calfR);
    const bootR = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.26), bootMat);
    bootR.position.set(0, -0.74, 0.04);
    bootR.castShadow = true;
    this.legR.add(bootR);
    this.pelvis.add(this.legR);

    // Torso
    this.torso = new THREE.Group();
    this.torso.position.y = 0.12;
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.52, 0.28), parkaMat);
    bodyMesh.position.y = 0.24;
    bodyMesh.castShadow = true;
    this.torso.add(bodyMesh);

    const shoulderPatch = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.30), shoulderMat);
    shoulderPatch.position.y = 0.42;
    this.torso.add(shoulderPatch);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.06, 6, 12), furMat);
    collar.position.set(0, 0.50, 0);
    collar.rotation.x = Math.PI / 2;
    this.torso.add(collar);

    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.22), backpackMat);
    pack.position.set(0, 0.26, -0.23);
    pack.castShadow = true;
    this.torso.add(pack);

    const bedroll = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.38, 8), new THREE.MeshStandardMaterial({ color: 0x334155 }));
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, 0.52, -0.23);
    this.torso.add(bedroll);

    // Left Arm
    this.armL = new THREE.Group();
    this.armL.position.set(-0.27, 0.42, 0);
    const uArmL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.052, 0.34, 8), parkaMat);
    uArmL.position.y = -0.17;
    uArmL.castShadow = true;
    this.armL.add(uArmL);
    const fArmL = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.32, 8), parkaMat);
    fArmL.position.y = -0.42;
    fArmL.castShadow = true;
    this.armL.add(fArmL);
    const handL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), gloveMat);
    handL.position.y = -0.60;
    handL.castShadow = true;
    this.armL.add(handL);
    this.torso.add(this.armL);

    // Right Arm
    this.armR = new THREE.Group();
    this.armR.position.set(0.27, 0.42, 0);
    const uArmR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.052, 0.34, 8), parkaMat);
    uArmR.position.y = -0.17;
    uArmR.castShadow = true;
    this.armR.add(uArmR);
    const fArmR = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.32, 8), parkaMat);
    fArmR.position.y = -0.42;
    fArmR.castShadow = true;
    this.armR.add(fArmR);
    const handR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), gloveMat);
    handR.position.y = -0.60;
    handR.castShadow = true;
    this.armR.add(handR);

    // 3rd Person Torch in Hand
    this.thirdPersonTorch = new THREE.Group();
    this.thirdPersonTorch.position.set(0, -0.60, 0.12);
    this.thirdPersonTorch.rotation.x = 0.65;
    const tpTorchStick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.55, 6), new THREE.MeshStandardMaterial({ color: 0x3d2817 }));
    this.thirdPersonTorch.add(tpTorchStick);
    this.tpTorchFlame = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 8), new THREE.MeshBasicMaterial({ color: 0xff9900 }));
    this.tpTorchFlame.position.y = 0.32;
    this.thirdPersonTorch.add(this.tpTorchFlame);
    this.armR.add(this.thirdPersonTorch);

    this.torso.add(this.armR);

    // Head
    this.head = new THREE.Group();
    this.head.position.y = 0.58;

    const face = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0xdec0a2, roughness: 0.8 }));
    face.position.y = 0.11;
    this.head.add(face);

    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.25), ushankaMat);
    hat.position.set(0, 0.21, -0.01);
    this.head.add(hat);
    const flapL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.18), ushankaMat);
    flapL.position.set(-0.13, 0.12, 0);
    this.head.add(flapL);
    const flapR = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.18), ushankaMat);
    flapR.position.set(0.13, 0.12, 0);
    this.head.add(flapR);

    const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.07, 0.06), goggleMat);
    goggles.position.set(0, 0.13, 0.12);
    this.head.add(goggles);

    this.torso.add(this.head);
    this.pelvis.add(this.torso);
    this.procGroup.add(this.pelvis);
    this.root.add(this.procGroup);
  }

  attemptLoadGLB() {
    const loader = new GLTFLoader();
    loader.load(
      './assets/character.glb',
      (gltf) => {
        try {
          this.glbModel = gltf.scene;
          this.glbModel.scale.set(1.0, 1.0, 1.0);
          this.glbModel.traverse(c => {
            if (c.isMesh) {
              c.castShadow = true;
              c.receiveShadow = true;
            }
          });
          this.root.add(this.glbModel);
          this.procGroup.visible = false;
          this.hasGLB = true;

          if (gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.glbModel);
            gltf.animations.forEach(clip => {
              const name = clip.name.toLowerCase();
              this.animations[name] = this.mixer.clipAction(clip);
            });
            const idle = this.animations['idle'] || Object.values(this.animations)[0];
            if (idle) idle.play();
          }
        } catch (e) {
          console.warn('GLB character init error:', e);
        }
      },
      undefined,
      (err) => {}
    );
  }

  setFirstPerson(isFp) {
    this.isFirstPerson = isFp;
    if (this.hasGLB && this.glbModel) {
      this.root.visible = !isFp;
    } else {
      this.root.visible = true;
      if (this.head) this.head.visible = !isFp;
      if (this.thirdPersonTorch) this.thirdPersonTorch.visible = !isFp;
    }
  }

  update(delta, playerPos, speed, isGrounded, isSprinting, moveDir, isTorchLit, cameraYaw) {
    this.root.position.copy(playerPos);

    if (this.thirdPersonTorch) {
      this.thirdPersonTorch.visible = !this.isFirstPerson;
      this.tpTorchFlame.visible = isTorchLit;
    }

    if (moveDir && moveDir.lengthSq() > 0.05) {
      const targetAngle = Math.atan2(moveDir.x, moveDir.z);
      let diff = targetAngle - this.modelYaw;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.modelYaw += diff * Math.min(1.0, delta * 12.0);
    } else {
      let diff = (cameraYaw + Math.PI) - this.modelYaw;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.modelYaw += diff * Math.min(1.0, delta * 6.0);
    }
    this.root.rotation.y = this.modelYaw;

    if (this.mixer) {
      this.mixer.update(delta);
      return;
    }

    const isMoving = speed > 0.4;
    const cycleFreq = isSprinting ? 12.5 : (isMoving ? 7.2 : 2.0);
    this.walkCycle += delta * cycleFreq;

    if (!isGrounded) {
      this.legL.rotation.x = -0.45;
      this.legR.rotation.x = -0.45;
      this.armL.rotation.x = -0.65;
      this.armR.rotation.x = 0.55;
      this.torso.rotation.x = 0.12;
    } else if (isMoving) {
      const legAmp = isSprinting ? 0.95 : 0.65;
      const armAmp = isSprinting ? 0.85 : 0.45;
      const sw = Math.sin(this.walkCycle);

      this.legL.rotation.x = sw * legAmp;
      this.legR.rotation.x = -sw * legAmp;

      this.armL.rotation.x = -sw * armAmp;
      this.armR.rotation.x = 0.4 + sw * (armAmp * 0.4);

      this.torso.rotation.x = isSprinting ? 0.28 : 0.08;
      this.torso.position.y = 0.12 + Math.abs(Math.sin(this.walkCycle * 2.0)) * 0.04;
    } else {
      const breath = Math.sin(this.walkCycle);
      this.legL.rotation.x = 0;
      this.legR.rotation.x = 0;
      this.armL.rotation.x = breath * 0.05;
      this.armR.rotation.x = 0.35 + breath * 0.04;
      this.torso.rotation.x = breath * 0.02;
      this.torso.position.y = 0.12 + breath * 0.01;
    }
  }
}

// ---------------------------------------------------------------------------
// REALISTIC 4x4 EXPEDITION SUV (GLB Loader + Procedural Chassis)
// ---------------------------------------------------------------------------
class RealisticSUVSystem {
  constructor(scene, isWrecked = false) {
    this.scene = scene;
    this.isWrecked = isWrecked;
    this.root = new THREE.Group();
    this.wheels = [];
    this.headlights = [];
    this.steamParticles = null;

    this.buildProceduralSUV();
    this.attemptLoadGLB();
  }

  buildProceduralSUV() {
    this.carGroup = new THREE.Group();

    const paintColor = this.isWrecked ? 0xb45309 : 0xd97706; // Rugged Expedition Amber / Ochre 4x4
    const bodyMat = new THREE.MeshStandardMaterial({
      color: paintColor,
      roughness: 0.38,
      metalness: 0.55
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.85
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.95,
      roughness: 0.15
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      opacity: 0.45,
      transparent: true,
      roughness: 0.1,
      metalness: 0.8
    });
    const rubberMat = new THREE.MeshStandardMaterial({
      color: 0x171717,
      roughness: 0.9
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.85,
      roughness: 0.25
    });

    // 1. Lower Chassis & Wheel Wells
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.45, 4.6), trimMat);
    chassis.position.y = 0.45;
    chassis.castShadow = true;
    this.carGroup.add(chassis);

    // Front Off-Road Steel Bullbar & Winch
    const bullbar = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 0.4), trimMat);
    bullbar.position.set(0, 0.55, -2.4);
    if (this.isWrecked) {
      bullbar.rotation.set(-0.15, 0.12, 0.08);
    }
    this.carGroup.add(bullbar);

    const winch = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 8), chromeMat);
    winch.rotation.z = Math.PI / 2;
    winch.position.set(0, 0.55, -2.55);
    this.carGroup.add(winch);

    // 2. Main Sculpted SUV Body Cabin
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.75, 4.4), bodyMat);
    body.position.y = 0.95;
    body.castShadow = true;
    body.receiveShadow = true;
    this.carGroup.add(body);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 1.4), bodyMat);
    hood.position.set(0, 1.34, -1.4);
    if (this.isWrecked) hood.rotation.set(-0.14, 0.05, 0.04);
    this.carGroup.add(hood);

    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.08, 0.4), trimMat);
    scoop.position.set(0, 1.42, -1.35);
    this.carGroup.add(scoop);

    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.38, 0.1), chromeMat);
    grille.position.set(0, 0.95, -2.26);
    this.carGroup.add(grille);

    // 3. Cabin Greenhouse & Windows
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.85, 2.6), bodyMat);
    cabin.position.set(0, 1.65, 0.3);
    cabin.castShadow = true;
    this.carGroup.add(cabin);

    const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.8), glassMat);
    windshield.position.set(0, 1.68, -0.98);
    windshield.rotation.x = -0.55;
    this.carGroup.add(windshield);

    const rearWindow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.65), glassMat);
    rearWindow.position.set(0, 1.72, 1.61);
    rearWindow.rotation.x = 0.25;
    this.carGroup.add(rearWindow);

    [-0.98, 0.98].forEach(side => {
      const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.6), glassMat);
      sideGlass.position.set(side, 1.68, 0.3);
      sideGlass.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      this.carGroup.add(sideGlass);
    });

    // 3b. Cabin Interior Dashboard, Steering Wheel & Gauges
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.85 });
    const dashboard = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.45, 0.55), dashMat);
    dashboard.position.set(0, 1.35, -0.65);
    this.carGroup.add(dashboard);

    const clusterMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.18), clusterMat);
    cluster.position.set(-0.42, 1.48, -0.38);
    cluster.rotation.x = -0.35;
    this.carGroup.add(cluster);

    const wheelTorus = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.03, 8, 16), rubberMat);
    wheelTorus.position.set(-0.42, 1.48, -0.28);
    wheelTorus.rotation.x = -0.45;
    this.carGroup.add(wheelTorus);
    this.steeringWheel = wheelTorus;

    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.09, 0.03), chromeMat);
    mirror.position.set(0, 1.95, -0.7);
    this.carGroup.add(mirror);

    // 4. Roof Rack with Spare Tire & Survival Crates
    const rack = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 2.4), trimMat);
    rack.position.set(0, 2.12, 0.3);
    this.carGroup.add(rack);

    const spareTire = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.24, 12), rubberMat);
    spareTire.position.set(-0.35, 2.26, 0.4);
    this.carGroup.add(spareTire);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.7), new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.8 }));
    crate.position.set(0.42, 2.30, 0.3);
    this.carGroup.add(crate);

    // 5. Four Rotating Wheels
    const wheelPositions = [
      { x: -1.15, y: 0.46, z: -1.45 },
      { x: 1.15, y: 0.46, z: -1.45 },
      { x: -1.15, y: 0.46, z: 1.45 },
      { x: 1.15, y: 0.46, z: 1.45 }
    ];

    wheelPositions.forEach((pos) => {
      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(pos.x, pos.y, pos.z);

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.32, 16), rubberMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wheelGroup.add(tire);

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.33, 10), rimMat);
      rim.rotation.z = Math.PI / 2;
      wheelGroup.add(rim);

      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.15, 8), chromeMat);
      disc.rotation.z = Math.PI / 2;
      wheelGroup.add(disc);

      this.wheels.push(wheelGroup);
      this.carGroup.add(wheelGroup);
    });

    // 6. Dual Headlights with Real Light Cones & SpotLights
    [-0.72, 0.72].forEach((hx) => {
      const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 10), chromeMat);
      bezel.rotation.x = Math.PI / 2;
      bezel.position.set(hx, 0.95, -2.26);
      this.carGroup.add(bezel);

      const lensMat = new THREE.MeshBasicMaterial({ color: 0xfffae0 });
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.13, 10), lensMat);
      lens.rotation.x = Math.PI / 2;
      lens.position.set(hx, 0.95, -2.26);
      this.carGroup.add(lens);

      const spot = new THREE.SpotLight(0xfff4db, 3.2, 55, 0.42, 0.65, 1.5);
      spot.position.set(hx, 0.95, -2.35);
      const target = new THREE.Object3D();
      target.position.set(hx, 0.2, -18.0);
      this.carGroup.add(spot);
      this.carGroup.add(target);
      spot.target = target;
      this.headlights.push(spot);

      const coneGeom = new THREE.ConeGeometry(1.6, 9.0, 12, 1, true);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfffae0,
        opacity: 0.18,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const cone = new THREE.Mesh(coneGeom, coneMat);
      cone.position.set(hx, 0.85, -6.8);
      cone.rotation.x = -Math.PI / 2;
      this.carGroup.add(cone);
    });

    // 7. Interior Cabin: Dashboard, Steering Wheel, Speedo & Glowing Retro CB Radio!
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.32, 0.55), trimMat);
    dash.position.set(0, 1.45, -0.65);
    this.carGroup.add(dash);

    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6), trimMat);
    column.rotation.x = 0.55;
    column.position.set(-0.48, 1.52, -0.42);
    this.carGroup.add(column);

    const wheelMesh = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 6, 12), trimMat);
    wheelMesh.rotation.x = 0.55;
    wheelMesh.position.set(-0.48, 1.64, -0.32);
    this.carGroup.add(wheelMesh);

    const speedo = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.12), new THREE.MeshBasicMaterial({ color: 0x10b981 }));
    speedo.position.set(-0.48, 1.55, -0.48);
    speedo.rotation.x = -0.35;
    this.carGroup.add(speedo);

    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.22), new THREE.MeshStandardMaterial({ color: 0x111827 }));
    radio.position.set(0, 1.35, -0.55);
    this.carGroup.add(radio);

    const radioScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.07), new THREE.MeshBasicMaterial({ color: 0xf59e0b }));
    radioScreen.position.set(0, 1.37, -0.43);
    this.carGroup.add(radioScreen);

    const radioLight = new THREE.PointLight(0xf59e0b, 1.4, 4);
    radioLight.position.set(0, 1.40, -0.40);
    this.carGroup.add(radioLight);

    [-0.48, 0.48].forEach(sx => {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.5), trimMat);
      seat.position.set(sx, 1.15, 0.1);
      this.carGroup.add(seat);
      const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.12), trimMat);
      headrest.position.set(sx, 1.62, 0.32);
      this.carGroup.add(headrest);
    });

    // 8. Wrecked Version Additions (Driver Door Ajar & Steaming Radiator)
    if (this.isWrecked) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.95, 1.1), bodyMat);
      door.position.set(-1.38, 1.35, -0.2);
      door.rotation.y = 0.75; // Open door
      this.carGroup.add(door);

      if (this.headlights[1]) this.headlights[1].intensity = 0.6;
      this.steamParticles = new FlameParticleSystem(this.scene, 28, 0.14, 1.5, 0.22);
    }

    this.root.add(this.carGroup);
  }

  attemptLoadGLB() {
    const loader = new GLTFLoader();
    loader.load(
      './assets/suv.glb',
      (gltf) => {
        try {
          this.glbSUV = gltf.scene;
          this.glbSUV.scale.set(1.2, 1.2, 1.2);
          this.glbSUV.traverse(c => {
            if (c.isMesh) {
              c.castShadow = true;
              c.receiveShadow = true;
            }
          });
          this.root.add(this.glbSUV);
          this.carGroup.visible = false;
        } catch (e) {
          console.warn('GLB SUV load error:', e);
        }
      },
      undefined,
      (err) => {}
    );
  }

  update(delta, speed = 0) {
    if (speed !== 0 && this.wheels.length > 0) {
      this.wheels.forEach(w => {
        w.rotation.x += delta * speed * 2.5;
      });
    }

    if (this.isWrecked && this.steamParticles) {
      const radiatorPos = new THREE.Vector3();
      this.carGroup.getWorldPosition(radiatorPos);
      radiatorPos.y += 0.85;
      radiatorPos.z -= 1.8;
      this.steamParticles.update(delta, radiatorPos, true);
    }
  }
}

// ---------------------------------------------------------------------------
// 3D SEARCH & RESCUE HELICOPTER (Twin Turbines, Animated Rotors & Searchlight)
// ---------------------------------------------------------------------------
class RescueHelicopter {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.mainRotor = null;
    this.tailRotor = null;
    this.searchlight = null;
    this.buildHelicopter();
    this.scene.add(this.root);
    this.root.visible = false;
  }

  buildHelicopter() {
    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, metalness: 0.6 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65, roughness: 0.1 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });

    // Fuselage
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 5.8), yellowMat);
    body.position.y = 1.8;
    body.castShadow = true;
    this.root.add(body);

    // Nose Cone
    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.8, 6), yellowMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 1.7, -3.6);
    this.root.add(nose);

    // Cockpit Windshield
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.8), glassMat);
    cockpit.position.set(0, 2.0, -2.4);
    this.root.add(cockpit);

    // Twin Top Turbines
    const turbine = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 3.2), darkMat);
    turbine.position.set(0, 3.1, -0.2);
    this.root.add(turbine);

    // Main Rotor Mast & Blades
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 8), steelMat);
    mast.position.set(0, 3.8, -0.2);
    this.root.add(mast);

    this.mainRotor = new THREE.Group();
    this.mainRotor.position.set(0, 4.3, -0.2);
    for (let b = 0; b < 2; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 10.5), darkMat);
      blade.rotation.y = (b * Math.PI) / 2;
      this.mainRotor.add(blade);
    }
    this.root.add(this.mainRotor);

    // Tail Boom
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 6.5, 6), yellowMat);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 2.2, 5.8);
    this.root.add(boom);

    // Tail Fin & Tail Rotor
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.8, 0.9), darkMat);
    fin.position.set(0, 2.8, 8.8);
    this.root.add(fin);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.25, 3.1, 8.8);
    const tBlade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.8, 0.15), darkMat);
    this.tailRotor.add(tBlade);
    this.root.add(this.tailRotor);

    // Landing Skids
    [-1.2, 1.2].forEach(sx => {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5.4, 6), steelMat);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(sx, 0.35, 0);
      this.root.add(skid);

      [-1.4, 1.4].forEach(sz => {
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 5), steelMat);
        strut.position.set(sx, 0.95, sz);
        this.root.add(strut);
      });
    });

    // High-Intensity Downward Searchlight
    this.searchlight = new THREE.SpotLight(0xfffaea, 8.0, 140, Math.PI / 4, 0.4, 1.2);
    this.searchlight.position.set(0, 1.2, -1.8);
    this.searchlight.target.position.set(0, -25, -5.0);
    this.root.add(this.searchlight);
    this.root.add(this.searchlight.target);

    // Searchlight Lens Glow
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfffaea }));
    lens.position.set(0, 1.2, -1.8);
    this.root.add(lens);
  }

  update(delta) {
    if (this.mainRotor) this.mainRotor.rotation.y += delta * 28.0;
    if (this.tailRotor) this.tailRotor.rotation.x += delta * 36.0;
  }
}

// ---------------------------------------------------------------------------
// MASTER 3D GAME ENGINE
// ---------------------------------------------------------------------------
class FrostboundGame {
  constructor() {
    this.container = document.getElementById('game-container');
    this.sfx = new SoundEffects();

    // Vitals
    this.health = 100;
    this.warmth = 100;
    this.hunger = 85;
    this.energy = 100;
    this.torchFuel = 100;
    this.isTorchOn = true;

    // Time & Weather: Starts at 17.5 (Soft Sunset Golden Hour!)
    this.timeOfDay = 17.5;
    this.dayCount = 1;
    this.timeSpeed = 0.02; // Slow, immersive sunset time cycle
    this.weather = 'clear';

    // Inventory
    this.inventory = [
      { id: 'matches', name: 'Flint & Matches', icon: '🔥', count: 3 },
      { id: 'wood', name: 'Dry Pine Wood', icon: '🪵', count: 4 },
      { id: 'cloth', name: 'Cloth Scrap', icon: '🧣', count: 2 },
      { id: 'ration', name: 'Canned Food', icon: '🥫', count: 1 }
    ];
    this.isBackpackOpen = false;

    // Map & Fullscreen Map System (Unlocked via Cabin Map Item)
    this.hasMap = false;
    this.isMapOpen = false;
    this.signalFiresLit = 0;

    // Linear Story & Mission System: 8 Sequential Missions with Physical Gates
    this.missions = [
      {
        id: 'suv_loot',
        chapter: 'CHAPTER 1',
        title: 'The Avalanche Blockade',
        zone: 'Zone 1: Crash Site',
        coords: { x: -180, z: 518 },
        icon: '🚗',
        completed: false,
        active: true,
        desc: 'Loot vital survival supplies from the damaged SUV storage (Oil, Matches, Blanket, Food, Torch).'
      },
      {
        id: 'first_night',
        chapter: 'CHAPTER 2',
        title: 'Survive First Night',
        zone: 'Zone 1/2: Canyon Ridge',
        coords: { x: -140, z: 460 },
        icon: '🔥',
        completed: false,
        active: false,
        duskDeadline: 19.0, // 19:00 Dusk Deadline
        desc: 'Sunset is falling fast. Gather dry pine wood and build a campfire before dark to prevent freezing.'
      },
      {
        id: 'village_bridge',
        chapter: 'CHAPTER 3',
        title: 'The Abandoned Village',
        zone: 'Zone 2: Pine Outpost',
        coords: { x: 165, z: 245 },
        icon: '🏚️',
        completed: false,
        active: false,
        progress: 0,
        total: 3,
        desc: 'Search village cabins for 3 bridge repair items (Winch Gear, Steel Cable, Crank) and lower the drawbridge.'
      },
      {
        id: 'meadow_sustenance',
        chapter: 'CHAPTER 4',
        title: 'Alpine Sustenance',
        zone: 'Zone 3: Glacial Valley',
        coords: { x: -30, z: 25 },
        icon: '🫐',
        completed: false,
        active: false,
        foodProgress: 0,
        foodTotal: 3,
        hasWater: false,
        desc: 'Gather sustenance: Harvest food (0/3 berries/fish) and collect fresh meltwater from the lake shore.'
      },
      {
        id: 'meadow_fuel',
        chapter: 'CHAPTER 4',
        title: 'Locate Auxiliary Fuel',
        zone: 'Zone 3/4: Meadow Cache',
        coords: { x: -45, z: -120 },
        icon: '⛽',
        completed: false,
        active: false,
        desc: 'Retrieve the heavy diesel fuel canister from the surveyor tent cache to power the mountain gate.'
      },
      {
        id: 'generator',
        chapter: 'CHAPTER 5',
        title: 'Power Mountain Gate',
        zone: 'Zone 4: Hunter Camp',
        coords: { x: -70, z: -235 },
        icon: '⚡',
        completed: false,
        active: false,
        desc: 'Pour diesel fuel into the camp generator and pull the starter cord to power the Khai Security Gate.'
      },
      {
        id: 'rope_bridge',
        chapter: 'CHAPTER 5',
        title: 'Cross the Khai Chasm',
        zone: 'Zone 5: Khai Ravine',
        coords: { x: -20, z: -430 },
        icon: '🌉',
        completed: false,
        active: false,
        desc: 'Traverse the swaying rope suspension bridge spanning across the deep Khai Gorge abyss.'
      },
      {
        id: 'radio_tower',
        chapter: 'CHAPTER 6',
        title: 'Distress Call & Rescue',
        zone: 'Zone 5: Summit Peak',
        coords: { x: 0, z: -560 },
        icon: '📡',
        completed: false,
        active: false,
        desc: 'Climb the radio tower platform, align the microwave antenna dish, and transmit the emergency beacon for helicopter rescue.'
      }
    ];

    // Gate Progression System: Unlocked sequentially through missions
    this.gates = {
      suvBlockade: false,   // Unlocked by Mission 1 (Looting SUV)
    };

    // Last safe position for unstuck (U key)
    this.lastSafePosition = new THREE.Vector3(-178, getTerrainHeight(-178, 517) + 0.5, 517);
    this.lastSafePositionTimer = 0;

    // Re-declare gates after inserting safe pos tracking
    delete this.gates;
    this.gates = {
      suvBlockade: false,
      firstNight: false,    // Unlocked by Mission 2 (Building Campfire)
      villageBridge: false, // Unlocked by Mission 3 (Lowering Gorge Drawbridge)
      meadowPass: false,    // Unlocked by Mission 5 (Meadow Fuel Found)
      khaiSecurity: false,  // Unlocked by Mission 6 (Generator Powered)
      ropeBridge: false,    // Unlocked by Mission 7 (Rope Bridge Crossed)
      radioTower: false,    // Unlocked by Mission 8 (Antenna Calibrated)
      helicopterRescue: false // Unlocked by Mission 8 (Helicopter Touchdown)
    };

    // Story Tracking State
    this.villagePartsCollected = 0;
    this.foodCollected = 0;
    this.hasWater = false;
    this.isSUVIntro = false;
    this.suvIntroTime = 0;
    this.suvBouldersFallen = false;
    this.isHelicopterRescue = false;
    this.helicopterRescueTime = 0;

    this.isPlaying = false;
    this.isDead = false;
    this.isVictory = false;

    this.interactables = [];
    this.shadowWolves = [];
    this.campfires = [];

    // Character Controller Physics & Locomotion
    this.verticalVelocity = 0;
    this.isGrounded = true;
    this.isSliding = false;
    this.fallStartY = 0;
    this.wasInAir = false;
    this.screenShake = 0;

    this.keys = {};
    this.cameraPitch = 0;
    this.cameraYaw = -0.64; // Facing North-Northeast along the road towards Zone 2

    // Camera Modes: First-Person (Default) & Third-Person (V key)
    this.cameraMode = 'first'; // 'first' | 'third'
    this.thirdPersonCamPos = new THREE.Vector3();
    this.thirdPersonCamPosInitialized = false;

    // Cinematic Cameras: Intro Pan & 60s Scripted Trailer Mode
    this.isIntroPanning = false;
    this.introPanStartTime = 0;
    this.introDuration = 4.5;
    this.isTrailerMode = false;
    this.trailerStartTime = 0;
    this.trailerDuration = 60.0;
    this.lastBeaconAttempt = 0;

    this.initThree();
    this.buildWorld();
    this.initMinimap();
    this.setupEvents();
    this.updateHUD();
    this.updateMissionHUD();
    this.render();
  }

  initThree() {
    this.scene = new THREE.Scene();
    // Soft Sunset Dusk Color Palette & FogExp2 Tint
    this.scene.background = new THREE.Color(0x6e5262);
    this.scene.fog = new THREE.FogExp2(0x6e5262, 0.0033);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1400);
    const spawnX = -178.0;
    const spawnZ = 517.0;
    const spawnY = getTerrainHeight(spawnX, spawnZ);
    this.camera.position.set(spawnX, spawnY + 2.1, spawnZ);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.container.appendChild(this.renderer.domElement);

    // Three.js Postprocessing: EffectComposer, RenderPass, UnrealBloomPass, CinematicPostShader, OutputPass
    this.usePostProcessing = true;
    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    // Subtle bloom: glowing sun, campfires, beacons without washing out ground
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.38, // strength
      0.45, // radius
      0.82  // threshold
    );
    this.composer.addPass(this.bloomPass);

    this.cinematicPass = new ShaderPass(CinematicPostShader);
    this.composer.addPass(this.cinematicPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    this.initHDRI();

    // Sky Dome enclosing 1200m world with warm sunset gradient
    const skyGeom = new THREE.SphereGeometry(1100, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({ color: 0x7c5a6d, side: THREE.BackSide });
    this.skyMesh = new THREE.Mesh(skyGeom, skyMat);
    this.scene.add(this.skyMesh);

    // God-Rays-Like Warm Sun with multi-layered glowing corona
    this.sunGroup = new THREE.Group();

    const sunGeom = new THREE.SphereGeometry(22, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfffaea });
    this.sunOrb = new THREE.Mesh(sunGeom, sunMat);
    this.sunGroup.add(this.sunOrb);

    // Realistic god-rays radial corona billboard
    const coronaTexture = createSunCoronaTexture();
    const coronaGeom = new THREE.PlaneGeometry(360, 360);
    const coronaMat = new THREE.MeshBasicMaterial({
      map: coronaTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.sunCoronaSprite = new THREE.Mesh(coronaGeom, coronaMat);
    this.sunGroup.add(this.sunCoronaSprite);

    this.scene.add(this.sunGroup);

    // Warm Sunset Ambient, Hemisphere & Directional Sun Light
    this.hemiLight = new THREE.HemisphereLight(0x8a7082, 0x483a30, 0.85);
    this.scene.add(this.hemiLight);

    this.ambientLight = new THREE.AmbientLight(0x6e5e74, 0.75);
    this.scene.add(this.ambientLight);

    // Single large high-resolution shadow map following the player
    this.sunLight = new THREE.DirectionalLight(0xffa153, 1.85);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 450;
    this.sunLight.shadow.camera.left = -95;
    this.sunLight.shadow.camera.right = 95;
    this.sunLight.shadow.camera.top = 95;
    this.sunLight.shadow.camera.bottom = -95;
    this.sunLight.shadow.bias = -0.0006;
    this.scene.add(this.sunLight);

    // Player Object & Torch (Grounded near Wrecked Truck in Zone 1)
    this.player = new THREE.Group();
    this.player.position.set(spawnX, spawnY + 0.5, spawnZ);
    this.scene.add(this.player);
    this.scene.add(this.camera);

    // First-Person Arms System (arms/hands attached to camera, holding items, lighting up from torch)
    this.fpArms = new FirstPersonArmsSystem(this.camera, this.scene);
    this.fpArms.setHeldItem('torch');

    // Maintain torchLight & flameMesh compatibility for HUD and logic
    this.torchLight = this.fpArms.handTorchLight;
    this.flameMesh = this.fpArms.flameMesh;

    // Third-Person Animated Player Model
    this.thirdPersonPlayer = new ThirdPersonPlayerSystem(this.scene);
    this.thirdPersonPlayer.setFirstPerson(this.cameraMode === 'first');

    // Real Flame & Spark Particle System for the Torch
    this.torchFlameParticles = new FlameParticleSystem(this.scene, 22, 0.08, 0.9, 0.16);

    this.createSnowParticles();

    // 3D Search & Rescue Helicopter for Chapter 6 Ending Cutscene
    this.rescueHelicopter = new RescueHelicopter(this.scene);
  }

  initHDRI() {
    this.rgbeLoader = new RGBELoader();
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.rgbeLoader.load(
      './assets/hdri/sky_day.hdr',
      (texture) => {
        this.dayHdrTexture = texture;
        this.dayEnvMap = this.pmremGenerator.fromEquirectangular(texture).texture;
        this.updateSkyByTimeOfDay();
      },
      undefined,
      (err) => console.warn('Day HDRI load error:', err)
    );

    this.rgbeLoader.load(
      './assets/hdri/sky_night.hdr',
      (texture) => {
        this.nightHdrTexture = texture;
        this.nightEnvMap = this.pmremGenerator.fromEquirectangular(texture).texture;
        this.updateSkyByTimeOfDay();
      },
      undefined,
      (err) => console.warn('Night HDRI load error:', err)
    );
  }

  updateSkyByTimeOfDay() {
    const isNight = this.timeOfDay < 6.0 || this.timeOfDay > 18.0;
    if (isNight) {
      if (this.nightEnvMap) this.scene.environment = this.nightEnvMap;
      if (this.nightHdrTexture) {
        this.scene.background = this.nightHdrTexture;
        if (this.skyMesh) this.skyMesh.visible = false;
      }
      // Night blue moonlight
      if (this.sunLight) {
        this.sunLight.color.setHex(0x5a7ca8);
        this.sunLight.intensity = 0.65;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(0x1a2638);
        this.ambientLight.intensity = 0.45;
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0x2a3852);
        this.hemiLight.groundColor.setHex(0x0a121e);
      }
      if (this.bloomPass) this.bloomPass.strength = 0.60;
    } else {
      if (this.dayEnvMap) this.scene.environment = this.dayEnvMap;
      if (this.dayHdrTexture) {
        this.scene.background = this.dayHdrTexture;
        if (this.skyMesh) this.skyMesh.visible = false;
      }
      // Day warm golden-hour / sunlight
      if (this.sunLight) {
        this.sunLight.color.setHex(0xffa153);
        this.sunLight.intensity = 1.85;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(0x6e5e74);
        this.ambientLight.intensity = 0.75;
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0x8a7082);
        this.hemiLight.groundColor.setHex(0x483a30);
      }
      if (this.bloomPass) this.bloomPass.strength = 0.38;
    }
  }

  togglePostProcessing() {
    this.usePostProcessing = !this.usePostProcessing;
    const desc = document.getElementById('postproc-desc');
    if (desc) {
      desc.textContent = this.usePostProcessing ? 'POST-FX: ON [P]' : 'POST-FX: OFF [P]';
    }
    this.showToast(this.usePostProcessing 
      ? 'Post-Processing: ON (Bloom + ACES Tone Mapping + SSAO + Vignette)' 
      : 'Post-Processing: OFF (Maximum Performance Mode)');
  }

  createSnowParticles() {
    // Light falling snow (not blizzard) with subtle flurries
    const snowCount = 1400;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(snowCount * 3);
    const velocities = new Float32Array(snowCount * 3);

    const px = this.player ? this.player.position.x : -178;
    const py = this.player ? this.player.position.y : 0;
    const pz = this.player ? this.player.position.z : 517;

    for (let i = 0; i < snowCount; i++) {
      positions[i * 3] = px + (Math.random() - 0.5) * 64;
      positions[i * 3 + 1] = py + Math.random() * 26 - 4;
      positions[i * 3 + 2] = pz + (Math.random() - 0.5) * 64;

      velocities[i * 3] = (Math.random() - 0.5) * 0.12;
      velocities[i * 3 + 1] = -1.1 - Math.random() * 0.6; // Light gentle fall (~1.1 to 1.7 m/s)
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      map: createSnowTexture(),
      color: 0xffffff,
      size: 0.35,
      transparent: true,
      opacity: 0.75,
      depthWrite: false
    });

    this.snowParticles = new THREE.Points(geom, mat);
    this.snowVelocities = velocities;
    this.scene.add(this.snowParticles);
  }

  buildWorld() {
    // 1. Procedural 1200x1200m Alpine World with Vertex Colors & CC0 Texture Splatting
    const terrainSize = 1200;
    const segments = 256;
    const terrainGeom = new THREE.PlaneGeometry(terrainSize, terrainSize, segments, segments);
    terrainGeom.rotateX(-Math.PI / 2);

    const pos = terrainGeom.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getTerrainHeight(x, z);
      pos.setY(i, y);

      const [r, g, b] = getZoneGroundColor(x, z, y);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    terrainGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeom.computeVertexNormals();

    const terrainMat = createPBRTerrainMaterial();

    this.terrain = new THREE.Mesh(terrainGeom, terrainMat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    // Physical Colliders
    this.colliders = [];

    // 2. Zone 3: Frozen Lake & Glacial Monolith Spire
    this.buildFrozenLake();

    // 3. Zone 3: Wooden Truss River Bridge
    this.buildWoodenBridge();

    // 4. Encircling Mountain Backdrop Peaks
    this.buildMountainRanges();

    // 5. 1728m Carved Dirt & Gravel Mountain Road
    this.buildRoadMesh();

    // 6. Zone 1: Wrecked Truck, Rockslide & Flare Mast
    this.buildCrashSite();

    // 7. InstancedMesh for ALL Vegetation (5 GLB Tree & Shrub Types with Noise Density & Random Lean)
    this.populateNature();

    // Props (Rocks, Fallen Logs, Broken Fences, Barrels)
    this.buildProps();

    // Instanced Grass Blades & Wildflowers with Wind Sway & 60m Distance Culling
    this.buildGrassAndWildflowers();

    // Interactive Harvestable Berry Bushes & Pine Logs
    this.buildInteractiveResources();

    // 8. Zone 2: High Timber Watchtower Landmark
    this.buildWatchtowerLandmark();

    // 8b. Zone 2/3: Abandoned Village with Evacuation Lore & Gorge Drawbridge Parts
    this.buildAbandonedVillage();

    // 9. Zone 4: Hunter Camp Compound, Workshop & Rotating Windmill
    this.buildHunterCampWorkshop();

    // 9b. Zone 5: Khai Ravine Swaying Rope Suspension Bridge
    this.buildKhaiRopeBridge();

    // 10. Zone 5: Radio Tower & Distress Beacon Peak
    this.buildRadioTower();

    // 11. Alternate Route Markers (Meadow cairns, lake ice ramp, hunter ridge)
    this.buildAlternateRoutes();

    // 12. Zone 5 Khai Gorge Return Rope Ladder
    this.buildRopeLadder();

    // 13. Shadow Wolves stationed along the 1728m journey
    this.spawnShadowWolves();

    // 14. Gate 1: Canyon Rockslide Barricade (Zone 1/2 Pass)
    this.buildCanyonRockslideGate();

    // 15. Gate 3: Khai Ridge High-Security Gate (Zone 4/5 Pass)
    this.buildTowerSecurityGate();

    // 16. Mission 3: 3 Alpine Signal Fire Pyres
    this.buildSignalFirePyres();

    // 17. Mission 6: Tower Telemetry Antenna Substation
    this.buildTowerTelemetrySubstation();

    // 18. Working Machines: Water Wheel at River & Wind Turbine on Ridge
    this.buildRiverWaterWheel();
    this.buildRidgeWindTurbine();

    // 19. Living Wildlife: Deer Herd, Rabbit Colony, Bird Flocks, Fish School
    this.deerHerd = new DeerHerd(this.scene);
    this.rabbitColony = new RabbitColony(this.scene);
    this.birdFlocks = new BirdFlocks(this.scene);
    this.fishSchool = new FishSchool(this.scene);
  }

  rebuildTerrainMesh() {
    if (!this.terrain) return;
    const pos = this.terrain.geometry.attributes.position;
    const colors = this.terrain.geometry.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getTerrainHeight(x, z);
      pos.setY(i, y);
      if (colors) {
        const [r, g, b] = getZoneGroundColor(x, z, y);
        colors.setXYZ(i, r, g, b);
      }
    }
    pos.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
  }

  getTerrainHeight(x, z) {
    return getTerrainHeight(x, z);
  }

  buildMountainRanges() {
    const texLoader = new THREE.TextureLoader();
    const rockTexture = texLoader.load(rockTexUrl);
    rockTexture.wrapS = THREE.RepeatWrapping;
    rockTexture.wrapT = THREE.RepeatWrapping;
    rockTexture.repeat.set(6, 6);
    rockTexture.colorSpace = THREE.SRGBColorSpace;

    const peakMat = new THREE.MeshStandardMaterial({
      map: rockTexture,
      color: 0x3e434e, // Weathered alpine granite cliffs
      roughness: 0.92,
      metalness: 0.08
    });

    const peakAngles = [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.45, 2.8, 3.15, 3.5, 3.85, 4.2, 4.55, 4.9, 5.25, 5.6, 5.95];
    peakAngles.forEach((angle, i) => {
      const radius = 560 + (i % 3) * 45;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;
      const height = 150 + (i % 4) * 45;
      const width = 130 + (i % 3) * 40;

      const peakGeom = new THREE.ConeGeometry(width, height, 5);
      const peakMesh = new THREE.Mesh(peakGeom, peakMat);
      peakMesh.position.set(px, height / 2 - 10, pz);
      peakMesh.rotation.y = angle * 1.5;
      this.scene.add(peakMesh);
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 3: ANIMATED WATER LAKE & RIVER, FROZEN EDGE RIM & GLACIAL SPIRE
  // ---------------------------------------------------------------------------
  buildFrozenLake() {
    const lakeX = -35.0;
    const lakeZ = 40.0;
    const lakeRadius = 65.0;
    const lakeY = 5.2;

    this.waterMat = createWaterMaterial();

    // 1. Semi-Transparent Animated Shader Water Lake Surface
    const lakeGeom = new THREE.CircleGeometry(lakeRadius - 3.5, 48);
    lakeGeom.rotateX(-Math.PI / 2);
    const lakeMesh = new THREE.Mesh(lakeGeom, this.waterMat);
    lakeMesh.position.set(lakeX, lakeY, lakeZ);
    lakeMesh.receiveShadow = true;
    this.scene.add(lakeMesh);

    // 2. Frozen Edge Ice Rim around lake perimeter
    const iceEdgeGeom = new THREE.RingGeometry(lakeRadius - 5.5, lakeRadius + 2.5, 48);
    iceEdgeGeom.rotateX(-Math.PI / 2);
    const iceEdgeMat = new THREE.MeshStandardMaterial({
      color: 0xebf8ff,
      roughness: 0.62,
      metalness: 0.28,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide
    });
    const iceRimMesh = new THREE.Mesh(iceEdgeGeom, iceEdgeMat);
    iceRimMesh.position.set(lakeX, lakeY + 0.03, lakeZ);
    this.scene.add(iceRimMesh);

    // 3. Flowing River Water Ribbon connecting through the gorge into the lake
    const riverWaypoints = [
      new THREE.Vector3(14, 5.1, -16),
      new THREE.Vector3(-2, 5.14, 0),
      new THREE.Vector3(-18, 5.18, 16),
      new THREE.Vector3(-28, 5.2, 28),
      new THREE.Vector3(-35, 5.2, 40)
    ];
    const riverSpline = new THREE.CatmullRomCurve3(riverWaypoints);
    const riverSegments = 28;
    const riverWidth = 9.2;
    const rPositions = [];
    const rUvs = [];

    for (let i = 0; i <= riverSegments; i++) {
      const t = i / riverSegments;
      const pt = riverSpline.getPoint(t);
      const tan = riverSpline.getTangent(t).normalize();
      const norm = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      rPositions.push(pt.x + norm.x * riverWidth * 0.5, pt.y, pt.z + norm.z * riverWidth * 0.5);
      rPositions.push(pt.x - norm.x * riverWidth * 0.5, pt.y, pt.z - norm.z * riverWidth * 0.5);
      rUvs.push(0, t * 10, 1, t * 10);
    }
    const rIndices = [];
    for (let i = 0; i < riverSegments; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      rIndices.push(a, b, c, b, d, c);
    }
    const riverGeom = new THREE.BufferGeometry();
    riverGeom.setAttribute('position', new THREE.Float32BufferAttribute(rPositions, 3));
    riverGeom.setAttribute('uv', new THREE.Float32BufferAttribute(rUvs, 2));
    riverGeom.setIndex(rIndices);
    riverGeom.computeVertexNormals();

    const riverMesh = new THREE.Mesh(riverGeom, this.waterMat);
    riverMesh.receiveShadow = true;
    this.scene.add(riverMesh);

    // River Frozen Banks (Ice shelves along river edges)
    const bankIceMat = new THREE.MeshStandardMaterial({
      color: 0xe0f2fe,
      roughness: 0.7,
      metalness: 0.2,
      transparent: true,
      opacity: 0.88
    });
    for (let s = 0; s < 5; s++) {
      const st = s / 4;
      const spt = riverSpline.getPoint(st);
      const stan = riverSpline.getTangent(st).normalize();
      const snorm = new THREE.Vector3(-stan.z, 0, stan.x).normalize();
      [-1, 1].forEach(side => {
        const iceShelf = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.25, 2.8), bankIceMat);
        iceShelf.position.set(
          spt.x + snorm.x * (riverWidth * 0.55 + 1.2) * side,
          spt.y + 0.08,
          spt.z + snorm.z * (riverWidth * 0.55 + 1.2) * side
        );
        iceShelf.rotation.y = Math.atan2(stan.x, stan.z);
        this.scene.add(iceShelf);
      });
    }

    // Far-Away Visible Landmark: Glacial Monolith Spire (42m high glowing cyan ice needle)
    const spireX = -40.0;
    const spireZ = 50.0;
    const spireHeight = 42.0;

    const spireGeom = new THREE.ConeGeometry(4.8, spireHeight, 6);
    const spireMat = new THREE.MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: 0x0891b2,
      emissiveIntensity: 0.6,
      roughness: 0.15,
      metalness: 0.85
    });
    const spire = new THREE.Mesh(spireGeom, spireMat);
    spire.position.set(spireX, lakeY + spireHeight / 2, spireZ);
    spire.castShadow = true;
    this.scene.add(spire);

    const spireLight = new THREE.PointLight(0x38bdf8, 4.0, 110);
    spireLight.position.set(spireX, lakeY + spireHeight * 0.7, spireZ);
    this.scene.add(spireLight);

    this.colliders.push({
      type: 'sphere',
      center: new THREE.Vector2(spireX, spireZ),
      radius: 4.5
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 3: WOODEN TRUSS RIVER BRIDGE (Spanning gorge at x = -20, z = 20)
  // ---------------------------------------------------------------------------
  buildWoodenBridge() {
    const bridgeGroup = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3219, roughness: 0.9 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x2e1e0f, roughness: 0.95 });

    // Bridge deck segments along road from t = 0.44 to t = 0.48 (~36m length)
    const bridgeSteps = 24;
    const startT = 0.44;
    const endT = 0.48;
    const bridgeWidth = 4.8;

    for (let i = 0; i <= bridgeSteps; i++) {
      const t = startT + (i / bridgeSteps) * (endT - startT);
      const p = RoadCurve.getPoint(t);
      const tangent = RoadCurve.getTangent(t).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;

      // Heavy timber cross-beam
      const beam = new THREE.Mesh(new THREE.BoxGeometry(bridgeWidth, 0.35, 1.4), woodMat);
      beam.position.set(p.x, p.y + 0.18, p.z);
      beam.rotation.y = Math.atan2(tangent.x, tangent.z);
      beam.castShadow = true;
      beam.receiveShadow = true;
      bridgeGroup.add(beam);

      // Support Pilings anchored into the gorge floor
      if (i === 6 || i === 12 || i === 18) {
        [-bridgeWidth * 0.4, bridgeWidth * 0.4].forEach(offset => {
          const px = p.x + nx * offset;
          const pz = p.z + nz * offset;
          const groundY = getTerrainHeight(px, pz);
          const pilingH = Math.max(3.0, (p.y + 0.18) - groundY);
          const piling = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, pilingH, 6), darkWood);
          piling.position.set(px, groundY + pilingH / 2, pz);
          piling.castShadow = true;
          bridgeGroup.add(piling);
        });
      }

      // X-Truss Side Railing Posts
      [-bridgeWidth / 2, bridgeWidth / 2].forEach(side => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 5), darkWood);
        post.position.set(p.x + nx * side, p.y + 0.85, p.z + nz * side);
        post.castShadow = true;
        bridgeGroup.add(post);
      });
    }

    // Portal Lanterns at Bridge Entrances
    [startT, endT].forEach((portalT) => {
      const p = RoadCurve.getPoint(portalT);
      const tangent = RoadCurve.getTangent(portalT).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;

      const lanternLight = new THREE.PointLight(0xf59e0b, 2.5, 25);
      lanternLight.position.set(p.x + nx * 2.6, p.y + 2.2, p.z + nz * 2.6);
      bridgeGroup.add(lanternLight);

      const lanternOrb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), new THREE.MeshBasicMaterial({ color: 0xf59e0b }));
      lanternOrb.position.copy(lanternLight.position);
      bridgeGroup.add(lanternOrb);
    });

    // Gate 2: Drawbridge Portcullis & Mission 4 Winch Mechanism
    const gateP = RoadCurve.getPoint(startT);
    const gateTangent = RoadCurve.getTangent(startT).normalize();
    this.bridgeGateGroup = new THREE.Group();
    this.bridgeGateGroup.position.set(gateP.x, gateP.y + 0.2, gateP.z);
    this.bridgeGateGroup.rotation.y = Math.atan2(gateTangent.x, gateTangent.z);

    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.35 });
    for (let bar = -2.1; bar <= 2.1; bar += 0.55) {
      const pBar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.0, 6), ironMat);
      pBar.position.set(bar, 2.0, 0);
      pBar.castShadow = true;
      this.bridgeGateGroup.add(pBar);
    }
    const gateTop = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.25, 0.25), ironMat);
    gateTop.position.set(0, 3.8, 0);
    this.bridgeGateGroup.add(gateTop);
    this.scene.add(this.bridgeGateGroup);

    this.bridgeCollider = {
      id: 'col_bridge',
      type: 'aabb',
      minX: gateP.x - 3.2,
      maxX: gateP.x + 3.2,
      minZ: gateP.z - 3.2,
      maxZ: gateP.z + 3.2
    };
    this.colliders.push(this.bridgeCollider);

    // Winch Mechanism Interactable (Requires 3 Village Parts to Lower)
    this.createInteractable({
      id: 'mission_bridge',
      name: 'Bridge Winch (Requires 3 Village Parts to Lower)',
      pos: new THREE.Vector3(gateP.x - 3.5, gateP.y + 1.2, gateP.z + 2.0),
      icon: '🌉',
      reachRadius: 4.8,
      onInteract: () => {
        if (this.villagePartsCollected < 3) {
          this.sfx.playAttack();
          this.showToast(`Drawbridge Winch missing parts! Scavenge 3 parts from Abandoned Village cabins (${this.villagePartsCollected}/3).`);
        } else {
          this.lowerDrawbridge();
        }
      }
    });

    this.scene.add(bridgeGroup);
  }

  buildRoadMesh() {
    const numSteps = 400;
    const roadWidth = 4.4;

    const roadGeom = new THREE.BufferGeometry();
    const positions = [];
    const uvs = [];

    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const p = RoadCurve.getPoint(t);
      const tangent = RoadCurve.getTangent(t).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const len = Math.hypot(nx, nz) || 1;
      const normX = nx / len;
      const normZ = nz / len;

      const halfW = roadWidth / 2;
      const leftX = p.x + normX * halfW;
      const leftZ = p.z + normZ * halfW;
      const rightX = p.x - normX * halfW;
      const rightZ = p.z - normZ * halfW;

      const leftY = getTerrainHeight(leftX, leftZ) + 0.05;
      const rightY = getTerrainHeight(rightX, rightZ) + 0.05;

      positions.push(leftX, leftY, leftZ);
      positions.push(rightX, rightY, rightZ);

      uvs.push(0, t * 50, 1, t * 50);
    }

    const indices = [];
    for (let i = 0; i < numSteps; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }

    roadGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeom.setIndex(indices);
    roadGeom.computeVertexNormals();

    const texLoader = new THREE.TextureLoader();
    const dirtDiff = texLoader.load('./assets/textures/dirt_diff.jpg');
    dirtDiff.wrapS = THREE.RepeatWrapping;
    dirtDiff.wrapT = THREE.RepeatWrapping;
    dirtDiff.repeat.set(2, 60);
    dirtDiff.colorSpace = THREE.SRGBColorSpace;

    const dirtNor = texLoader.load('./assets/textures/dirt_nor.jpg');
    dirtNor.wrapS = THREE.RepeatWrapping;
    dirtNor.wrapT = THREE.RepeatWrapping;
    dirtNor.repeat.set(2, 60);

    const roadMat = new THREE.MeshStandardMaterial({
      map: dirtDiff,
      normalMap: dirtNor,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.92,
      metalness: 0.04
    });

    roadMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        // Dual tire tracks at u ~ 0.28 and u ~ 0.72
        float distTrack1 = abs(vUv.x - 0.28);
        float distTrack2 = abs(vUv.x - 0.72);
        float track1 = 1.0 - smoothstep(0.04, 0.12, distTrack1);
        float track2 = 1.0 - smoothstep(0.04, 0.12, distTrack2);
        float trackMud = max(track1, track2);
        // Darken compressed wet tire treads in dirt/gravel
        diffuseColor.rgb *= (1.0 - trackMud * 0.38);
        `
      );
    };

    const roadMesh = new THREE.Mesh(roadGeom, roadMat);
    roadMesh.receiveShadow = true;
    this.scene.add(roadMesh);

    // Road Guide Marker Posts on the gentle ledge (RIGHT side before the drop)
    for (let i = 4; i < numSteps - 4; i += 10) {
      const t = i / numSteps;
      const pt = RoadCurve.getPoint(t);
      const tangent = RoadCurve.getTangent(t).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const len = Math.hypot(nx, nz) || 1;
      const postX = pt.x - (nx / len) * 2.8;
      const postZ = pt.z - (nz / len) * 2.8;
      const postY = getTerrainHeight(postX, postZ);

      const postGeom = new THREE.CylinderGeometry(0.09, 0.12, 1.8, 5);
      const postMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
      const post = new THREE.Mesh(postGeom, postMat);
      post.position.set(postX, postY + 0.85, postZ);
      post.castShadow = true;
      this.scene.add(post);

      const markerGeom = new THREE.SphereGeometry(0.12, 6, 6);
      const markerMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const marker = new THREE.Mesh(markerGeom, markerMat);
      marker.position.set(postX, postY + 1.75, postZ);
      this.scene.add(marker);
    }
  }

  // ---------------------------------------------------------------------------
  // ZONE 1: CRASH SITE, ROCKSLIDE & SOUTH VALLEY FLARE MAST LANDMARK
  // ---------------------------------------------------------------------------
  buildCrashSite() {
    const carX = -184.0;
    const carZ = 518.0;
    const suvGroundY = getTerrainHeight(carX, carZ);

    this.wreckedSUV = new RealisticSUVSystem(this.scene, true);
    this.wreckedSUV.root.position.set(carX, suvGroundY + 0.35, carZ);
    this.wreckedSUV.root.rotation.set(0.06, 0.45, 0.12); // Wrecked / impact tilt against rockslide
    this.scene.add(this.wreckedSUV.root);

    this.colliders.push({
      type: 'aabb',
      minX: carX - 1.5,
      maxX: carX + 1.5,
      minZ: carZ - 2.6,
      maxZ: carZ + 2.6
    });

    // 1. Dynamic Avalanche Boulder Blockade (pinched tightly between river on left and mountain cliff on right)
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95, metalness: 0.1 });
    this.roadBlockadeGroup = new THREE.Group();
    const boulderDefs = [
      { x: -192, z: 515.0, r: 2.1, y: 1.2 },
      { x: -188, z: 514.5, r: 2.5, y: 1.5 },
      { x: -184, z: 514.0, r: 2.9, y: 1.8 },
      { x: -180, z: 515.2, r: 2.3, y: 1.4 },
      { x: -176, z: 514.8, r: 2.7, y: 1.7 },
      { x: -186, z: 514.2, r: 1.9, y: 3.1 },
      { x: -182, z: 514.6, r: 1.7, y: 2.9 }
    ];
    boulderDefs.forEach((b) => {
      const by = getTerrainHeight(b.x, b.z);
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(b.r, 1), rockMat);
      mesh.position.set(b.x, by + b.y * 0.7, b.z);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.roadBlockadeGroup.add(mesh);
    });
    this.scene.add(this.roadBlockadeGroup);

    // Physical impassable collider for the rockslide blockade
    // Use road centerline to compute gap position
    const blockadeRoad = getRoadSignedDistance(-184, 514);
    const gapCenterX = blockadeRoad.projX;
    const gapCenterZ = blockadeRoad.projZ;
    const gapHalf = 2.0; // 4m gap total

    // Left collider (mountain side of gap)
    this.colliders.push({
      id: 'col_suv_blockade_L',
      type: 'aabb',
      minX: -198,
      maxX: gapCenterX - gapHalf,
      minZ: 512,
      maxZ: 517
    });
    // Right collider (ravine side of gap)
    this.colliders.push({
      id: 'col_suv_blockade_R',
      type: 'aabb',
      minX: gapCenterX + gapHalf,
      maxX: -170,
      minZ: 512,
      maxZ: 517
    });
    // Full blockade collider (removed after looting)
    this.colliders.push({
      id: 'col_suv_blockade',
      type: 'aabb',
      minX: gapCenterX - gapHalf,
      maxX: gapCenterX + gapHalf,
      minZ: 512,
      maxZ: 517
    });

    // 2. Chapter 1: Loot Damaged SUV Emergency Supplies
    const crateY = getTerrainHeight(carX + 0.6, carZ + 2.3);
    this.createInteractable({
      id: 'suv_storage',
      name: 'Loot Damaged SUV (Oil, Matches, Blanket, Food, Torch)',
      pos: new THREE.Vector3(carX + 0.6, crateY + 0.5, carZ + 2.3),
      icon: '🧰',
      reachRadius: 4.8,
      onInteract: () => {
        this.lootSUV();
      }
    });

    // 3. Chapter 2: Canyon Pass First Night Campsite (x = -130, z = 450)
    const campX = -130.0;
    const campZ = 450.0;
    const campGroundY = getTerrainHeight(campX, campZ);

    const stoneRingMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });

    const campGroup = new THREE.Group();
    campGroup.position.set(campX, campGroundY, campZ);

    const stoneRing = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.25, 6, 12), stoneRingMat);
    stoneRing.rotation.x = Math.PI / 2;
    stoneRing.position.y = 0.25;
    campGroup.add(stoneRing);

    for (let l = 0; l < 4; l++) {
      const woodLog = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 1.8, 5), woodMat);
      woodLog.position.set(Math.cos(l * 1.5) * 0.4, 0.4, Math.sin(l * 1.5) * 0.4);
      woodLog.rotation.set(0.3, l * 1.5, 0.2);
      campGroup.add(woodLog);
    }
    this.scene.add(campGroup);

    this.createInteractable({
      id: 'campsite_first_night',
      name: 'Build Campfire before Dark (Survive Night)',
      pos: new THREE.Vector3(campX, campGroundY + 0.8, campZ),
      icon: '🔥',
      reachRadius: 4.8,
      onInteract: () => {
        this.igniteFirstNightCampfire();
      }
    });

    // Far-Away Visible Landmark: South Valley Signal Flare Mast at (-60, 380)
    const flareX = -60.0;
    const flareZ = 380.0;
    const flareGroundY = getTerrainHeight(flareX, flareZ);
    const mastGroup = new THREE.Group();
    mastGroup.position.set(flareX, flareGroundY, flareZ);

    const mastGeom = new THREE.CylinderGeometry(0.18, 0.3, 16.0, 6);
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const mast = new THREE.Mesh(mastGeom, mastMat);
    mast.position.y = 8.0;
    mast.castShadow = true;
    mastGroup.add(mast);

    const flareOrb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff6600 }));
    flareOrb.position.y = 16.2;
    mastGroup.add(flareOrb);

    const flareLight = new THREE.PointLight(0xff6600, 4.0, 95);
    flareLight.position.y = 16.5;
    mastGroup.add(flareLight);

    this.scene.add(mastGroup);
  }

  // ---------------------------------------------------------------------------
  // ZONE 2/3: ABANDONED VILLAGE (Readable Evacuation Notes & 3 Bridge Parts)
  // ---------------------------------------------------------------------------
  buildAbandonedVillage() {
    const vGroup = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3e2817, roughness: 0.92 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.95 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.3 });

    // 1. Elder Soren's Town Hall Cabin at (152, 250) with Lore Notice Board
    const h1X = 152.0;
    const h1Z = 250.0;
    const h1Y = getTerrainHeight(h1X, h1Z);

    const cabin1 = new THREE.Group();
    cabin1.position.set(h1X, h1Y, h1Z);

    const walls1 = new THREE.Mesh(new THREE.BoxGeometry(7.2, 4.0, 6.2), woodMat);
    walls1.position.y = 2.0;
    walls1.castShadow = true;
    walls1.receiveShadow = true;
    cabin1.add(walls1);

    const roof1 = new THREE.Mesh(new THREE.ConeGeometry(5.6, 2.6, 4), roofMat);
    roof1.position.y = 5.2;
    roof1.rotation.y = Math.PI / 4;
    roof1.castShadow = true;
    cabin1.add(roof1);

    // Front Porch & Notice Board
    const porch = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.25, 2.2), woodMat);
    porch.position.set(0, 0.15, 4.0);
    cabin1.add(porch);

    const noticePost = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.8, 0.15), woodMat);
    noticePost.position.set(1.4, 1.0, 4.6);
    cabin1.add(noticePost);

    const noticeBoard = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 0.08), new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8 }));
    noticeBoard.position.set(1.4, 1.5, 4.6);
    cabin1.add(noticeBoard);

    vGroup.add(cabin1);

    // Readable Lore Note Interactable ("We moved")
    this.createInteractable({
      id: 'village_note',
      name: 'Evacuation Notice ("We moved")',
      pos: new THREE.Vector3(h1X + 1.4, h1Y + 1.5, h1Z + 4.6),
      icon: '📜',
      reachRadius: 4.5,
      onInteract: () => {
        this.openNoteModal({
          badge: '📜 EVACUATION NOTICE',
          title: 'NOTICE: WE MOVED',
          author: 'Elder Soren & Village Council',
          body: 'All villagers, move out now. Winter storm is coming. Abandon all heavy wagons and livestock. The canyon pass is blocked, but the gorge drawbridge will take you north toward the Radio Tower!'
        });
      }
    });

    // 2. Village Blacksmith Workshop at (172, 235) - Contains Part 1: Winch Gear
    const h2X = 172.0;
    const h2Z = 235.0;
    const h2Y = getTerrainHeight(h2X, h2Z);

    const cabin2 = new THREE.Group();
    cabin2.position.set(h2X, h2Y, h2Z);

    const walls2 = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.8, 5.8), stoneMat);
    walls2.position.y = 1.9;
    walls2.castShadow = true;
    cabin2.add(walls2);

    const roof2 = new THREE.Mesh(new THREE.ConeGeometry(5.2, 2.4, 4), roofMat);
    roof2.position.y = 4.8;
    roof2.rotation.y = Math.PI / 4;
    cabin2.add(roof2);

    // Blacksmith Anvil & Workbench
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.9), woodMat);
    bench.position.set(0, 0.45, 3.6);
    cabin2.add(bench);

    const gearMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.15, 8), ironMat);
    gearMesh.position.set(0, 1.0, 3.6);
    gearMesh.rotation.x = Math.PI / 2;
    cabin2.add(gearMesh);

    vGroup.add(cabin2);

    // Bridge Part 1: Winch Gear Interactable
    this.createInteractable({
      id: 'village_gear',
      name: 'Heavy Winch Gear (Bridge Part 1/3)',
      pos: new THREE.Vector3(h2X, h2Y + 1.1, h2Z + 3.6),
      icon: '⚙️',
      reachRadius: 4.5,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'winch_gear', name: 'Heavy Winch Gear', icon: '⚙️', count: 1 });
        this.sfx.playPickup();
        this.showToast(`Found Winch Gear! (${this.villagePartsCollected}/3 Bridge Parts)`);
        this.checkVillageBridgeProgress();
      }
    });

    // 3. Village Storehouse at (145, 235) - Contains Part 2: Steel Cable
    const h3X = 145.0;
    const h3Z = 235.0;
    const h3Y = getTerrainHeight(h3X, h3Z);

    const cabin3 = new THREE.Group();
    cabin3.position.set(h3X, h3Y, h3Z);

    const walls3 = new THREE.Mesh(new THREE.BoxGeometry(6.8, 3.6, 5.4), woodMat);
    walls3.position.y = 1.8;
    walls3.castShadow = true;
    cabin3.add(walls3);

    const roof3 = new THREE.Mesh(new THREE.ConeGeometry(5.4, 2.2, 4), roofMat);
    roof3.position.y = 4.6;
    roof3.rotation.y = Math.PI / 4;
    cabin3.add(roof3);

    // Storage Crate with Steel Cable
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), woodMat);
    crate.position.set(0, 0.5, 3.5);
    cabin3.add(crate);

    const cableCoil = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.08, 6, 12), ironMat);
    cableCoil.position.set(0, 1.1, 3.5);
    cableCoil.rotation.x = Math.PI / 2;
    cabin3.add(cableCoil);

    vGroup.add(cabin3);

    // Bridge Part 2: Steel Cable Interactable
    this.createInteractable({
      id: 'village_cable',
      name: 'Steel Cable Coil (Bridge Part 2/3)',
      pos: new THREE.Vector3(h3X, h3Y + 1.1, h3Z + 3.5),
      icon: '⛓️',
      reachRadius: 4.5,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'steel_cable', name: 'High-Tensile Steel Cable', icon: '⛓️', count: 1 });
        this.sfx.playPickup();
        this.showToast(`Found Steel Cable! (${this.villagePartsCollected}/3 Bridge Parts)`);
        this.checkVillageBridgeProgress();
      }
    });

    // 4. Watchtower Outpost Tool Rack at (176, 258) - Contains Part 3: Crank Handle
    const h4X = 176.0;
    const h4Z = 258.0;
    const h4Y = getTerrainHeight(h4X, h4Z);

    const toolBench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.8), woodMat);
    toolBench.position.set(h4X, h4Y + 0.4, h4Z);
    vGroup.add(toolBench);

    const crankMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6), ironMat);
    crankMesh.position.set(h4X, h4Y + 0.88, h4Z);
    crankMesh.rotation.z = Math.PI / 3;
    vGroup.add(crankMesh);

    this.scene.add(vGroup);

    // Bridge Part 3: Winch Crank Handle Interactable
    this.createInteractable({
      id: 'village_crank',
      name: 'Iron Crank Handle (Bridge Part 3/3)',
      pos: new THREE.Vector3(h4X, h4Y + 0.9, h4Z),
      icon: '🔧',
      reachRadius: 4.5,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'crank_handle', name: 'Iron Winch Crank Handle', icon: '🔧', count: 1 });
        this.sfx.playPickup();
        this.showToast(`Found Winch Crank! (${this.villagePartsCollected}/3 Bridge Parts)`);
        this.checkVillageBridgeProgress();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 5: KHAI CHASM SWAYING ROPE SUSPENSION BRIDGE (z = -410 to -460)
  // ---------------------------------------------------------------------------
  buildKhaiRopeBridge() {
    this.ropeBridgeGroup = new THREE.Group();
    const timberMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.92 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x785635, roughness: 0.95 });
    const plankMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.88 });

    // Anchor Pylons on South Cliff (x = 75, z = -410) & North Cliff (x = 55, z = -460)
    const pSouth = new THREE.Vector3(75, getTerrainHeight(75, -410), -410);
    const pNorth = new THREE.Vector3(55, getTerrainHeight(55, -460), -460);

    [-1.6, 1.6].forEach(offset => {
      // South pylons
      const pS = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 5.2, 6), timberMat);
      pS.position.set(pSouth.x + offset, pSouth.y + 2.6, pSouth.z);
      pS.castShadow = true;
      this.ropeBridgeGroup.add(pS);

      // North pylons
      const pN = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 5.2, 6), timberMat);
      pN.position.set(pNorth.x + offset, pNorth.y + 2.6, pNorth.z);
      pN.castShadow = true;
      this.ropeBridgeGroup.add(pN);
    });

    // 28 Wooden Slat Planks spanning across the deep Khai chasm
    const plankCount = 28;
    for (let i = 0; i <= plankCount; i++) {
      const u = i / plankCount;
      const px = pSouth.x * (1 - u) + pNorth.x * u;
      const pz = pSouth.z * (1 - u) + pNorth.z * u;
      // Catenary sag in the middle of the bridge
      const sag = Math.sin(u * Math.PI) * 2.8;
      const py = pSouth.y * (1 - u) + pNorth.y * u - sag;

      const plank = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 1.2), plankMat);
      plank.position.set(px, py + 0.1, pz);
      plank.rotation.y = Math.atan2(pNorth.x - pSouth.x, pNorth.z - pSouth.z);
      plank.castShadow = true;
      plank.receiveShadow = true;
      this.ropeBridgeGroup.add(plank);

      // Left & Right Handrail Ropes
      [-1.35, 1.35].forEach(side => {
        const ropeTie = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 4), ropeMat);
        ropeTie.position.set(px + side, py + 0.65, pz);
        this.ropeBridgeGroup.add(ropeTie);
      });
    }

    this.scene.add(this.ropeBridgeGroup);
  }

  // ---------------------------------------------------------------------------
  // ZONE 2: HIGH TIMBER WATCHTOWER LANDMARK (x = 170, z = 260)
  // ---------------------------------------------------------------------------
  buildWatchtowerLandmark() {
    const towerX = 170.0;
    const towerZ = 260.0;
    const groundY = getTerrainHeight(towerX, towerZ);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(towerX, groundY, towerZ);

    const timberMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.95 });
    const plankMat = new THREE.MeshStandardMaterial({ color: 0x5a3e23, roughness: 0.9 });

    const towerH = 20.0;
    // 4 Heavy Log Leg Columns
    [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]].forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, towerH, 6), timberMat);
      leg.position.set(lx, towerH / 2, lz);
      leg.castShadow = true;
      towerGroup.add(leg);
    });

    // Cross-bracing rings
    for (let r = 0; r < 3; r++) {
      const ry = 4.5 + r * 5.5;
      const brace = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.25, 4.8), timberMat);
      brace.position.y = ry;
      towerGroup.add(brace);
    }

    // Observation Platform Deck
    const platform = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.4, 6.2), plankMat);
    platform.position.y = towerH;
    platform.castShadow = true;
    towerGroup.add(platform);

    // Platform Roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.2, 2.6, 4), timberMat);
    roof.position.y = towerH + 3.8;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    towerGroup.add(roof);

    // High Amber Beacon Lantern (Visible across forest canopy)
    const lanternOrb = new THREE.Mesh(new THREE.SphereGeometry(0.65, 12, 12), new THREE.MeshBasicMaterial({ color: 0xf59e0b }));
    lanternOrb.position.set(0, towerH + 1.8, 0);
    towerGroup.add(lanternOrb);

    const lanternLight = new THREE.PointLight(0xf59e0b, 4.0, 125);
    lanternLight.position.set(0, towerH + 2.0, 0);
    towerGroup.add(lanternLight);

    this.scene.add(towerGroup);

    this.colliders.push({
      type: 'aabb',
      minX: towerX - 2.8,
      maxX: towerX + 2.8,
      minZ: towerZ - 2.8,
      maxZ: towerZ + 2.8
    });

    // Milestone Trigger: Discovering the Watchtower
    this.createInteractable({
      id: 'watchtower_scout',
      name: 'Timber Watchtower Lookout (Scout Route Ahead)',
      pos: new THREE.Vector3(towerX, groundY + 1.2, towerZ + 2.8),
      icon: '🔭',
      onInteract: () => {
        this.showToast('Scouted the frozen lake and wooden bridge from the watchtower!');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 4: HUNTER CAMP & CARPENTRY WORKSHOP (x = -70, z = -235)
  // ---------------------------------------------------------------------------
  buildHunterCampWorkshop() {
    const campX = -70.0;
    const campZ = -235.0;
    const groundY = getTerrainHeight(campX, campZ);

    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3219, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x222b35, roughness: 0.8 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.95 });

    // 1. Log Cabin
    const cabinGroup = new THREE.Group();
    cabinGroup.position.set(campX - 12.0, groundY, campZ);

    const walls = new THREE.Mesh(new THREE.BoxGeometry(8, 4.5, 7), woodMat);
    walls.position.y = 2.25;
    walls.castShadow = true;
    walls.receiveShadow = true;
    cabinGroup.add(walls);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.5, 2.8, 4), roofMat);
    roof.position.y = 5.6;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    cabinGroup.add(roof);

    // Stone Chimney with warm smoke glow
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.2, 7.2, 1.2), stoneMat);
    chimney.position.set(3.2, 3.6, -1.8);
    chimney.castShadow = true;
    cabinGroup.add(chimney);

    // Cabin interior window light (dim until generator is fixed)
    this.cabinInteriorLight = new THREE.PointLight(0xff9933, 0.5, 20);
    this.cabinInteriorLight.position.set(3.8, 2.5, 0);
    cabinGroup.add(this.cabinInteriorLight);

    // Cabin porch lantern (illuminates when generator is restored)
    this.cabinPorchLight = new THREE.PointLight(0xf59e0b, 0.0, 24);
    this.cabinPorchLight.position.set(campX - 7.5, groundY + 3.0, campZ + 2.0);
    this.scene.add(this.cabinPorchLight);

    const porchLanternMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b })
    );
    porchLanternMesh.position.copy(this.cabinPorchLight.position);
    this.scene.add(porchLanternMesh);

    this.scene.add(cabinGroup);

    this.colliders.push({
      type: 'aabb',
      minX: campX - 16.5,
      maxX: campX - 7.5,
      minZ: campZ - 4.0,
      maxZ: campZ + 4.0
    });

    this.createInteractable({
      id: 'cabin_rest',
      name: 'Hunter Mountain Cabin (Rest & Warmth)',
      pos: new THREE.Vector3(campX - 7.8, groundY + 1.2, campZ),
      icon: '🛏️',
      onInteract: () => {
        this.sleepAndRestore();
      }
    });

    // Surveyor Map Table on Cabin Porch (The Map Item!)
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
    const tableMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.2), tableMat);
    tableMesh.position.set(campX - 8.2, groundY + 0.45, campZ + 2.5);
    tableMesh.castShadow = true;
    this.scene.add(tableMesh);

    const parchmentMat = new THREE.MeshStandardMaterial({ color: 0xe2d9be, roughness: 0.7 });
    this.cabinMapMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8), parchmentMat);
    this.cabinMapMesh.position.set(campX - 8.2, groundY + 1.0, campZ + 2.5);
    this.cabinMapMesh.rotation.z = Math.PI / 2;
    this.scene.add(this.cabinMapMesh);

    this.createInteractable({
      id: 'cabin_map',
      name: 'Surveyor Mountain Map (Acquire Topographic Map & Unlock Radar)',
      pos: new THREE.Vector3(campX - 8.2, groundY + 1.2, campZ + 2.5),
      icon: '🗺️',
      onInteract: () => {
        this.pickupMap();
      }
    });

    // Mission 5: Camp Auxiliary Diesel Generator (Working, Animated Machine)
    const genGroup = new THREE.Group();
    genGroup.position.set(campX + 12.0, groundY, campZ - 2.0);
    const genBody = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.6, 1.4), new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.7, roughness: 0.3 }));
    genBody.position.y = 0.8;
    genBody.castShadow = true;
    genGroup.add(genBody);
    const genExhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8 }));
    genExhaust.position.set(0.6, 1.8, 0);
    genGroup.add(genExhaust);

    // Generator status light bulb
    this.genStatusLight = new THREE.PointLight(0xef4444, 1.5, 6);
    this.genStatusLight.position.set(0.6, 1.2, 0.75);
    genGroup.add(this.genStatusLight);

    this.scene.add(genGroup);

    this.generatorMesh = genGroup;
    this.generatorBaseY = groundY;
    this.generatorRunning = false;
    this.buildGeneratorSmokeSystem(campX + 12.6, groundY + 2.4, campZ - 2.0);

    this.createInteractable({
      id: 'mission_generator',
      name: 'Camp Auxiliary Diesel Generator (Power Mountain Grid)',
      pos: new THREE.Vector3(campX + 12.0, groundY + 1.1, campZ - 2.0),
      icon: '⚡',
      onInteract: () => {
        const hasDiesel = this.inventory.some(i => i.id === 'diesel');
        const fuelMission = this.missions.find(m => m.id === 'meadow_fuel');
        if (hasDiesel || (fuelMission && fuelMission.completed)) {
          this.completeMission('generator');
        } else {
          this.sfx.playAttack();
          this.showToast('Generator empty! Retrieve auxiliary diesel canister from the meadow surveyor cache first.');
        }
      }
    });

    // 2. Open-Air Carpentry Workshop Shed
    const workshopGroup = new THREE.Group();
    workshopGroup.position.set(campX + 8.0, groundY, campZ + 4.0);

    // 4 timber posts
    [[-3.2, -2.0], [3.2, -2.0], [-3.2, 2.0], [3.2, 2.0]].forEach(([px, pz]) => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.6, 6), woodMat);
      post.position.set(px, 1.8, pz);
      post.castShadow = true;
      workshopGroup.add(post);
    });

    const shedRoof = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.3, 4.8), roofMat);
    shedRoof.position.y = 3.7;
    shedRoof.rotation.x = 0.15;
    shedRoof.castShadow = true;
    workshopGroup.add(shedRoof);

    // Timber Workbench
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.85 });
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.1), benchMat);
    bench.position.set(0, 0.45, 0);
    bench.castShadow = true;
    workshopGroup.add(bench);

    // Anvil
    const anvilMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.35 });
    const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.5), anvilMat);
    anvil.position.set(1.8, 0.35, 0);
    anvil.castShadow = true;
    workshopGroup.add(anvil);

    this.scene.add(workshopGroup);

    this.colliders.push({
      type: 'aabb',
      minX: campX + 5.5,
      maxX: campX + 10.5,
      minZ: campZ + 2.0,
      maxZ: campZ + 6.0
    });

    // Interactive Workshop Workbench
    this.createInteractable({
      id: 'camp_workbench',
      name: 'Hunter Workshop Workbench (Refuel & Repair)',
      pos: new THREE.Vector3(campX + 8.0, groundY + 1.1, campZ + 4.0),
      icon: '🛠️',
      onInteract: () => {
        this.torchFuel = 100;
        this.energy = 100;
        this.addItem({ id: 'wood', name: 'Dry Pine Wood', icon: '🪵', count: 3 });
        this.addItem({ id: 'kerosene', name: 'Torch Fuel', icon: '🛢️', count: 1 });
        this.sfx.playPickup();
        this.showToast('Repaired gear at the workbench! Refueled torch to 100% (+Timber)');
      }
    });

    // 3. Campfire Firepit (Safe Zone with Real Flame Particles & Flicker Light)
    const fireX = campX;
    const fireZ = campZ - 4.0;
    const fireLight = new THREE.PointLight(0xff7722, 4.0, 32);
    fireLight.position.set(fireX, groundY + 1.2, fireZ);
    this.scene.add(fireLight);

    const flameOrb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    flameOrb.position.set(fireX, groundY + 0.6, fireZ);
    this.scene.add(flameOrb);

    const campFireParticles = new FlameParticleSystem(this.scene, 32, 0.45, 1.5, 0.26);
    this.campfires.push({
      pos: new THREE.Vector3(fireX, groundY, fireZ),
      light: fireLight,
      flameOrb,
      flameParticles: campFireParticles
    });

    // 4. Far-Away Visible Landmark: 22m Rotating Rustic Windmill at (-80, -220)
    const millX = -80.0;
    const millZ = -220.0;
    const millGroundY = getTerrainHeight(millX, millZ);
    const millGroup = new THREE.Group();
    millGroup.position.set(millX, millGroundY, millZ);

    const millTower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.8, 18.0, 8), woodMat);
    millTower.position.y = 9.0;
    millTower.castShadow = true;
    millGroup.add(millTower);

    const millCap = new THREE.Mesh(new THREE.ConeGeometry(2.4, 3.2, 8), roofMat);
    millCap.position.y = 19.6;
    millCap.castShadow = true;
    millGroup.add(millCap);

    // Rotating 4-blade Sail
    this.windmillBlades = new THREE.Group();
    this.windmillBlades.position.set(0, 18.0, 1.8);
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7.5, 0.1), woodMat);
      blade.position.y = 3.6;
      const bladeHolder = new THREE.Group();
      bladeHolder.rotation.z = (b * Math.PI) / 2;
      bladeHolder.add(blade);
      this.windmillBlades.add(bladeHolder);
    }
    millGroup.add(this.windmillBlades);

    this.scene.add(millGroup);
  }

  // ---------------------------------------------------------------------------
  // WORKING MACHINES: WATER WHEEL AT THE RIVER (x = -16, z = 18)
  // ---------------------------------------------------------------------------
  buildRiverWaterWheel() {
    const wheelX = -16.0;
    const wheelZ = 18.0;
    const riverY = 5.15;

    const machineGroup = new THREE.Group();
    machineGroup.position.set(wheelX, riverY, wheelZ);

    const timberMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.95 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3e23, roughness: 0.9 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.35 });

    // Stone Masonry Foundation Pier on Riverbank
    const pierGeom = new THREE.BoxGeometry(2.4, 3.2, 4.8);
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9 });
    const pier = new THREE.Mesh(pierGeom, pierMat);
    pier.position.set(0, 0.4, 0);
    pier.castShadow = true;
    pier.receiveShadow = true;
    machineGroup.add(pier);

    // Bearing blocks & Axle housing
    const axleHousing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 3.8), ironMat);
    axleHousing.position.set(0, 1.8, 0);
    machineGroup.add(axleHousing);

    // Rotating Water Wheel Group
    this.waterWheel = new THREE.Group();
    this.waterWheel.position.set(0, 1.8, 0);

    // Central Timber Axle Shaft
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 3.2, 8), ironMat);
    axle.rotation.x = Math.PI / 2;
    this.waterWheel.add(axle);

    // Dual 5.2m Timber Wheel Rings
    [-1.2, 1.2].forEach(offsetZ => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.12, 6, 16), timberMat);
      ring.position.z = offsetZ;
      this.waterWheel.add(ring);

      // Spokes (6 per ring)
      for (let s = 0; s < 6; s++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5.2, 0.12), timberMat);
        spoke.rotation.z = (s * Math.PI) / 3;
        spoke.position.z = offsetZ;
        this.waterWheel.add(spoke);
      }
    });

    // 12 Timber Paddle Blades dipping into the water
    const numPaddles = 12;
    for (let p = 0; p < numPaddles; p++) {
      const angle = (p / numPaddles) * Math.PI * 2;
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 2.3), woodMat);
      paddle.position.set(Math.cos(angle) * 2.5, Math.sin(angle) * 2.5, 0);
      paddle.rotation.z = angle + Math.PI / 2;
      paddle.castShadow = true;
      this.waterWheel.add(paddle);
    }

    machineGroup.add(this.waterWheel);

    // Bevel Drive Gearbox & Shaft running towards Drawbridge Winch
    const gearBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), ironMat);
    gearBox.position.set(1.5, 1.8, 0);
    machineGroup.add(gearBox);

    this.waterWheelGears = new THREE.Group();
    this.waterWheelGears.position.set(1.5, 2.5, 0);
    const gearDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.15, 12), ironMat);
    this.waterWheelGears.add(gearDisc);
    machineGroup.add(this.waterWheelGears);

    // Drive transmission shaft running towards the bridge
    const driveShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 8.5, 6), ironMat);
    driveShaft.position.set(1.5, 2.5, 4.2);
    driveShaft.rotation.x = Math.PI / 2;
    machineGroup.add(driveShaft);

    this.scene.add(machineGroup);

    // Water Wheel Power Linkage Interactable
    this.createInteractable({
      id: 'water_wheel_gear',
      name: 'River Water Wheel & Hydro Gearbox (Inspect Transmission)',
      pos: new THREE.Vector3(wheelX + 1.6, riverY + 2.0, wheelZ),
      icon: '⚙️',
      onInteract: () => {
        this.sfx.playWaterSplash();
        this.showToast('Hydro-powered water wheel turning in river current! Powers drawbridge winch transmission.');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WORKING MACHINES: WIND TURBINE ON HIGH RIDGE (x = 42, z = -320)
  // ---------------------------------------------------------------------------
  buildRidgeWindTurbine() {
    const turbX = 42.0;
    const turbZ = -320.0;
    const turbY = getTerrainHeight(turbX, turbZ);

    const turbineGroup = new THREE.Group();
    turbineGroup.position.set(turbX, turbY, turbZ);

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.35, metalness: 0.6 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.8 });

    // Concrete Pedestal
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.4, 1.4, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.95 }));
    base.position.y = 0.7;
    base.receiveShadow = true;
    turbineGroup.add(base);

    // 26m Tapered Tubular Steel Mast
    const mastHeight = 26.0;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.6, mastHeight, 16), whiteMat);
    mast.position.y = mastHeight / 2 + 0.7;
    mast.castShadow = true;
    mast.receiveShadow = true;
    turbineGroup.add(mast);

    // Maintenance Platform Ring
    const platform = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.1, 4, 12), darkSteel);
    platform.position.y = mastHeight + 0.5;
    platform.rotation.x = Math.PI / 2;
    turbineGroup.add(platform);

    // Nacelle Enclosure (Generator Pod)
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 5.2), whiteMat);
    nacelle.position.set(0, mastHeight + 1.8, 0.8);
    nacelle.castShadow = true;
    turbineGroup.add(nacelle);

    // Flashing Red Aviation Warning Beacon on Nacelle Roof
    this.turbineBeaconLight = new THREE.PointLight(0xff2200, 3.5, 95);
    this.turbineBeaconLight.position.set(0, mastHeight + 3.2, 0.8);
    turbineGroup.add(this.turbineBeaconLight);

    const beaconOrb = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2200 }));
    beaconOrb.position.set(0, mastHeight + 3.2, 0.8);
    turbineGroup.add(beaconOrb);

    // Rotor Hub & 3 Tapered Aerodynamic Blades
    this.turbineRotor = new THREE.Group();
    this.turbineRotor.position.set(0, mastHeight + 1.8, -1.9);

    const hub = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 12), darkSteel);
    hub.rotation.x = -Math.PI / 2;
    this.turbineRotor.add(hub);

    const bladeGeom = new THREE.BoxGeometry(0.75, 11.0, 0.15);
    bladeGeom.translate(0, 5.5, 0);

    for (let b = 0; b < 3; b++) {
      const bladeHolder = new THREE.Group();
      bladeHolder.rotation.z = (b * Math.PI * 2) / 3;
      const blade = new THREE.Mesh(bladeGeom, whiteMat);
      blade.castShadow = true;
      bladeHolder.add(blade);
      this.turbineRotor.add(bladeHolder);
    }

    turbineGroup.add(this.turbineRotor);
    this.scene.add(turbineGroup);

    this.colliders.push({
      type: 'sphere',
      center: new THREE.Vector2(turbX, turbZ),
      radius: 3.2
    });

    // Ridge Wind Turbine Console
    this.createInteractable({
      id: 'ridge_wind_turbine',
      name: 'Ridge Alpine Wind Turbine (Sync Mountain Grid Relay)',
      pos: new THREE.Vector3(turbX + 2.2, turbY + 1.2, turbZ),
      icon: '💨',
      onInteract: () => {
        this.sfx.playPickup();
        this.showToast('Ridge Turbine generating 850kW from alpine gusts! Synchronized to Summit Tower grid.');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // GENERATOR STEAM / SMOKE PARTICLE SYSTEM
  // ---------------------------------------------------------------------------
  buildGeneratorSmokeSystem(x, y, z) {
    this.genSmokePos = new THREE.Vector3(x, y, z);
    const smokeCount = 28;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(smokeCount * 3);
    this.genSmokeVelocities = [];

    for (let i = 0; i < smokeCount; i++) {
      positions[i * 3] = x + (Math.random() - 0.5) * 0.2;
      positions[i * 3 + 1] = y + (i / smokeCount) * 2.8;
      positions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.2;

      this.genSmokeVelocities.push({
        vx: (Math.random() - 0.5) * 0.18,
        vy: 0.8 + Math.random() * 0.7,
        vz: (Math.random() - 0.5) * 0.18,
        life: Math.random()
      });
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd1d5db,
      size: 0.65,
      transparent: true,
      opacity: 0.0, // Invisible until generator starts!
      depthWrite: false
    });

    this.generatorSmokePoints = new THREE.Points(geom, mat);
    this.scene.add(this.generatorSmokePoints);
  }

  updateGeneratorSmoke(delta) {
    if (!this.generatorSmokePoints || !this.generatorRunning) return;
    this.generatorSmokePoints.material.opacity = 0.55;

    const pos = this.generatorSmokePoints.geometry.attributes.position;
    const origin = this.genSmokePos;

    for (let i = 0; i < this.genSmokeVelocities.length; i++) {
      const v = this.genSmokeVelocities[i];
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      y += v.vy * delta;
      x += (v.vx + 0.1) * delta;
      z += v.vz * delta;

      if (y > origin.y + 3.2) {
        x = origin.x + (Math.random() - 0.5) * 0.15;
        y = origin.y;
        z = origin.z + (Math.random() - 0.5) * 0.15;
      }

      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // ANIMATE ALL MACHINES (Water Wheel, Wind Turbine, Generator, Rockslide Crane)
  // ---------------------------------------------------------------------------
  updateMachines(delta) {
    const time = performance.now() * 0.001;

    // 1. Water Wheel Turning in River Current
    if (this.waterWheel) {
      this.waterWheel.rotation.x += delta * 1.35;
    }
    if (this.waterWheelGears) {
      this.waterWheelGears.rotation.y += delta * 2.7;
    }

    // 2. Ridge Wind Turbine Blades & Aviation Beacon
    if (this.turbineRotor) {
      this.turbineRotor.rotation.z += delta * 1.8;
    }
    if (this.turbineBeaconLight) {
      const blink = Math.sin(time * 3.5);
      this.turbineBeaconLight.intensity = (blink > 0.4) ? 4.2 : 0.2;
    }

    // 3. Camp Generator Vibration & Smoke
    if (this.generatorRunning && this.generatorMesh) {
      this.generatorMesh.position.y = this.generatorBaseY + Math.sin(time * 48) * 0.022;
      this.updateGeneratorSmoke(delta);
      if (this.genStatusLight) {
        this.genStatusLight.color.setHex(0x22c55e); // Green online light
        this.genStatusLight.intensity = 2.5;
      }
    }

    // 4. Canyon Rockslide Crane / Winch
    if (this.craneWinchSpool) {
      if (this.craneActive) {
        this.craneWinchSpool.rotation.x += delta * 3.2;
        if (this.craneBoom) {
          this.craneBoom.rotation.y = THREE.MathUtils.lerp(this.craneBoom.rotation.y, 0.75, delta * 1.6);
        }
      } else {
        this.craneWinchSpool.rotation.x += Math.sin(time * 0.8) * 0.008;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2-3 ALTERNATE ROUTES BETWEEN ZONES (Meadow Bypass, Lake Walk, Ridge Trail)
  // ---------------------------------------------------------------------------
  buildAlternateRoutes() {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 });
    const goldReflector = new THREE.MeshBasicMaterial({ color: 0xf59e0b });

    // Alternate Route 1: Zone 2 "Whispering Meadow Bypass Trail" (Cairns marking meadow path)
    const meadowTrailPoints = [
      { x: 40, z: 330 },
      { x: 65, z: 290 },
      { x: 90, z: 240 },
      { x: 120, z: 190 },
      { x: 160, z: 150 }
    ];

    meadowTrailPoints.forEach((pt) => {
      const gy = getTerrainHeight(pt.x, pt.z);
      const cairn = new THREE.Group();
      cairn.position.set(pt.x, gy, pt.z);

      const baseRock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5, 1), stoneMat);
      baseRock.position.y = 0.4;
      cairn.add(baseRock);

      const topRock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.35, 1), stoneMat);
      topRock.position.y = 1.0;
      cairn.add(topRock);

      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), goldReflector);
      marker.position.y = 1.5;
      cairn.add(marker);

      this.scene.add(cairn);
    });

    // Alternate Route 2: Zone 3 "Frozen Lake Ice Walk Access Sign"
    const rampX = 10.0;
    const rampZ = 36.0;
    const rampY = getTerrainHeight(rampX, rampZ);

    this.createInteractable({
      id: 'lake_trail_sign',
      name: 'Alternate Route: Frozen Lake Ice Path',
      pos: new THREE.Vector3(rampX, rampY + 1.0, rampZ),
      icon: '❄️',
      onInteract: () => {
        this.showToast('Alternate Route: Walk down onto the glacial lake ice to cross under the bridge!');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // INSTANCED NATURE & VEGETATION (5 GLB Types with Noise Density & Random Lean)
  // ---------------------------------------------------------------------------
  populateNature() {
    const dummy = new THREE.Object3D();
    const gltfLoader = new GLTFLoader();

    // Helper to safely bind GLB meshes to InstancedMeshes with procedural fallback
    const bindGLBToInstanced = (url, instancedMeshes) => {
      gltfLoader.load(
        url,
        (gltf) => {
          const parts = [];
          gltf.scene.traverse((c) => {
            if (c.isMesh && c.geometry) parts.push(c);
          });
          if (parts.length === 1 && instancedMeshes.length >= 1) {
            instancedMeshes[0].geometry = parts[0].geometry;
            instancedMeshes[0].material = parts[0].material;
            instancedMeshes[0].castShadow = true;
            instancedMeshes[0].receiveShadow = true;
          } else if (parts.length >= 2 && instancedMeshes.length >= 2) {
            for (let i = 0; i < Math.min(parts.length, instancedMeshes.length); i++) {
              instancedMeshes[i].geometry = parts[i].geometry;
              instancedMeshes[i].material = parts[i].material;
              instancedMeshes[i].castShadow = true;
              instancedMeshes[i].receiveShadow = true;
            }
          }
        },
        undefined,
        (err) => console.warn('GLB procedural fallback active for ' + url, err)
      );
    };

    // 1. Alpine Pines (850 instances) - tree_pine.glb
    const pineCount = 850;
    const pineTrunkGeom = new THREE.CylinderGeometry(0.08, 0.12, 1.0, 6);
    pineTrunkGeom.translate(0, 0.5, 0);
    const pineTrunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const pineTrunkInst = new THREE.InstancedMesh(pineTrunkGeom, pineTrunkMat, pineCount);
    pineTrunkInst.castShadow = true;
    pineTrunkInst.receiveShadow = true;

    const pineFoliageGeom = new THREE.ConeGeometry(0.48, 1.15, 7);
    pineFoliageGeom.translate(0, 0.95, 0);
    const pineFoliageMat = new THREE.MeshStandardMaterial({ color: 0x183c28, roughness: 0.82 });
    const pineFoliageInst = new THREE.InstancedMesh(pineFoliageGeom, pineFoliageMat, pineCount);
    pineFoliageInst.castShadow = true;
    pineFoliageInst.receiveShadow = true;

    bindGLBToInstanced('./assets/models/tree_pine.glb', [pineTrunkInst, pineFoliageInst]);

    // 2. Alpine Birches (400 instances) - tree_birch.glb
    const birchCount = 400;
    const birchTrunkGeom = new THREE.CylinderGeometry(0.07, 0.10, 1.1, 6);
    birchTrunkGeom.translate(0, 0.55, 0);
    const birchTrunkMat = new THREE.MeshStandardMaterial({ color: 0xded8ce, roughness: 0.75 });
    const birchTrunkInst = new THREE.InstancedMesh(birchTrunkGeom, birchTrunkMat, birchCount);
    birchTrunkInst.castShadow = true;

    const birchFoliageGeom = new THREE.DodecahedronGeometry(0.42, 1);
    birchFoliageGeom.translate(0, 1.15, 0);
    const birchFoliageMat = new THREE.MeshStandardMaterial({ color: 0x3d6b38, roughness: 0.8 });
    const birchFoliageInst = new THREE.InstancedMesh(birchFoliageGeom, birchFoliageMat, birchCount);
    birchFoliageInst.castShadow = true;

    bindGLBToInstanced('./assets/models/tree_birch.glb', [birchTrunkInst, birchFoliageInst]);

    // 3. Dead / Twisted Trees (320 instances) - tree_dead.glb
    const deadCount = 320;
    const deadGeom = new THREE.CylinderGeometry(0.08, 0.12, 1.8, 5);
    deadGeom.translate(0, 0.9, 0);
    const deadMat = new THREE.MeshStandardMaterial({ color: 0x2e241c, roughness: 0.95 });
    const deadInst = new THREE.InstancedMesh(deadGeom, deadMat, deadCount);
    deadInst.castShadow = true;

    bindGLBToInstanced('./assets/models/tree_dead.glb', [deadInst]);

    // 4. Tree Stumps (200 instances) - tree_stump.glb
    const stumpCount = 200;
    const stumpGeom = new THREE.CylinderGeometry(0.18, 0.22, 0.6, 6);
    stumpGeom.translate(0, 0.3, 0);
    const stumpMat = new THREE.MeshStandardMaterial({ color: 0x483222, roughness: 0.9 });
    const stumpInst = new THREE.InstancedMesh(stumpGeom, stumpMat, stumpCount);
    stumpInst.castShadow = true;

    bindGLBToInstanced('./assets/models/tree_stump.glb', [stumpInst]);

    // 5. Alpine Bushes / Shrubs (550 instances) - bush.glb
    const bushCount = 550;
    const bushGeom = new THREE.DodecahedronGeometry(0.35, 1);
    bushGeom.translate(0, 0.3, 0);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x254731, roughness: 0.85 });
    const bushInst = new THREE.InstancedMesh(bushGeom, bushMat, bushCount);
    bushInst.castShadow = true;

    bindGLBToInstanced('./assets/models/bush.glb', [bushInst]);

    // Populate Pines with density from noise and random lean
    let pineIdx = 0, attempts = 0;
    while (pineIdx < pineCount && attempts < 8000) {
      attempts++;
      const tx = (Math.random() - 0.5) * 1140;
      const tz = (Math.random() - 0.5) * 1140;

      const road = getRoadSignedDistance(tx, tz);
      if (road.roadDist < 6.8) continue;
      if (Math.hypot(tx - (-35), tz - 40) < 68) continue; // Lake
      if (road.signedDist < -5.0 && road.signedDist > -24.0) continue; // Ravine
      if (Math.hypot(tx - (-180), tz - 520) < 16) continue; // Crash site
      if (Math.hypot(tx - 170, tz - 260) < 18) continue; // Watchtower
      if (Math.hypot(tx - (-70), tz - (-235)) < 28) continue; // Hunter camp
      if (Math.hypot(tx - 0, tz - (-560)) < 24) continue; // Radio tower

      const noise = Math.sin(tx * 0.016) * Math.cos(tz * 0.016) + Math.sin(tx * 0.04 + tz * 0.02) * 0.35;
      if (noise < -0.05) continue; // Natural forest clearings

      const ty = getTerrainHeight(tx, tz);
      const baseScale = 5.2;
      const scale = baseScale * (0.85 + Math.random() * 0.45);
      const leanX = (Math.random() - 0.5) * 0.12;
      const leanZ = (Math.random() - 0.5) * 0.12;

      dummy.position.set(tx, ty, tz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      pineTrunkInst.setMatrixAt(pineIdx, dummy.matrix);
      pineFoliageInst.setMatrixAt(pineIdx, dummy.matrix);

      if (road.roadDist < 28) {
        this.colliders.push({
          type: 'sphere',
          center: new THREE.Vector2(tx, tz),
          radius: 0.85 * (scale / baseScale)
        });
      }
      pineIdx++;
    }

    // Populate Birches in sub-forest groves
    let birchIdx = 0; attempts = 0;
    while (birchIdx < birchCount && attempts < 5000) {
      attempts++;
      const bx = (Math.random() - 0.5) * 1140;
      const bz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(bx, bz);
      if (road.roadDist < 6.5) continue;
      if (Math.hypot(bx - (-35), bz - 40) < 68) continue;

      const noise = Math.sin(bx * 0.022) * Math.cos(bz * 0.022);
      if (noise < -0.18 || noise > 0.28) continue;

      const by = getTerrainHeight(bx, bz);
      const baseScale = 4.2;
      const scale = baseScale * (0.8 + Math.random() * 0.45);
      const leanX = (Math.random() - 0.5) * 0.10;
      const leanZ = (Math.random() - 0.5) * 0.10;

      dummy.position.set(bx, by, bz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      birchTrunkInst.setMatrixAt(birchIdx, dummy.matrix);
      birchFoliageInst.setMatrixAt(birchIdx, dummy.matrix);
      birchIdx++;
    }

    // Populate Dead Trees (concentrated on stark high ridges and passes)
    let deadIdx = 0; attempts = 0;
    while (deadIdx < deadCount && attempts < 4000) {
      attempts++;
      const dx = (Math.random() - 0.5) * 1140;
      const dz = (Math.random() - 0.5) * 1140;
      const ty = getTerrainHeight(dx, dz);
      if (dz <= 360 && dz >= -300 && ty < 28) continue; // Alpine passes & ridges

      const road = getRoadSignedDistance(dx, dz);
      if (road.roadDist < 6.0) continue;

      const baseScale = 3.6;
      const scale = baseScale * (0.8 + Math.random() * 0.5);
      dummy.position.set(dx, ty, dz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set((Math.random() - 0.5) * 0.22, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.22);
      dummy.updateMatrix();

      deadInst.setMatrixAt(deadIdx, dummy.matrix);
      deadIdx++;
    }

    // Populate Stumps near road verges and clearings
    let stumpIdx = 0; attempts = 0;
    while (stumpIdx < stumpCount && attempts < 3500) {
      attempts++;
      const sx = (Math.random() - 0.5) * 1140;
      const sz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(sx, sz);
      if (road.roadDist < 4.0 || road.roadDist > 35.0) continue;
      if (Math.hypot(sx - (-35), sz - 40) < 68) continue;

      const sy = getTerrainHeight(sx, sz);
      const baseScale = 2.0;
      const scale = baseScale * (0.8 + Math.random() * 0.5);

      dummy.position.set(sx, sy, sz);
      dummy.scale.set(scale, scale * (0.85 + Math.random() * 0.3), scale);
      dummy.rotation.set((Math.random() - 0.5) * 0.08, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.08);
      dummy.updateMatrix();

      stumpInst.setMatrixAt(stumpIdx, dummy.matrix);
      stumpIdx++;
    }

    // Populate Bushes throughout open meadows
    let bushIdx = 0; attempts = 0;
    while (bushIdx < bushCount && attempts < 4000) {
      attempts++;
      const ux = (Math.random() - 0.5) * 1140;
      const uz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(ux, uz);
      if (road.roadDist < 4.5) continue;
      if (Math.hypot(ux - (-35), uz - 40) < 68) continue;

      const uy = getTerrainHeight(ux, uz);
      const baseScale = 3.2;
      const scale = baseScale * (0.75 + Math.random() * 0.55);

      dummy.position.set(ux, uy, uz);
      dummy.scale.set(scale, scale * 0.85, scale);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.updateMatrix();

      bushInst.setMatrixAt(bushIdx, dummy.matrix);
      bushIdx++;
    }

    pineTrunkInst.instanceMatrix.needsUpdate = true;
    pineFoliageInst.instanceMatrix.needsUpdate = true;
    birchTrunkInst.instanceMatrix.needsUpdate = true;
    birchFoliageInst.instanceMatrix.needsUpdate = true;
    deadInst.instanceMatrix.needsUpdate = true;
    stumpInst.instanceMatrix.needsUpdate = true;
    bushInst.instanceMatrix.needsUpdate = true;

    this.scene.add(pineTrunkInst);
    this.scene.add(pineFoliageInst);
    this.scene.add(birchTrunkInst);
    this.scene.add(birchFoliageInst);
    this.scene.add(deadInst);
    this.scene.add(stumpInst);
    this.scene.add(bushInst);
  }

  // ---------------------------------------------------------------------------
  // PROPS: ROCKS, FALLEN LOGS, BROKEN FENCES & BARRELS
  // ---------------------------------------------------------------------------
  buildProps() {
    const dummy = new THREE.Object3D();
    const gltfLoader = new GLTFLoader();

    const bindGLBToInstanced = (url, instancedMeshes) => {
      gltfLoader.load(
        url,
        (gltf) => {
          const parts = [];
          gltf.scene.traverse((c) => {
            if (c.isMesh && c.geometry) parts.push(c);
          });
          if (parts.length >= 1 && instancedMeshes.length >= 1) {
            instancedMeshes[0].geometry = parts[0].geometry;
            instancedMeshes[0].material = parts[0].material;
            instancedMeshes[0].castShadow = true;
            instancedMeshes[0].receiveShadow = true;
          }
        },
        undefined,
        (err) => console.warn('GLB prop fallback active for ' + url, err)
      );
    };

    // 1. Crag Rocks & Boulders (600 instances) - rock.glb
    const rockCount = 600;
    const rockGeom = new THREE.DodecahedronGeometry(0.55, 1);
    rockGeom.translate(0, 0.35, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x586270, roughness: 0.92 });
    const rockInst = new THREE.InstancedMesh(rockGeom, rockMat, rockCount);
    rockInst.castShadow = true;
    rockInst.receiveShadow = true;
    bindGLBToInstanced('./assets/models/rock.glb', [rockInst]);

    let rIdx = 0, attempts = 0;
    while (rIdx < rockCount && attempts < 4000) {
      attempts++;
      const rx = (Math.random() - 0.5) * 1140;
      const rz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(rx, rz);
      if (Math.abs(road.signedDist) < 3.2) continue;
      if (Math.hypot(rx - (-35), rz - 40) < 68) continue;

      const ry = getTerrainHeight(rx, rz);
      const baseScale = 4.2;
      const scale = baseScale * (0.75 + Math.random() * 0.9);

      dummy.position.set(rx, ry, rz);
      dummy.rotation.set((Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4);
      dummy.scale.set(scale, scale * (0.8 + Math.random() * 0.4), scale);
      dummy.updateMatrix();

      rockInst.setMatrixAt(rIdx, dummy.matrix);
      if (road.roadDist < 26) {
        this.colliders.push({
          type: 'sphere',
          center: new THREE.Vector2(rx, rz),
          radius: scale * 0.32
        });
      }
      rIdx++;
    }
    rockInst.instanceMatrix.needsUpdate = true;
    this.scene.add(rockInst);

    // 2. Fallen Timber Logs (110 instances) - log.glb
    const logCount = 110;
    const logGeom = new THREE.CylinderGeometry(0.12, 0.15, 1.0, 6);
    logGeom.rotateZ(Math.PI / 2);
    logGeom.translate(0, 0.14, 0);
    const logMat = new THREE.MeshStandardMaterial({ color: 0x422f20, roughness: 0.92 });
    const logInst = new THREE.InstancedMesh(logGeom, logMat, logCount);
    logInst.castShadow = true;
    bindGLBToInstanced('./assets/models/log.glb', [logInst]);

    let logIdx = 0; attempts = 0;
    while (logIdx < logCount && attempts < 2500) {
      attempts++;
      const lx = (Math.random() - 0.5) * 1140;
      const lz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(lx, lz);
      if (road.roadDist < 4.2 || road.roadDist > 38.0) continue;
      if (Math.hypot(lx - (-35), lz - 40) < 68) continue;

      const ly = getTerrainHeight(lx, lz);
      const baseScale = 3.4;
      const scale = baseScale * (0.8 + Math.random() * 0.5);

      dummy.position.set(lx, ly, lz);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();

      logInst.setMatrixAt(logIdx, dummy.matrix);
      logIdx++;
    }
    logInst.instanceMatrix.needsUpdate = true;
    this.scene.add(logInst);

    // 3. Broken Weathered Fences (45 instances) - fence_broken.glb
    const fenceCount = 45;
    const fenceGeom = new THREE.BoxGeometry(1.0, 0.5, 0.1);
    fenceGeom.translate(0, 0.25, 0);
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x5a483a, roughness: 0.9 });
    const fenceInst = new THREE.InstancedMesh(fenceGeom, fenceMat, fenceCount);
    fenceInst.castShadow = true;
    bindGLBToInstanced('./assets/models/fence_broken.glb', [fenceInst]);

    for (let f = 0; f < fenceCount; f++) {
      const frac = 0.08 + (f / fenceCount) * 0.84;
      const pt = RoadCurve.getPoint(frac);
      const tangent = RoadCurve.getTangent(frac).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const side = (f % 2 === 0 ? 1 : -1);
      const distFromCenter = side > 0 ? 3.4 : -3.4;

      const fx = pt.x + nx * distFromCenter;
      const fz = pt.z + nz * distFromCenter;
      const fy = getTerrainHeight(fx, fz);
      const baseScale = 2.4;

      dummy.position.set(fx, fy, fz);
      dummy.rotation.set((Math.random() - 0.5) * 0.15, Math.atan2(tangent.x, tangent.z) + (Math.random() - 0.5) * 0.25, 0);
      dummy.scale.set(baseScale, baseScale, baseScale);
      dummy.updateMatrix();

      fenceInst.setMatrixAt(f, dummy.matrix);
    }
    fenceInst.instanceMatrix.needsUpdate = true;
    this.scene.add(fenceInst);

    // 4. Barrels (32 instances) - barrel.glb
    const barrelCount = 32;
    const barrelGeom = new THREE.CylinderGeometry(0.38, 0.42, 1.2, 8);
    barrelGeom.translate(0, 0.6, 0);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x504036, roughness: 0.85 });
    const barrelInst = new THREE.InstancedMesh(barrelGeom, barrelMat, barrelCount);
    barrelInst.castShadow = true;
    bindGLBToInstanced('./assets/models/barrel.glb', [barrelInst]);

    const barrelClusters = [
      { x: -182, z: 516, count: 8 },  // Crash site
      { x: 172, z: 256, count: 6 },   // Watchtower
      { x: -68, z: -238, count: 10 }, // Hunter workshop
      { x: -4, z: -552, count: 8 }    // Radio tower
    ];

    let bIdx = 0;
    for (const c of barrelClusters) {
      for (let i = 0; i < c.count && bIdx < barrelCount; i++) {
        const bx = c.x + (Math.random() - 0.5) * 7.0;
        const bz = c.z + (Math.random() - 0.5) * 7.0;
        const by = getTerrainHeight(bx, bz);
        const baseScale = 1.0;

        dummy.position.set(bx, by, bz);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.set(baseScale, baseScale, baseScale);
        dummy.updateMatrix();

        barrelInst.setMatrixAt(bIdx, dummy.matrix);
        bIdx++;
      }
    }
    barrelInst.instanceMatrix.needsUpdate = true;
    this.scene.add(barrelInst);
  }

  // ---------------------------------------------------------------------------
  // INSTANCED GRASS & WILDFLOWERS (Wind Sway & 60m Distance Culling)
  // ---------------------------------------------------------------------------
  buildGrassAndWildflowers() {
    const dummy = new THREE.Object3D();
    const gltfLoader = new GLTFLoader();

    // Wind sway & camera distance culling shader extension
    const hookWindAndCullShader = (mat) => {
      this.grassUniforms = this.grassUniforms || { uTime: { value: 0 } };
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.grassUniforms.uTime;
        shader.vertexShader = `
          uniform float uTime;
          ${shader.vertexShader}
        `;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          // Wind sway on upper blades
          float heightFactor = max(0.0, position.y);
          float sway = sin(uTime * 2.5 + instanceMatrix[3][0] * 0.35 + instanceMatrix[3][2] * 0.35) * 0.14 * heightFactor;
          transformed.x += sway;
          transformed.z += sway * 0.65;

          // Smooth distance fade & cull beyond 60m
          float camDist = length((modelViewMatrix * vec4(position, 1.0)).xyz);
          if (camDist > 60.0) {
            transformed *= 0.0001;
          } else if (camDist > 48.0) {
            transformed *= (1.0 - (camDist - 48.0) / 12.0);
          }
          `
        );
      };
    };

    // 1. Instanced Grass Clumps (1800 instances) - grass.glb
    const grassCount = 1800;
    const grassGeom = new THREE.ConeGeometry(0.35, 0.7, 5);
    grassGeom.translate(0, 0.35, 0);
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x3e7535,
      roughness: 0.85,
      metalness: 0.05
    });
    hookWindAndCullShader(grassMat);

    const grassInst = new THREE.InstancedMesh(grassGeom, grassMat, grassCount);
    grassInst.receiveShadow = true;

    gltfLoader.load('./assets/models/grass.glb', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh && c.geometry) {
          grassInst.geometry = c.geometry;
          if (c.material) {
            const m = c.material.clone();
            hookWindAndCullShader(m);
            grassInst.material = m;
          }
        }
      });
    }, undefined, (err) => console.warn('Grass GLB fallback active', err));

    let gIdx = 0, attempts = 0;
    while (gIdx < grassCount && attempts < 7000) {
      attempts++;
      const gx = (Math.random() - 0.5) * 1140;
      const gz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(gx, gz);
      if (road.roadDist < 2.8) continue;
      if (Math.hypot(gx - (-35), gz - 40) < 68) continue;

      const gy = getTerrainHeight(gx, gz);
      if (gy > 42.0) continue; // Don't spawn grass on high snowy crags

      const isForest = (Math.sin(gx * 0.018) * Math.cos(gz * 0.018) > 0.05);
      const isNearRoad = road.roadDist < 12.0;
      const baseScale = isNearRoad ? 3.2 : (isForest ? 6.2 : 4.8);
      const scale = baseScale * (0.8 + Math.random() * 0.45);

      dummy.position.set(gx, gy, gz);
      dummy.scale.set(scale, scale * (0.85 + Math.random() * 0.3), scale);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.updateMatrix();

      grassInst.setMatrixAt(gIdx, dummy.matrix);
      gIdx++;
    }
    grassInst.instanceMatrix.needsUpdate = true;
    this.scene.add(grassInst);

    // 2. Wildflowers (350 instances) - flower.glb
    const flowerCount = 350;
    const flowerGeom = new THREE.CylinderGeometry(0.04, 0.06, 0.4, 4);
    flowerGeom.translate(0, 0.2, 0);
    const flowerMat = new THREE.MeshStandardMaterial({ color: 0xdd4455, roughness: 0.8 });
    hookWindAndCullShader(flowerMat);
    const flowerInst = new THREE.InstancedMesh(flowerGeom, flowerMat, flowerCount);

    gltfLoader.load('./assets/models/flower.glb', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh && c.geometry) {
          flowerInst.geometry = c.geometry;
          if (c.material) {
            const m = c.material.clone();
            hookWindAndCullShader(m);
            flowerInst.material = m;
          }
        }
      });
    }, undefined, (err) => console.warn('Flower GLB fallback active', err));

    let fIdx = 0; attempts = 0;
    while (fIdx < flowerCount && attempts < 3500) {
      attempts++;
      const fx = (Math.random() - 0.5) * 1140;
      const fz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(fx, fz);
      if (road.roadDist < 3.2 || road.roadDist > 30.0) continue;
      if (Math.hypot(fx - (-35), fz - 40) < 68) continue;

      const fy = getTerrainHeight(fx, fz);
      if (fy > 34.0) continue;

      const baseScale = 2.8;
      const scale = baseScale * (0.8 + Math.random() * 0.4);

      dummy.position.set(fx, fy, fz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.updateMatrix();

      flowerInst.setMatrixAt(fIdx, dummy.matrix);
      fIdx++;
    }
    flowerInst.instanceMatrix.needsUpdate = true;
    this.scene.add(flowerInst);

    // 3. Small Pebbles / Rocks (350 instances) - rock_small.glb
    const pebbleCount = 350;
    const pebbleGeom = new THREE.DodecahedronGeometry(0.18, 0);
    pebbleGeom.translate(0, 0.1, 0);
    const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x626c7a, roughness: 0.95 });
    const pebbleInst = new THREE.InstancedMesh(pebbleGeom, pebbleMat, pebbleCount);
    pebbleInst.receiveShadow = true;

    gltfLoader.load('./assets/models/rock_small.glb', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh && c.geometry) {
          pebbleInst.geometry = c.geometry;
          if (c.material) pebbleInst.material = c.material;
        }
      });
    }, undefined, (err) => console.warn('Pebble GLB fallback active', err));

    let pIdx = 0; attempts = 0;
    while (pIdx < pebbleCount && attempts < 3500) {
      attempts++;
      const px = (Math.random() - 0.5) * 1140;
      const pz = (Math.random() - 0.5) * 1140;
      const road = getRoadSignedDistance(px, pz);
      if (road.roadDist < 2.5 || road.roadDist > 20.0) continue;

      const py = getTerrainHeight(px, pz);
      const baseScale = 1.4;
      const scale = baseScale * (0.7 + Math.random() * 0.6);

      dummy.position.set(px, py, pz);
      dummy.scale.set(scale, scale * (0.7 + Math.random() * 0.5), scale);
      dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      dummy.updateMatrix();

      pebbleInst.setMatrixAt(pIdx, dummy.matrix);
      pIdx++;
    }
    pebbleInst.instanceMatrix.needsUpdate = true;
    this.scene.add(pebbleInst);
  }

  // ---------------------------------------------------------------------------
  // INTERACTIVE ROAD-CORRIDOR RESOURCES (Winter Berry Bushes & Fallen Timber)
  // ---------------------------------------------------------------------------
  buildInteractiveResources() {
    // 1. Interactive Winter Berry Bushes (along the road corridor)
    for (let i = 0; i < 28; i++) {
      const frac = 0.04 + (i / 28) * 0.90;
      const pt = RoadCurve.getPoint(frac);
      const tangent = RoadCurve.getTangent(frac).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const side = (i % 2 === 0 ? 1 : -1);
      const offsetDist = side > 0 ? 3.6 : -3.6;

      const bx = pt.x + nx * offsetDist + (Math.random() - 0.5) * 2;
      const bz = pt.z + nz * offsetDist + (Math.random() - 0.5) * 2;
      const groundY = getTerrainHeight(bx, bz);

      const bushGeom = new THREE.DodecahedronGeometry(0.85, 1);
      const bushMat = new THREE.MeshStandardMaterial({ color: 0x1e3a2b });
      const bush = new THREE.Mesh(bushGeom, bushMat);
      bush.position.set(bx, groundY + 0.45, bz);
      bush.castShadow = true;
      this.scene.add(bush);

      this.createInteractable({
        id: `bush_${i}`,
        name: 'Frost Berry Bush (Gather Sustenance)',
        pos: new THREE.Vector3(bx, groundY + 0.5, bz),
        icon: '🫐',
        onInteract: () => {
          this.addItem({ id: 'berries', name: 'Winter Berries', icon: '🫐', count: 3 });
          this.hunger = Math.min(100, this.hunger + 15);
          this.gatherFood('berries');
        }
      });
    }

    // 1b. Zone 3 Glacial Lake Shore Meltwater Collection Point (x = -35, z = 32)
    const lakeWaterX = -35.0;
    const lakeWaterZ = 32.0;
    const lakeWaterY = getTerrainHeight(lakeWaterX, lakeWaterZ);
    this.createInteractable({
      id: 'lake_water',
      name: 'Collect Pure Meltwater (Lake Shore)',
      pos: new THREE.Vector3(lakeWaterX, lakeWaterY + 0.4, lakeWaterZ),
      icon: '💧',
      reachRadius: 5.2,
      onInteract: () => {
        this.collectWater();
      }
    });

    // 1c. Zone 3/4 Meadow Surveyor Expedition Tent & Auxiliary Diesel Fuel Cache (x = -45, z = -120)
    const fuelX = -45.0;
    const fuelZ = -120.0;
    const fuelY = getTerrainHeight(fuelX, fuelZ);

    const tentMat = new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.85 });
    const tent = new THREE.Mesh(new THREE.ConeGeometry(2.4, 2.2, 4), tentMat);
    tent.position.set(fuelX, fuelY + 1.1, fuelZ);
    tent.rotation.y = Math.PI / 4;
    tent.castShadow = true;
    this.scene.add(tent);

    const fuelCanMat = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.7, roughness: 0.35 });
    const fuelCan = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), fuelCanMat);
    fuelCan.position.set(fuelX + 1.4, fuelY + 0.45, fuelZ);
    fuelCan.castShadow = true;
    this.scene.add(fuelCan);

    this.createInteractable({
      id: 'meadow_fuel',
      name: 'Auxiliary Diesel Fuel Canister (Surveyor Cache)',
      pos: new THREE.Vector3(fuelX + 1.4, fuelY + 0.6, fuelZ),
      icon: '⛽',
      reachRadius: 4.8,
      onInteract: () => {
        this.collectMeadowFuel();
      }
    });

    // 2. Interactive Fallen Timber Logs
    const trunkWood = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    for (let i = 0; i < 28; i++) {
      const frac = 0.05 + (i / 28) * 0.88;
      const pt = RoadCurve.getPoint(frac);
      const tangent = RoadCurve.getTangent(frac).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const side = (i % 2 === 0 ? 1 : -1);
      const offsetDist = side > 0 ? 4.2 : -4.2;

      const lx = pt.x + nx * offsetDist + (Math.random() - 0.5) * 3;
      const lz = pt.z + nz * offsetDist + (Math.random() - 0.5) * 3;
      const groundY = getTerrainHeight(lx, lz);

      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 2.4, 6), trunkWood);
      log.rotation.z = Math.PI / 2 + (Math.random() - 0.5) * 0.4;
      log.rotation.y = Math.random() * Math.PI;
      log.position.set(lx, groundY + 0.2, lz);
      log.castShadow = true;
      this.scene.add(log);

      this.createInteractable({
        id: `log_${i}`,
        name: 'Fallen Pine Timber',
        pos: new THREE.Vector3(lx, groundY + 0.3, lz),
        icon: '🪵',
        onInteract: () => {
          this.addItem({ id: 'wood', name: 'Dry Pine Wood', icon: '🪵', count: 2 });
          this.showToast('Gathered 2x Dry Pine Wood (+Fuel)');
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // ZONE 5: RADIO TOWER & DISTRESS BEACON (x = 0, z = -560, Summit Peak)
  // ---------------------------------------------------------------------------
  buildRadioTower() {
    const towerX = 0;
    const towerZ = -560;
    const towerY = getTerrainHeight(towerX, towerZ);

    const towerGroup = new THREE.Group();
    towerGroup.position.set(towerX, towerY, towerZ);

    const metalMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9, roughness: 0.3 });

    // Concrete Foundation Pad & Helipad
    const foundationGeom = new THREE.CylinderGeometry(7.5, 8.2, 1.2, 12);
    const foundationMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    const foundation = new THREE.Mesh(foundationGeom, foundationMat);
    foundation.position.y = 0.6;
    foundation.receiveShadow = true;
    towerGroup.add(foundation);

    // Helipad 'H' Marking in Yellow Paint
    const hBarMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    const hBar1 = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 5.2), hBarMat);
    hBar1.rotation.x = -Math.PI / 2;
    hBar1.position.set(-1.6, 1.22, 0);
    towerGroup.add(hBar1);

    const hBar2 = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 5.2), hBarMat);
    hBar2.rotation.x = -Math.PI / 2;
    hBar2.position.set(1.6, 1.22, 0);
    towerGroup.add(hBar2);

    const hCross = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.8), hBarMat);
    hCross.rotation.x = -Math.PI / 2;
    hCross.position.set(0, 1.22, 0);
    towerGroup.add(hCross);

    // 30m Steel Lattice Tower Mast
    const towerHeight = 30;
    const mastGeom = new THREE.CylinderGeometry(0.7, 2.6, towerHeight, 4);
    const mast = new THREE.Mesh(mastGeom, metalMat);
    mast.position.set(0, towerHeight / 2 + 0.6, -4.5);
    mast.castShadow = true;
    mast.receiveShadow = true;
    towerGroup.add(mast);

    // High Gain Microwave Dish
    this.towerDishMesh = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 0.6, 1.2, 16), metalMat);
    this.towerDishMesh.position.set(0, towerHeight - 1, -4.0);
    this.towerDishMesh.rotation.x = 0.45;
    this.towerDishMesh.castShadow = true;
    towerGroup.add(this.towerDishMesh);

    // Pulsing Red Beacon Globe & Light
    this.beaconGlobe = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xff3300 })
    );
    this.beaconGlobe.position.set(0, towerHeight + 1.2, -4.5);
    towerGroup.add(this.beaconGlobe);

    this.beaconLight = new THREE.PointLight(0xff3300, 4.5, 180);
    this.beaconLight.position.set(0, towerHeight + 1.5, -4.5);
    towerGroup.add(this.beaconLight);

    // Ground Radio Control Terminal / Transmitter Console
    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(0, 0.6, 4.2);

    const deskMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.6, roughness: 0.4 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.9), deskMat);
    desk.position.y = 0.55;
    desk.castShadow = true;
    consoleGroup.add(desk);

    const screenMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), screenMat);
    screen.position.set(0, 1.15, 0.46);
    screen.rotation.x = -0.2;
    consoleGroup.add(screen);

    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.8, 5), darkMetal);
    ant.position.set(0.6, 1.4, -0.2);
    consoleGroup.add(ant);

    towerGroup.add(consoleGroup);
    this.scene.add(towerGroup);

    this.colliders.push({
      type: 'aabb',
      minX: towerX - 2.5,
      maxX: towerX + 2.5,
      minZ: towerZ - 6.0,
      maxZ: towerZ - 2.0
    });

    const interactY = getTerrainHeight(towerX, towerZ + 4.2) + 0.9;

    // 1. Repair / Align Microwave Antenna Dish
    this.createInteractable({
      id: 'mission_antenna',
      name: 'Microwave Antenna Dish (Calibrate Transmission)',
      pos: new THREE.Vector3(towerX + 1.6, interactY, towerZ + 4.2),
      reachRadius: 5.0,
      icon: '📡',
      onInteract: () => {
        this.alignAntennaDish();
      }
    });

    // 2. SOS Beacon Broadcast Console
    this.createInteractable({
      id: 'radio_beacon',
      name: 'Emergency SOS Beacon Transmitter (Call Helicopter Rescue)',
      pos: new THREE.Vector3(towerX, interactY, towerZ + 4.2),
      reachRadius: 6.5,
      icon: '📡',
      onInteract: () => {
        this.transmitSOSBeacon();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 5: KHAI ESCAPE ROPE LADDER SYSTEM (t = 0.88)
  // ---------------------------------------------------------------------------
  buildRopeLadder() {
    const topPt = RoadCurve.getPoint(0.88);
    const tangent = RoadCurve.getTangent(0.88).normalize();
    const nx = -tangent.z;
    const nz = tangent.x;
    const len = Math.hypot(nx, nz) || 1;
    const normX = nx / len;
    const normZ = nz / len;

    const topX = topPt.x - normX * 4.6;
    const topZ = topPt.z - normZ * 4.6;
    const topY = getTerrainHeight(topX, topZ);

    const botX = topPt.x - normX * 15.0;
    const botZ = topPt.z - normZ * 15.0;
    const botY = getTerrainHeight(botX, botZ);

    const ladderGroup = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const postGeom = new THREE.CylinderGeometry(0.12, 0.15, 1.8, 6);

    const postL = new THREE.Mesh(postGeom, postMat);
    postL.position.set(topX + tangent.x * 0.8, topY + 0.7, topZ + tangent.z * 0.8);
    ladderGroup.add(postL);

    const postR = new THREE.Mesh(postGeom, postMat);
    postR.position.set(topX - tangent.x * 0.8, topY + 0.7, topZ - tangent.z * 0.8);
    ladderGroup.add(postR);

    const topLanternLight = new THREE.PointLight(0xf59e0b, 2.5, 20);
    topLanternLight.position.set(topX, topY + 1.2, topZ);
    ladderGroup.add(topLanternLight);

    const botLanternLight = new THREE.PointLight(0x38bdf8, 3.0, 25);
    botLanternLight.position.set(botX, botY + 1.5, botZ);
    ladderGroup.add(botLanternLight);

    const rungMat = new THREE.MeshStandardMaterial({ color: 0x4a3219, roughness: 0.9 });
    const numRungs = 24;
    for (let r = 0; r <= numRungs; r++) {
      const frac = r / numRungs;
      const rx = topX + (botX - topX) * frac;
      const rz = topZ + (botZ - topZ) * frac;
      const ry = topY + (botY - topY) * frac;

      const rungMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6), rungMat);
      rungMesh.position.set(rx, ry + 0.15, rz);
      rungMesh.rotation.y = Math.atan2(tangent.x, tangent.z);
      rungMesh.rotation.z = Math.PI / 2;
      rungMesh.castShadow = true;
      ladderGroup.add(rungMesh);
    }

    this.scene.add(ladderGroup);

    this.createInteractable({
      id: 'khai_rope_ladder_bottom',
      name: 'Ascend Cliff Rope Ladder (Return to Summit Ridge)',
      pos: new THREE.Vector3(botX, botY + 1.2, botZ),
      icon: '🪜',
      onInteract: () => {
        this.teleportPlayer(topX - normX * 0.5, topY + 0.5, topZ - normZ * 0.5);
        this.sfx.playPickup();
        this.showToast('Ascended the cliff rope ladder back up to the summit ridge!');
      }
    });

    this.createInteractable({
      id: 'khai_rope_ladder_top',
      name: 'Descend Rope Ladder (Into Khai Gorge)',
      pos: new THREE.Vector3(topX, topY + 1.2, topZ),
      icon: '🪜',
      onInteract: () => {
        this.teleportPlayer(botX, botY + 0.5, botZ);
        this.sfx.playPickup();
        this.showToast('Descended the rope ladder into the frozen canyon!');
      }
    });
  }

  spawnShadowWolves() {
    // 3 shadow wolves stationed across wilderness corridors
    const wolfPositions = [
      new THREE.Vector3(-95, 1, 415),   // Zone 1/2 boundary canyon pass
      new THREE.Vector3(130, 1, 190),   // Zone 2/3 dark forest edge
      new THREE.Vector3(30, 1, -380)    // Zone 4/5 high ridge crags
    ];

    wolfPositions.forEach((pos, idx) => {
      const wolfGroup = new THREE.Group();
      const wolfY = getTerrainHeight(pos.x, pos.z) + 0.4;
      wolfGroup.position.set(pos.x, wolfY, pos.z);

      const shadowMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.3,
        metalness: 0.8
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 1.8), shadowMat);
      body.castShadow = true;
      wolfGroup.add(body);

      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xa855f7 });
      const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), eyeMat);
      leftEye.position.set(-0.25, 0.3, -0.9);
      const rightEye = leftEye.clone();
      rightEye.position.x = 0.25;
      wolfGroup.add(leftEye);
      wolfGroup.add(rightEye);

      this.scene.add(wolfGroup);
      this.shadowWolves.push({
        id: `wolf_${idx}`,
        mesh: wolfGroup,
        hp: 3,
        speed: 4.2, // Actual speed ~4 units/sec as requested
        state: 'circle',
        circleTimer: 3.0 + Math.random() * 2.5,
        circleAngle: (idx * Math.PI * 2) / 3,
        circleRadius: 8.5 + (Math.random() - 0.5) * 2.0,
        attackTimer: 0
      });
    });
  }

  createInteractable(data) {
    this.interactables.push({
      ...data,
      used: false
    });
  }

  // ---------------------------------------------------------------------------
  // MINIMAP & RADAR COMPASS (Locked until Map item is acquired from Cabin)
  // ---------------------------------------------------------------------------
  initMinimap() {
    this.minimapCanvas = document.getElementById('minimap-canvas');
    if (!this.minimapCanvas) return;
    this.minimapCtx = this.minimapCanvas.getContext('2d');
    if (this.hasMap) {
      this.unlockMinimap();
    }
  }

  unlockMinimap() {
    const lockedBox = document.getElementById('minimap-locked-content');
    const unlockedBox = document.getElementById('minimap-unlocked-content');
    if (lockedBox) lockedBox.classList.add('hidden');
    if (unlockedBox) unlockedBox.classList.remove('hidden');
    this.updateMinimap();
  }

  updateMinimap() {
    // Only update minimap radar once Map item is in inventory!
    if (!this.hasMap || !this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const center = w / 2;
    const scale = 0.14; // Radar zoom factor (~400m radar radius)

    ctx.clearRect(0, 0, w, h);

    // 1. Draw 1728m Winding Road Track
    ctx.strokeStyle = '#85664a';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    const pts = RoadCurve.getPoints(120);
    let moved = false;
    pts.forEach((pt) => {
      const rx = (pt.x - this.player.position.x) * scale + center;
      const ry = (pt.z - this.player.position.z) * scale + center;
      if (Math.hypot(rx - center, ry - center) < center + 12) {
        if (!moved) {
          ctx.moveTo(rx, ry);
          moved = true;
        } else {
          ctx.lineTo(rx, ry);
        }
      } else {
        moved = false;
      }
    });
    ctx.stroke();

    // 2. 5 Distinct Zone Landmarks on Radar
    const landmarks = [
      { name: 'ZONE 1: TRUCK', x: -180, z: 520, color: '#38bdf8', r: 4 },
      { name: 'ZONE 2: TOWER', x: 170, z: 260, color: '#22c55e', r: 4 },
      { name: 'ZONE 3: BRIDGE', x: -20, z: 20, color: '#06b6d4', r: 4 },
      { name: 'ZONE 4: CAMP', x: -70, z: -235, color: '#f59e0b', r: 4 },
      { name: 'ZONE 5: BEACON', x: 0, z: -560, color: '#ef4444', r: 5 }
    ];

    landmarks.forEach(m => {
      const mx = (m.x - this.player.position.x) * scale + center;
      const my = (m.z - this.player.position.z) * scale + center;
      const dist = Math.hypot(mx - center, my - center);
      if (dist < center - 5) {
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(mx, my, m.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const angle = Math.atan2(my - center, mx - center);
        const ex = center + Math.cos(angle) * (center - 6);
        const ey = center + Math.sin(angle) * (center - 6);
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // 3. Active Mission Targets on Radar
    this.missions.forEach(m => {
      if (m.completed) return;
      const mx = (m.coords.x - this.player.position.x) * scale + center;
      const my = (m.coords.z - this.player.position.z) * scale + center;
      const dist = Math.hypot(mx - center, my - center);
      if (dist < center - 5) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // 4. Player Arrow facing cameraYaw
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(-this.cameraYaw);
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // FULLSCREEN TOPOGRAPHIC MAP & MISSION HUD SYSTEM
  // ---------------------------------------------------------------------------
  toggleMapModal() {
    if (!this.hasMap) {
      this.showToast('No map found yet! Search the Hunter Cabin in Zone 4 to find the Surveyor Map.');
      return;
    }

    this.isMapOpen = !this.isMapOpen;
    const modal = document.getElementById('map-modal');
    if (!modal) return;

    if (this.isMapOpen) {
      modal.classList.remove('hidden');
      document.exitPointerLock();
      this.renderFullscreenMap();
    } else {
      modal.classList.add('hidden');
      if (this.isPlaying && !this.isBackpackOpen) {
        this.container.requestPointerLock();
      }
    }
  }

  renderFullscreenMap() {
    const canvas = document.getElementById('fullscreen-map-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const pad = 42;

    ctx.clearRect(0, 0, w, h);

    // Map bounds: world [-580, 580]
    const minW = -580;
    const maxW = 580;
    const mapX = (wx) => pad + ((wx - minW) / (maxW - minW)) * (w - 2 * pad);
    const mapY = (wz) => pad + ((wz - minW) / (maxW - minW)) * (h - 2 * pad);

    // 1. Topographic Elevation Background & Grid
    ctx.fillStyle = '#080d18';
    ctx.fillRect(0, 0, w, h);

    // Subtle Grid lines
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
    ctx.lineWidth = 1;
    for (let x = pad; x <= w - pad; x += 45) {
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, h - pad);
      ctx.stroke();
    }
    for (let y = pad; y <= h - pad; y += 45) {
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }

    // 2. 5 Distinct Zones Tinted Bands & Labels
    const zones = [
      { name: 'ZONE 1: CRASH SITE & PASS', z1: 580, z2: 350, color: 'rgba(120, 132, 148, 0.12)' },
      { name: 'ZONE 2: DENSE PINE FOREST', z1: 350, z2: 100, color: 'rgba(93, 107, 79, 0.14)' },
      { name: 'ZONE 3: FROZEN LAKE & GORGE', z1: 100, z2: -120, color: 'rgba(56, 189, 248, 0.12)' },
      { name: 'ZONE 4: HUNTER CAMP & WORKSHOP', z1: -120, z2: -380, color: 'rgba(180, 130, 80, 0.12)' },
      { name: 'ZONE 5: KHAI RIDGE & TOWER PEAK', z1: -380, z2: -580, color: 'rgba(168, 85, 247, 0.12)' }
    ];

    zones.forEach(z => {
      const yTop = mapY(Math.min(z.z1, z.z2));
      const yBot = mapY(Math.max(z.z1, z.z2));
      ctx.fillStyle = z.color;
      ctx.fillRect(pad, yTop, w - 2 * pad, yBot - yTop);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.font = '10px "Share Tech Mono", monospace';
      ctx.fillText(z.name, pad + 12, yTop + 18);
    });

    // 3. 1728m Winding Road Track
    ctx.strokeStyle = '#c2884a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    const roadPoints = RoadCurve.getPoints(160);
    roadPoints.forEach((pt, idx) => {
      const rx = mapX(pt.x);
      const ry = mapY(pt.z);
      if (idx === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.stroke();

    // 4. Physical Gates (8 Gates Corresponding to the 8 Linear Story Chapters)
    const gatePoints = [
      { name: 'Gate 1: Avalanche Blockade', x: -184, z: 515, open: this.gates.suvBlockade, icon: '🚗' },
      { name: 'Gate 2: Canyon Pass', x: -40, z: 420, open: this.gates.firstNight, icon: '🔥' },
      { name: 'Gate 3: Gorge Drawbridge', x: -20, z: 20, open: this.gates.villageBridge, icon: '🌉' },
      { name: 'Gate 4: Meadow Pass', x: -30, z: 25, open: this.gates.meadowPass, icon: '🫐' },
      { name: 'Gate 5: Surveyor Cache Trail', x: -45, z: -120, open: this.gates.meadowPass, icon: '⛽' },
      { name: 'Gate 6: Khai Security Gate', x: -25, z: -390, open: this.gates.khaiSecurity, icon: '⚡' },
      { name: 'Gate 7: Khai Rope Bridge', x: 65, z: -435, open: this.gates.ropeBridge, icon: '🌉' },
      { name: 'Gate 8: Summit Extraction', x: 0, z: -540, open: this.gates.helicopterRescue, icon: '🚁' }
    ];

    gatePoints.forEach(g => {
      const gx = mapX(g.x);
      const gy = mapY(g.z);
      ctx.fillStyle = g.open ? '#22c55e' : '#ef4444';
      ctx.beginPath();
      ctx.arc(gx, gy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px sans-serif';
      ctx.fillText(g.open ? 'OPEN' : 'LOCKED', gx + 9, gy + 3);
    });

    // 5. 8 Linear Story Mission Target Markers
    this.missions.forEach(m => {
      const mx = mapX(m.coords.x);
      const my = mapY(m.coords.z);

      ctx.beginPath();
      ctx.arc(mx, my, 8, 0, Math.PI * 2);
      if (m.completed) {
        ctx.fillStyle = '#22c55e';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText('✓', mx - 4, my + 3);
      } else if (m.active) {
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText('!', mx - 2, my + 3);
      } else {
        ctx.fillStyle = '#64748b';
        ctx.fill();
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '8px sans-serif';
        ctx.fillText('🔒', mx - 4, my + 3);
      }

      ctx.fillStyle = m.completed ? '#86efac' : (m.active ? '#fde047' : '#94a3b8');
      ctx.font = '10px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(m.icon + ' ' + m.title, mx + 11, my + 3);
    });

    // Radio Tower Summit Beacon Marker
    const tx = mapX(0);
    const ty = mapY(-560);
    ctx.fillStyle = this.areAllMissionsComplete() ? '#facc15' : '#ef4444';
    ctx.beginPath();
    ctx.arc(tx, ty, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('🗼 RADIO TOWER BEACON', tx + 12, ty + 4);

    // 6. Player Marker & Heading Direction
    const px = mapX(this.player.position.x);
    const py = mapY(this.player.position.z);

    // Player Direction Cone & Arrow
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-this.cameraYaw);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 24, -Math.PI / 4 - Math.PI / 2, Math.PI / 4 - Math.PI / 2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 7. Update Sidebar Mission Directory
    this.updateMapSidebar();
  }

  updateMapSidebar() {
    const list = document.getElementById('map-missions-list');
    if (!list) return;
    const completedCount = this.getCompletedMissionCount();

    const zoneElem = document.getElementById('map-player-zone');
    if (zoneElem) {
      const pz = this.player.position.z;
      if (pz > 350) zoneElem.textContent = 'ZONE 1: CRASH SITE';
      else if (pz > 100) zoneElem.textContent = 'ZONE 2: PINE FOREST';
      else if (pz > -120) zoneElem.textContent = 'ZONE 3: RIVER VALLEY';
      else if (pz > -380) zoneElem.textContent = 'ZONE 4: HUNTER CAMP';
      else zoneElem.textContent = 'ZONE 5: KHAI RIDGE';
    }

    const statElem = document.getElementById('map-mission-stat');
    if (statElem) statElem.textContent = `${completedCount}/8 COMPLETED`;

    list.innerHTML = this.missions.map(m => `
      <div class="map-mission-card ${m.completed ? 'done' : (m.active ? 'active' : 'locked')}">
        <div class="map-card-header">
          <span class="map-card-title">${m.completed ? '✅' : (m.active ? m.icon : '🔒')} ${m.title}</span>
          <span class="mission-badge-status ${m.completed ? 'done' : (m.active ? 'pending' : 'locked')}">${m.completed ? 'DONE' : (m.active ? 'ACTIVE' : 'LOCKED')}</span>
        </div>
        <p class="map-card-desc">${m.desc}</p>
        <span class="map-card-zone">📍 ${m.zone}</span>
      </div>
    `).join('');
  }

  updateMissionHUD() {
    const counterBadge = document.getElementById('missions-counter-badge');
    const completedCount = this.getCompletedMissionCount();
    if (counterBadge) counterBadge.textContent = `${completedCount}/8 DONE`;

    const list = document.getElementById('mission-list');
    if (!list) return;

    list.innerHTML = this.missions.map(m => {
      const isDone = m.completed;
      const isActive = m.active;
      let progressText = '';
      if (m.id === 'village_bridge') {
        progressText = ` (${this.villagePartsCollected}/3 Parts)`;
      } else if (m.id === 'meadow_sustenance') {
        progressText = ` (Food ${Math.min(3, this.foodCollected)}/3, Water ${this.hasWater ? '✓' : '✗'})`;
      }
      return `
        <div class="mission-item ${isDone ? 'completed' : (isActive ? 'active' : 'locked')}">
          <span class="mission-check ${isDone ? 'done' : ''}">${isDone ? '✓' : (isActive ? '▶' : '🔒')}</span>
          <span class="mission-name">${m.icon} ${m.title}${progressText}</span>
          <span class="mission-zone-tag">[${m.zone.split(':')[0]}]</span>
          <span class="mission-badge-status ${isDone ? 'done' : (isActive ? 'pending' : 'locked')}">${isDone ? 'DONE' : (isActive ? 'ACTIVE' : 'LOCKED')}</span>
        </div>
      `;
    }).join('');
  }

  getCompletedMissionCount() {
    return this.missions.filter(m => m.completed).length;
  }

  areAllMissionsComplete() {
    return this.getCompletedMissionCount() === 8;
  }

  completeMission(id) {
    const mission = this.missions.find(m => m.id === id);
    if (!mission || mission.completed) return;
    mission.completed = true;
    mission.active = false;

    // Linearly activate the next chapter mission in sequence
    const missionIdx = this.missions.findIndex(m => m.id === id);
    if (missionIdx >= 0 && missionIdx < this.missions.length - 1) {
      this.missions[missionIdx + 1].active = true;
    }

    if (id === 'suv_loot') {
      this.gates.suvBlockade = true;
      // Remove the center gap collider so player can squeeze through
      this.colliders = this.colliders.filter(c => c.id !== 'col_suv_blockade');
      // Animate boulders sinking/rolling aside over 2s then hide
      if (this.roadBlockadeGroup) {
        const boulders = this.roadBlockadeGroup.children;
        const startPositions = boulders.map(b => ({ y: b.position.y, x: b.position.x }));
        const startTime = performance.now();
        const animateBlockade = () => {
          const elapsed = (performance.now() - startTime) / 1000;
          const t = Math.min(1.0, elapsed / 2.0);
          const ease = t * t * (3 - 2 * t);
          boulders.forEach((b, i) => {
            const sp = startPositions[i];
            b.position.y = sp.y - ease * 4.0; // sink 4m
            b.position.x = sp.x + (i % 2 === 0 ? 1 : -1) * ease * 3.0; // roll aside
            b.rotation.x += 0.02 * (1 - t);
          });
          if (t < 1.0) {
            requestAnimationFrame(animateBlockade);
          } else {
            this.roadBlockadeGroup.visible = false;
          }
        };
        animateBlockade();
      }
      this.showToast('🚗 Chapter 1 Complete: SUV supplies scavenged. Head north towards canyon!');
      this.showSubtitle('MISSION 2: SURVIVE THE FIRST NIGHT', 'Sunset is closing in fast! Gather wood and ignite a campfire before dark.', 6.5);
    } else if (id === 'first_night') {
      this.gates.firstNight = true;
      this.colliders = this.colliders.filter(c => c.id !== 'col_rockslide');
      if (this.rockslideGroup) this.rockslideGroup.visible = false;
      this.triggerScreenShake(0.65);
      this.sfx.playAttack();
      this.showToast('🔥 Chapter 2 Complete: Nightfall survived! Canyon pass opened to Abandoned Village.');
      this.showSubtitle('MISSION 3: THE ABANDONED VILLAGE', 'Search village cabins for 3 drawbridge repair items: Winch Gear, Steel Cable & Crank.', 7.0);
    } else if (id === 'village_bridge') {
      this.gates.villageBridge = true;
      this.showToast('🏚️ Chapter 3 Complete: Drawbridge lowered! Cross gorge into Alpine Meadow.');
      this.showSubtitle('MISSION 4: ALPINE SUSTENANCE', 'Gather sustenance in the meadow: harvest 3 berries/fish and collect fresh meltwater.', 7.0);
    } else if (id === 'meadow_sustenance') {
      this.gates.meadowPass = true;
      this.showToast('🫐 Mission 4 Complete: Sustenance secured! Search surveyor cache for fuel.');
      this.showSubtitle('MISSION 5: LOCATE AUXILIARY FUEL', 'Find the surveyor expedition tent in the meadow and retrieve the heavy diesel canister.', 7.0);
    } else if (id === 'meadow_fuel') {
      this.gates.meadowPass = true;
      this.showToast('⛽ Mission 5 Complete: Diesel fuel secured! Proceed to Hunter Camp generator.');
      this.showSubtitle('MISSION 6: POWER MOUNTAIN GATE', 'Pour diesel fuel into the camp generator and start it to unlock the Khai Security Gate.', 7.0);
    } else if (id === 'generator') {
      this.gates.khaiSecurity = true;
      // Remove the Khai Security Gate collider
      this.colliders = this.colliders.filter(c => c.id !== 'col_khai_security' && c.id !== 'col_tower_gate');
      // Animate gate beam lifting open
      if (this.towerSecurityGateMesh) {
        const startRot = this.towerSecurityGateMesh.rotation.z;
        const startTime = performance.now();
        const animateGate = () => {
          const elapsed = (performance.now() - startTime) / 1000;
          const t = Math.min(1.0, elapsed / 1.5);
          this.towerSecurityGateMesh.rotation.z = startRot + t * (Math.PI / 2);
          if (t < 1.0) requestAnimationFrame(animateGate);
        };
        animateGate();
      }
      if (this.securityGateLight) {
        this.securityGateLight.color.setHex(0x22c55e); // Green = open
      }
      this.showToast('⚡ Mission 6 Complete: Generator running! Khai Security Gate unlocked.');
      this.showSubtitle('MISSION 7: CROSS THE KHAI CHASM', 'Cross the swaying rope suspension bridge spanning across the deep Khai Gorge abyss.', 7.0);
    } else if (id === 'rope_bridge') {
      this.gates.ropeBridge = true;
      this.showToast('🌉 Mission 7 Complete: Khai Chasm crossed! Climb to Radio Tower Summit.');
      this.showSubtitle('MISSION 8: DISTRESS CALL & RESCUE', 'Climb tower deck, align microwave antenna dish, and transmit emergency SOS beacon!', 7.5);
    } else if (id === 'radio_tower') {
      this.gates.radioTower = true;
      this.gates.helicopterRescue = true;
      if (this.beaconLight) {
        this.beaconLight.color.setHex(0x22c55e); // Green rescue light
        this.beaconLight.intensity = 6.0;
      }
      this.showToast('📡 Mission 8 Complete: SOS Distress Signal broadcast! Helicopter en route!');
      this.startHelicopterRescueCutscene();
    }

    this.updateMissionHUD();
    if (this.isMapOpen) this.renderFullscreenMap();

    const completedCount = this.getCompletedMissionCount();
    if (completedCount === 8) {
      this.showToast('🌟 ALL 8 CHAPTER MISSIONS COMPLETED! Helicopter touching down!');
    }
  }

  // ---------------------------------------------------------------------------
  // STORY HELPERS, CUTSCENES & SYSTEM GATES
  // ---------------------------------------------------------------------------
  showSubtitle(speaker, text, duration = 5.0) {
    const bar = document.getElementById('story-subtitle-bar');
    const spk = document.getElementById('subtitle-speaker');
    const txt = document.getElementById('subtitle-text');
    if (!bar || !spk || !txt) return;
    spk.textContent = speaker;
    txt.textContent = text;
    bar.classList.remove('hidden');
    if (this.subtitleTimer) clearTimeout(this.subtitleTimer);
    this.subtitleTimer = setTimeout(() => {
      bar.classList.add('hidden');
    }, duration * 1000);
  }

  openNoteModal(noteData = {}) {
    const modal = document.getElementById('note-modal');
    if (!modal) return;
    if (noteData.badge) document.getElementById('note-modal-badge').textContent = noteData.badge;
    if (noteData.title) document.getElementById('note-modal-title').textContent = noteData.title;
    if (noteData.body) document.getElementById('note-modal-body').textContent = noteData.body;
    if (noteData.author) document.getElementById('note-modal-author').textContent = noteData.author;
    modal.classList.remove('hidden');
    this.isNoteOpen = true;
    document.exitPointerLock();
  }

  closeNoteModal() {
    const modal = document.getElementById('note-modal');
    if (modal) modal.classList.add('hidden');
    this.isNoteOpen = false;
    if (this.isPlaying && !this.isBackpackOpen && !this.isMapOpen && !this.isSUVIntro) {
      this.container.requestPointerLock();
    }
  }

  startSUVIntroCutscene() {
    this.isSUVIntro = true;
    this.suvIntroTime = 0;
    this.suvBouldersFallen = false;
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    const road = getRoadSignedDistance(-180.0, 552.0);
    this.suvIntroCenterX = road.projX;

    const suv = this.wreckedSUV;
    const startY = getTerrainHeight(this.suvIntroCenterX, 552.0);
    if (suv) {
      suv.root.position.set(this.suvIntroCenterX, startY + 0.35, 552.0);
      suv.root.rotation.set(0, 0, 0);
    }

    // Hide first-person arms & torch during intro
    if (this.fpArms) this.fpArms.root.visible = false;
    if (this.torchLight) this.torchLight.intensity = 0;
    if (this.flameMesh) this.flameMesh.visible = false;

    this.sfx.playRadioSpeech("Winter storm is coming. All villagers, move out now.");
    this.showSubtitle("📻 RADIO TRANSMISSION", "Winter storm is coming. All villagers, move out now.", 7.0);
  }

  updateSUVIntroCutscene(delta) {
    this.suvIntroTime += delta;
    const suv = this.wreckedSUV;
    const carX = this.suvIntroCenterX || -180.0; // road centerline X

    if (this.suvIntroTime < 3.4) {
      // SUV moving forward along road from z = 552 towards z = 518
      const t = Math.min(1.0, this.suvIntroTime / 3.4);
      const curZ = 552.0 - t * 34.0;
      const road = getRoadSignedDistance(carX, curZ);
      const curX = road.projX;
      const curY = getTerrainHeight(curX, curZ);

      if (suv) {
        suv.root.position.set(curX, curY + 0.35, curZ);
        suv.update(delta, 16.0);
      }

      // Smooth GTA-style 3rd-person chase camera following behind and slightly above the SUV
      const camY = curY + 2.8 + Math.sin(this.suvIntroTime * 18.0) * 0.04;
      const camZ = curZ + 6.8;
      this.camera.position.set(curX, camY, camZ);
      this.camera.lookAt(curX, curY + 1.1, curZ - 14.0);

      // Trigger rockslide at t = 2.4s
      if (this.suvIntroTime >= 2.4 && !this.suvBouldersFallen) {
        this.suvBouldersFallen = true;
        this.sfx.playRockslideRumble();
        this.triggerScreenShake(0.85);
        this.showSubtitle("DRIVER", "WATCH OUT! Boulders tumbling from the mountain cliff!", 4.0);
      }
    } else {
      // SUV stopped at z = 518 (Wrecked against the landslide blockade)
      const stopZ = 518.0;
      const road = getRoadSignedDistance(carX, stopZ);
      const curX = road.projX;
      const curY = getTerrainHeight(curX, stopZ);

      if (suv) {
        suv.root.position.set(curX, curY + 0.35, stopZ);
        suv.root.rotation.set(0.06, 0.45, 0.12);
        suv.update(delta, 0);
      }

      // Dramatic cinematic 3/4 angle overlooking wrecked vehicle and boulders
      this.camera.position.set(curX - 4.2, curY + 2.2, stopZ + 4.8);
      this.camera.lookAt(curX, curY + 1.0, stopZ);

      const prompt = document.getElementById('interaction-prompt');
      if (prompt) {
        prompt.classList.remove('hidden');
        document.getElementById('interact-text').textContent = 'Press [E] or [Space] to Exit Damaged SUV';
      }
    }
  }

  exitSUV() {
    if (!this.isSUVIntro) return;
    this.isSUVIntro = false;
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');

    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    // Place player on flat road ground (|signedDist|<2, grade<0.3), at least 3m from every collider
    const safeTarget = new THREE.Vector3(-180.0, getTerrainHeight(-180.0, 524.0) + 0.5, 524.0);
    const walkable = this.ensureWalkable(safeTarget);
    this.player.position.copy(walkable);
    this.camera.position.set(walkable.x, walkable.y + 1.6, walkable.z);
    this.cameraYaw = -0.64;
    this.cameraPitch = 0;
    this.lastSafePosition = walkable.clone();

    // Restore first-person arms & torch
    if (this.fpArms && this.cameraMode === 'first') this.fpArms.root.visible = true;
    if (this.isTorchOn && this.torchFuel > 0) {
      if (this.torchLight) this.torchLight.intensity = 2.5;
      if (this.flameMesh) this.flameMesh.visible = true;
    }

    this.container.requestPointerLock();
    this.showSubtitle("SURVIVOR", "The road is sealed between the river and cliff. I must loot the SUV storage before dark.", 6.0);
    this.showToast("Exited damaged SUV. Press [E] to loot emergency supplies from the trunk!");
  }

  lootSUV() {
    this.addItem({ id: 'oil', name: 'Engine Kerosene Oil', icon: '🛢️', count: 1 });
    this.addItem({ id: 'matches', name: 'Flint & Matches', icon: '🔥', count: 3 });
    this.addItem({ id: 'blanket', name: 'Thermal Wool Blanket', icon: '🧣', count: 1 });
    this.addItem({ id: 'ration', name: 'Canned Food Rations', icon: '🥫', count: 2 });
    this.addItem({ id: 'torch', name: 'Alpine Expedition Torch', icon: '🔦', count: 1 });
    this.torchFuel = 100;
    this.warmth = 100;
    this.sfx.playPickup();
    this.showToast('Looted SUV: Oil, Matches, Blanket, Food, Torch!');
    this.completeMission('suv_loot');
  }

  igniteFirstNightCampfire() {
    const campPos = new THREE.Vector3(-130, getTerrainHeight(-130, 450), 450);
    const fireLight = new THREE.PointLight(0xff6600, 3.8, 16, 1.5);
    fireLight.position.set(campPos.x, campPos.y + 0.8, campPos.z);
    this.scene.add(fireLight);

    const fireParticles = new FlameParticleSystem(this.scene, 32, 0.45, 1.5, 0.25);
    this.campfires.push({
      pos: campPos,
      light: fireLight,
      timeRemaining: 360,
      flameParticles: fireParticles
    });
    this.sfx.playTorchIgnite();
    this.completeMission('first_night');
  }

  checkVillageBridgeProgress() {
    this.updateMissionHUD();
    if (this.isMapOpen) this.renderFullscreenMap();
    if (this.villagePartsCollected >= 3) {
      this.showToast('All 3 bridge parts collected! Proceed to the Drawbridge Winch to cross the gorge.');
    }
  }

  lowerDrawbridge() {
    if (this.bridgeGateGroup) {
      this.bridgeGateGroup.rotation.x = Math.PI / 2;
      this.bridgeGateGroup.position.y -= 1.8;
    }
    this.colliders = this.colliders.filter(c => c.id !== 'col_bridge');
    this.sfx.playDrawbridgeLower();
    this.triggerScreenShake(0.55);
    this.showToast('Gorge Drawbridge lowered! Route across the river is open.');
    this.completeMission('village_bridge');
  }

  gatherFood(type) {
    this.foodCollected++;
    this.sfx.playPickup();
    this.showToast(`Gathered wild sustenance! (Food: ${this.foodCollected}/3, Water: ${this.hasWater ? '✓' : '✗'})`);
    this.checkMeadowSustenance();
  }

  collectWater() {
    if (this.hasWater) {
      this.showToast('Already carrying fresh meltwater!');
      return;
    }
    this.hasWater = true;
    this.sfx.playWaterSplash();
    this.addItem({ id: 'water_canteen', name: 'Fresh Meltwater Canteen', icon: '💧', count: 1 });
    this.showToast(`Collected pure meltwater! (Food: ${this.foodCollected}/3, Water: ✓)`);
    this.checkMeadowSustenance();
  }

  checkMeadowSustenance() {
    const m = this.missions.find(mi => mi.id === 'meadow_sustenance');
    if (m) {
      m.foodProgress = Math.min(3, this.foodCollected);
      m.hasWater = this.hasWater;
    }
    this.updateMissionHUD();
    if (this.isMapOpen) this.renderFullscreenMap();
    if (this.foodCollected >= 3 && this.hasWater && m && !m.completed) {
      this.completeMission('meadow_sustenance');
    }
  }

  collectMeadowFuel() {
    this.addItem({ id: 'diesel', name: 'Heavy Diesel Fuel Canister', icon: '⛽', count: 1 });
    this.sfx.playPickup();
    this.showToast('Retrieved Heavy Diesel Canister! Ready to power the mountain camp generator.');
    this.completeMission('meadow_fuel');
  }

  checkRopeBridgeCrossing() {
    const m = this.missions.find(mi => mi.id === 'rope_bridge');
    if (m && m.active && !m.completed) {
      // Crossing northward towards summit peak: z < -455
      if (this.player.position.z < -455 && this.player.position.x > 30 && this.player.position.x < 110) {
        this.completeMission('rope_bridge');
      }
    }
  }

  alignAntennaDish() {
    this.antennaAligned = true;
    if (this.towerDishMesh) {
      this.towerDishMesh.rotation.y = 0.8;
      this.towerDishMesh.rotation.x = 0.2;
    }
    this.sfx.playPickup();
    this.showToast('Microwave antenna aligned! Distress transmitter online.');
    this.showSubtitle('RADIO TOWER', 'Antenna calibrated to emergency SAR frequency. Activate SOS transmitter!', 5.0);
    this.updateMissionHUD();
  }

  transmitSOSBeacon() {
    if (!this.antennaAligned) {
      this.showToast('Must align microwave antenna dish first!');
      return;
    }
    this.completeMission('radio_tower');
  }

  startHelicopterRescueCutscene() {
    this.isHelicopterRescue = true;
    this.helicopterRescueTime = 0;
    this.pilotSpeechPlayed = false;

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
    this.updateCinematicOverlay(
      'CHAPTER 6: EXTRACTION',
      'RESCUE HELICOPTER INBOUND',
      'Search & Rescue helicopter responding to the Radio Tower SOS'
    );

    if (this.rescueHelicopter) {
      this.rescueHelicopter.root.visible = true;
      this.rescueHelicopter.root.position.set(65, 82, -640);
    }
    this.sfx.playHelicopterRotor();
    document.exitPointerLock();
  }

  updateHelicopterRescue(delta) {
    this.helicopterRescueTime += delta;
    const t = this.helicopterRescueTime;
    const heli = this.rescueHelicopter;

    if (heli) {
      heli.update(delta);

      // Smooth swoop in from sky (65, 82, -640) to helipad (0, 36.5, -540)
      const flightDuration = 6.5;
      const progress = Math.min(1.0, t / flightDuration);
      const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

      const startPos = new THREE.Vector3(65, 82, -640);
      const landingPos = new THREE.Vector3(0, getTerrainHeight(0, -540) + 0.2, -540);
      heli.root.position.lerpVectors(startPos, landingPos, ease);

      if (progress < 0.8) {
        heli.root.rotation.set(-0.15, -0.65, 0.08);
      } else {
        heli.root.rotation.set(0, -0.4, 0);
      }

      // Camera pans cinematically watching the helicopter landing
      const camPos = new THREE.Vector3(12, landingPos.y + 6.0, -525);
      this.camera.position.lerp(camPos, delta * 2.0);
      this.camera.lookAt(heli.root.position);
    }

    if (t >= 3.8 && !this.pilotSpeechPlayed) {
      this.pilotSpeechPlayed = true;
      this.sfx.playRadioSpeech("Search and rescue team here. We see your signal! Survivor onboard, let's get out of here!");
      this.showSubtitle("🚁 RESCUE PILOT", "Search and rescue team here. We see your signal! Survivor onboard, let's get out of here!", 7.5);
    }

    if (t >= 8.0) {
      this.isHelicopterRescue = false;
      this.sfx.stopHelicopterRotor();
      this.triggerVictory();
    }
  }

  lightSignalFire(index, pyrePos) {
    if (this[`pyre_${index}_lit`]) {
      this.showToast('This signal fire is already blazing!');
      return;
    }
    this[`pyre_${index}_lit`] = true;
    this.signalFiresLit++;

    const fireLight = new THREE.PointLight(0xff7722, 4.0, 45);
    fireLight.position.set(pyrePos.x, pyrePos.y + 1.6, pyrePos.z);
    this.scene.add(fireLight);

    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffaa00 })
    );
    flame.position.set(pyrePos.x, pyrePos.y + 1.2, pyrePos.z);
    this.scene.add(flame);

    this.sfx.playTorchIgnite();

    const mission = this.missions.find(m => m.id === 'signal_fires');
    if (mission) {
      mission.progress = this.signalFiresLit;
      if (this.signalFiresLit >= 3) {
        this.completeMission('signal_fires');
      } else {
        this.showToast(`🔥 Signal Fire ${this.signalFiresLit}/3 Ignited on the peaks!`);
        this.updateMissionHUD();
        if (this.isMapOpen) this.renderFullscreenMap();
      }
    }
  }

  pickupMap() {
    if (this.hasMap) return;
    this.hasMap = true;
    this.addItem({ id: 'map', name: 'Surveyor Mountain Map', icon: '🗺️', count: 1 });
    this.unlockMinimap();
    this.sfx.playPickup();
    this.showToast('🗺️ ACQUIRED SURVEYOR MOUNTAIN MAP! Minimap radar unlocked. Press [M] for Fullscreen Map.');
    if (this.cabinMapMesh) this.cabinMapMesh.visible = false;
    this.interactables = this.interactables.filter(item => item.id !== 'cabin_map');
  }

  // ---------------------------------------------------------------------------
  // MISSION 3D OBJECTS & GATES BUILDERS
  // ---------------------------------------------------------------------------
  buildCanyonRockslideGate() {
    const rockslideX = -40;
    const rockslideZ = 420;
    const groundY = getTerrainHeight(rockslideX, rockslideZ);

    this.rockslideGroup = new THREE.Group();
    this.rockslideGroup.position.set(rockslideX, groundY, rockslideZ);

    const rockMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.35 });
    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.5 });

    const boulderPositions = [
      [-2.4, 1.0, -1.2, 2.2],
      [0.0, 1.4, 0.0, 2.8],
      [2.5, 0.9, 1.0, 2.0],
      [-1.2, 2.2, 0.5, 1.8],
      [1.4, 2.0, -0.6, 1.6]
    ];
    boulderPositions.forEach(([bx, by, bz, br]) => {
      const b = new THREE.Mesh(new THREE.DodecahedronGeometry(br, 1), rockMat);
      b.position.set(bx, by, bz);
      b.castShadow = true;
      this.rockslideGroup.add(b);
    });

    const beam = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.35, 0.35), woodMat);
    beam.position.set(0, 1.5, -2.2);
    beam.rotation.y = 0.2;
    this.rockslideGroup.add(beam);

    const lantern = new THREE.PointLight(0xef4444, 3.0, 20);
    lantern.position.set(0, 2.6, 0);
    this.rockslideGroup.add(lantern);

    this.scene.add(this.rockslideGroup);

    // -------------------------------------------------------------------------
    // WORKING CRANE & WINCH NEAR THE ROCKSLIDE (x = -46.5, z = 416)
    // -------------------------------------------------------------------------
    const craneX = -46.5;
    const craneZ = 416.0;
    const craneY = getTerrainHeight(craneX, craneZ);
    const craneGroup = new THREE.Group();
    craneGroup.position.set(craneX, craneY, craneZ);

    // Concrete Base Pedestal
    const cBase = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 0.8, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 }));
    cBase.position.y = 0.4;
    craneGroup.add(cBase);

    // 6.5m Steel Column Mast
    const cMast = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 6.5, 6), steelMat);
    cMast.position.y = 3.65;
    cMast.castShadow = true;
    craneGroup.add(cMast);

    // Winch Motor & Spool Mechanism
    const winchMotor = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.9), yellowMat);
    winchMotor.position.set(0, 1.4, 0.3);
    craneGroup.add(winchMotor);

    this.craneWinchSpool = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 10), new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.9 }));
    this.craneWinchSpool.position.set(0, 1.4, 0.8);
    this.craneWinchSpool.rotation.z = Math.PI / 2;
    craneGroup.add(this.craneWinchSpool);

    // Pivoting Crane Boom Arm (8m long extending over rockslide boulders)
    this.craneBoom = new THREE.Group();
    this.craneBoom.position.set(0, 6.5, 0);

    const boomArm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 7.8), yellowMat);
    boomArm.position.set(0, 1.4, 3.6);
    boomArm.rotation.x = -0.38;
    boomArm.castShadow = true;
    this.craneBoom.add(boomArm);

    // Pulley Wheel at Boom Tip
    const pulley = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 4, 10), steelMat);
    pulley.position.set(0, 2.7, 6.8);
    this.craneBoom.add(pulley);

    // Steel Hoist Cable running down to rockslide
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 4.8, 4), steelMat);
    cable.position.set(0, 0.4, 6.8);
    this.craneBoom.add(cable);

    // Heavy Iron Hook hitched to boulder
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.06, 6, 8), steelMat);
    hook.position.set(0, -1.9, 6.8);
    hook.rotation.y = Math.PI / 2;
    this.craneBoom.add(hook);

    craneGroup.add(this.craneBoom);
    this.scene.add(craneGroup);

    this.craneActive = false;

    this.rockslideCollider = {
      id: 'col_rockslide',
      type: 'aabb',
      minX: rockslideX - 4.5,
      maxX: rockslideX + 4.5,
      minZ: rockslideZ - 3.5,
      maxZ: rockslideZ + 3.5
    };
    this.colliders.push(this.rockslideCollider);

    this.createInteractable({
      id: 'mission_rockslide',
      name: 'Recovery Crane & Winch (Clear Rockslide Barricade)',
      pos: new THREE.Vector3(craneX + 1.2, craneY + 1.2, craneZ),
      icon: '🏗️',
      onInteract: () => {
        this.completeMission('rockslide');
      }
    });

    this.createInteractable({
      id: 'blasting_cache',
      name: 'Emergency Blasting Cache',
      pos: new THREE.Vector3(rockslideX, groundY + 1.2, rockslideZ - 2.8),
      icon: '💥',
      onInteract: () => {
        this.completeMission('rockslide');
      }
    });
  }

  buildTowerSecurityGate() {
    // Place Khai Security Gate ON the road near the khai ledge (z ~ -390)
    const roadGate = getRoadSignedDistance(-25, -390);
    const gateX = roadGate.projX;
    const gateZ = roadGate.projZ;
    const groundY = getTerrainHeight(gateX, gateZ);
    // Rotate gate perpendicular to road tangent
    const gateAngle = Math.atan2(roadGate.tx, roadGate.tz);

    const gatePostMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.9, roughness: 0.25 });

    const gateGroup = new THREE.Group();
    gateGroup.position.set(gateX, groundY, gateZ);
    gateGroup.rotation.y = gateAngle;

    [-3.2, 3.2].forEach(px => {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 4.8, 0.8), gatePostMat);
      pylon.position.set(px, 2.4, 0);
      pylon.castShadow = true;
      gateGroup.add(pylon);
    });

    this.towerSecurityGateMesh = new THREE.Group();
    const barrierBeam = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.4, 0.2), steelMat);
    barrierBeam.position.set(2.8, 2.0, 0);
    this.towerSecurityGateMesh.position.set(-2.8, 0, 0);
    this.towerSecurityGateMesh.add(barrierBeam);
    gateGroup.add(this.towerSecurityGateMesh);

    this.securityGateLight = new THREE.PointLight(0xef4444, 3.5, 25);
    this.securityGateLight.position.set(0, 4.5, 0);
    gateGroup.add(this.securityGateLight);

    const lightGlobe = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3300 }));
    lightGlobe.position.set(0, 4.5, 0);
    gateGroup.add(lightGlobe);

    this.scene.add(gateGroup);

    // Collider aligned to road using rotated AABB
    // For simplicity, compute world-space AABB using the gate's orientation
    const sinA = Math.sin(gateAngle);
    const cosA = Math.cos(gateAngle);
    const hw = 3.6; // half-width
    const hd = 2.0; // half-depth
    // Compute axis-aligned bounding box of the rotated rectangle
    const extX = Math.abs(hw * cosA) + Math.abs(hd * sinA);
    const extZ = Math.abs(hw * sinA) + Math.abs(hd * cosA);

    this.towerGateCollider = {
      id: 'col_khai_security',
      type: 'aabb',
      minX: gateX - extX,
      maxX: gateX + extX,
      minZ: gateZ - extZ,
      maxZ: gateZ + extZ
    };
    if (!this.gates.khaiSecurity) {
      this.colliders.push(this.towerGateCollider);
    }
  }

  buildSignalFirePyres() {
    const pyres = [
      { id: 1, x: -140, z: 480, name: 'Scree Peak Beacon Pyre (Zone 1)' },
      { id: 2, x: 190, z: 240, name: 'Watchtower Ridge Beacon Pyre (Zone 2)' },
      { id: 3, x: -80, z: -30, name: 'Glacial Lake Overlook Pyre (Zone 3)' }
    ];

    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });

    pyres.forEach(p => {
      const py = getTerrainHeight(p.x, p.z);
      const group = new THREE.Group();
      group.position.set(p.x, py, p.z);

      const pit = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, 0.7, 8), stoneMat);
      pit.position.y = 0.35;
      pit.castShadow = true;
      group.add(pit);

      for (let l = 0; l < 5; l++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.2, 5), woodMat);
        log.position.set(Math.cos(l * 1.25) * 0.45, 1.0, Math.sin(l * 1.25) * 0.45);
        log.rotation.x = 0.25;
        log.rotation.y = l * 1.25;
        group.add(log);
      }

      this.scene.add(group);

      this.createInteractable({
        id: `pyre_${p.id}`,
        name: `${p.name} (Ignite Beacon Fire)`,
        pos: new THREE.Vector3(p.x, py + 1.1, p.z),
        icon: '🔥',
        onInteract: () => {
          this.lightSignalFire(p.id, new THREE.Vector3(p.x, py, p.z));
        }
      });
    });
  }

  buildTowerTelemetrySubstation() {
    const subX = 0;
    const subZ = -555;
    const groundY = getTerrainHeight(subX, subZ);

    const metalMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.3 });
    const dishMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.2 });

    const group = new THREE.Group();
    group.position.set(subX, groundY, subZ);

    const terminalBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 1.0), metalMat);
    terminalBox.position.y = 1.0;
    terminalBox.castShadow = true;
    group.add(terminalBox);

    const miniDish = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.2, 0.4, 12), dishMat);
    miniDish.position.set(0, 2.3, 0);
    miniDish.rotation.x = 0.4;
    group.add(miniDish);

    this.scene.add(group);

    this.createInteractable({
      id: 'mission_antenna',
      name: 'Tower Substation Telemetry (Calibrate Antenna Relay)',
      pos: new THREE.Vector3(subX, groundY + 1.2, subZ + 0.8),
      icon: '📡',
      onInteract: () => {
        this.completeMission('antenna');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // INPUT & CONTROLS
  // ---------------------------------------------------------------------------
  setupEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.composer) {
        this.composer.setSize(window.innerWidth, window.innerHeight);
      }
    });

    // Fullscreen change handler: resize renderer/composer and re-request pointer lock
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        if (this.composer) {
          this.composer.setSize(window.innerWidth, window.innerHeight);
        }
        if (document.fullscreenElement && this.isPlaying && !this.isBackpackOpen && !this.isMapOpen) {
          this.container.requestPointerLock();
        }
      }, 100);
    });

    // Auto-unlock title screen music & atmospheric ambience on user's first interaction
    const unlockTitleAudio = () => {
      if (!this.isPlaying && this.sfx) {
        this.sfx.startTitleAmbience();
      }
    };
    window.addEventListener('pointerdown', unlockTitleAudio, { once: true });
    window.addEventListener('keydown', unlockTitleAudio, { once: true });

    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;

      // 60-second Trailer Mode Key (T)
      if (e.code === 'KeyT') {
        e.preventDefault();
        this.toggleTrailerMode();
        return;
      }

      // Cinematic & Cutscene Skip handler (Space, Esc, Enter)
      if (this.isIntroPanning || this.isTrailerMode || this.isSUVIntro) {
        if (e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter') {
          e.preventDefault();
          if (this.isIntroPanning) this.endIntroCameraPan();
          if (this.isTrailerMode) this.stopTrailerMode();
          if (this.isSUVIntro) this.exitSUV();
          return;
        }
      }

      if (e.code === 'Tab') {
        e.preventDefault();
        this.toggleBackpack();
      }
      if (e.code === 'KeyM') {
        e.preventDefault();
        this.toggleMapModal();
      }
      if (e.code === 'Escape') {
        if (this.isNoteOpen) this.closeNoteModal();
        else if (this.isMapOpen) this.toggleMapModal();
        else if (this.isBackpackOpen) this.toggleBackpack();
      }
      if (e.code === 'KeyF') {
        this.toggleTorch();
      }
      if (e.code === 'KeyG') {
        e.preventDefault();
        this.toggleFullscreen();
      }
      if (e.code === 'KeyU') {
        e.preventDefault();
        this.unstuck();
      }
      if (e.code === 'KeyV') {
        e.preventDefault();
        this.toggleCameraMode();
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        this.togglePostProcessing();
      }
      if (e.code === 'KeyZ') {
        this.checkSleepNearFire();
      }
      if (e.code === 'KeyE') {
        if (this.isSUVIntro) {
          this.exitSUV();
        } else {
          this.tryInteract();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    this.container.addEventListener('click', () => {
      if (this.isPlaying && !this.isBackpackOpen && !this.isMapOpen && !this.isIntroPanning && !this.isTrailerMode) {
        this.container.requestPointerLock();
        this.sfx.init();
      }
    });

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.isPlaying && !this.isBackpackOpen && !this.isMapOpen && !this.isIntroPanning && !this.isTrailerMode) {
        this.performAttack();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.container && !this.isIntroPanning && !this.isTrailerMode) {
        const sensitivity = 0.0020;
        this.cameraYaw -= e.movementX * sensitivity;
        this.cameraPitch -= e.movementY * sensitivity;
        const maxPitch = 1.35; // ~77 degrees
        this.cameraPitch = Math.max(-maxPitch, Math.min(maxPitch, this.cameraPitch));
      }
    });

    document.getElementById('btn-start').addEventListener('click', () => this.startGame());

    const btnFs = document.getElementById('btn-fullscreen');
    if (btnFs) {
      btnFs.addEventListener('click', () => this.toggleFullscreen());
    }

    const btnTrailer = document.getElementById('btn-trailer');
    if (btnTrailer) {
      btnTrailer.addEventListener('click', () => this.startTrailerMode());
    }

    const cinematicSkip = document.getElementById('cinematic-skip');
    if (cinematicSkip) {
      cinematicSkip.addEventListener('click', () => {
        if (this.isIntroPanning) this.endIntroCameraPan();
        if (this.isSUVIntro) this.exitSUV();
        if (this.isTrailerMode) this.stopTrailerMode();
      });
    }

    document.getElementById('btn-how').addEventListener('click', () => {
      document.getElementById('controls-modal').classList.remove('hidden');
    });
    document.getElementById('btn-close-how').addEventListener('click', () => {
      document.getElementById('controls-modal').classList.add('hidden');
    });

    const testMapBtn = document.getElementById('btn-test-map');
    if (testMapBtn) {
      testMapBtn.addEventListener('click', () => {
        if (!this.isPlaying) this.startGame();
        this.pickupMap();
        this.completeMission('suv_loot');
        this.completeMission('first_night');
        document.getElementById('controls-modal').classList.add('hidden');
        this.toggleMapModal();
      });
    }

    document.getElementById('btn-restart').addEventListener('click', () => location.reload());
    document.getElementById('btn-victory-replay').addEventListener('click', () => location.reload());

    const closeMapBtn = document.getElementById('btn-close-map');
    if (closeMapBtn) closeMapBtn.addEventListener('click', () => this.toggleMapModal());
    const openMapHint = document.getElementById('btn-open-map-hint');
    if (openMapHint) openMapHint.addEventListener('click', () => this.toggleMapModal());
    if (this.minimapCanvas) {
      this.minimapCanvas.addEventListener('click', () => {
        if (this.hasMap) this.toggleMapModal();
      });
    }

    const btnCloseNote = document.getElementById('btn-close-note');
    if (btnCloseNote) {
      btnCloseNote.addEventListener('click', () => this.closeNoteModal());
    }

    document.getElementById('btn-craft-torch').addEventListener('click', () => this.craftTorch());
    document.getElementById('btn-craft-campfire').addEventListener('click', () => this.craftCampfire());

    const camWidget = document.getElementById('camera-mode-widget');
    if (camWidget) {
      camWidget.addEventListener('click', () => this.toggleCameraMode());
    }

    const postProcWidget = document.getElementById('postproc-widget');
    if (postProcWidget) {
      postProcWidget.addEventListener('click', () => this.togglePostProcessing());
    }

    const btnOpenCredits = document.getElementById('btn-open-credits');
    const btnCloseCredits = document.getElementById('btn-close-credits');
    const creditsModal = document.getElementById('credits-modal');
    if (btnOpenCredits && creditsModal) {
      btnOpenCredits.addEventListener('click', () => creditsModal.classList.remove('hidden'));
    }
    if (btnCloseCredits && creditsModal) {
      btnCloseCredits.addEventListener('click', () => creditsModal.classList.add('hidden'));
    }
  }

  startGame() {
    this.isPlaying = true;
    this.sfx.init();
    this.sfx.stopTitleAmbience();
    this.sfx.playTorchIgnite();
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    this.updateMissionHUD();
    // Request fullscreen when starting the game
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    this.startSUVIntroCutscene();
  }

  toggleTorch() {
    if (this.torchFuel <= 0) {
      this.showToast('Torch fuel depleted! Find kerosene or craft a new torch.');
      this.isTorchOn = false;
    } else {
      this.isTorchOn = !this.isTorchOn;
      this.sfx.playTorchIgnite();
    }
    if (this.fpArms) {
      this.fpArms.setHeldItem('torch');
    }
    this.torchLight.intensity = this.isTorchOn ? 2.5 : 0;
    this.flameMesh.visible = this.isTorchOn;
    document.getElementById('active-tool-icon').textContent = this.isTorchOn ? '🔦' : '🌑';
    document.getElementById('active-tool-name').textContent = this.isTorchOn ? 'Torched Pine' : 'Unlit Branch';
  }

  toggleCameraMode() {
    this.cameraMode = (this.cameraMode === 'first') ? 'third' : 'first';
    const isFirst = (this.cameraMode === 'first');

    if (this.fpArms) {
      this.fpArms.root.visible = isFirst;
    }
    if (this.thirdPersonPlayer) {
      this.thirdPersonPlayer.setFirstPerson(isFirst);
    }
    this.thirdPersonCamPosInitialized = false;

    const desc = document.getElementById('camera-mode-desc');
    if (desc) {
      desc.textContent = isFirst ? '1ST PERSON [V]' : '3RD PERSON [V]';
    }
    this.showToast(isFirst ? 'Switched to First-Person View (Arms visible)' : 'Switched to Third-Person View (Shoulder cam)');
  }

  toggleBackpack() {
    this.isBackpackOpen = !this.isBackpackOpen;
    const backpackModal = document.getElementById('backpack-screen');
    if (this.isBackpackOpen) {
      backpackModal.classList.remove('hidden');
      document.exitPointerLock();
      this.renderBackpackGrid();
    } else {
      backpackModal.classList.add('hidden');
      if (this.isPlaying) this.container.requestPointerLock();
    }
  }

  renderBackpackGrid() {
    const grid = document.getElementById('inventory-grid');
    grid.innerHTML = '';
    document.getElementById('inv-count').textContent = this.inventory.length;

    for (let i = 0; i < 8; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      const item = this.inventory[i];
      if (item) {
        slot.innerHTML = `
          <span class="slot-icon">${item.icon}</span>
          <span class="slot-qty">${item.count}x</span>
        `;
        slot.title = item.name;
        slot.addEventListener('click', () => this.useItem(item));
      }
      grid.appendChild(slot);
    }
  }

  useItem(item) {
    if (this.fpArms) {
      if (item.id === 'berries' || item.id === 'ration' || item.id === 'canned_soup') {
        this.fpArms.setHeldItem('food');
        this.fpArms.triggerUseAnimation();
        setTimeout(() => { if (this.isTorchOn && this.fpArms) this.fpArms.setHeldItem('torch'); }, 1400);
      } else if (item.id === 'matches') {
        this.fpArms.setHeldItem('matches');
        this.fpArms.triggerUseAnimation();
        setTimeout(() => { if (this.isTorchOn && this.fpArms) this.fpArms.setHeldItem('torch'); }, 1400);
      } else if (item.id === 'kerosene') {
        this.fpArms.setHeldItem('tools');
        this.fpArms.triggerUseAnimation();
        setTimeout(() => { if (this.isTorchOn && this.fpArms) this.fpArms.setHeldItem('torch'); }, 1400);
      } else {
        this.fpArms.triggerUseAnimation();
      }
    }

    if (item.id === 'berries') {
      this.hunger = Math.min(100, this.hunger + 15);
      this.consumeItem(item.id, 1);
      this.sfx.playPickup();
      this.showToast('Ate fresh berries! (+15 Hunger)');
    } else if (item.id === 'ration' || item.id === 'canned_soup') {
      this.hunger = Math.min(100, this.hunger + 40);
      this.warmth = Math.min(100, this.warmth + 15);
      this.consumeItem(item.id, 1);
      this.sfx.playPickup();
      this.showToast('Consumed hot ration! (+40 Hunger, +15 Warmth)');
    } else if (item.id === 'medkit') {
      this.health = Math.min(100, this.health + 40);
      this.consumeItem(item.id, 1);
      this.showToast('Bandaged wounds! (+40 Health)');
    } else if (item.id === 'kerosene') {
      this.torchFuel = 100;
      this.consumeItem(item.id, 1);
      this.showToast('Refueled Torch Flame to 100%!');
    }
    this.renderBackpackGrid();
    this.updateHUD();
  }

  addItem(newItem) {
    const existing = this.inventory.find(i => i.id === newItem.id);
    if (existing) {
      existing.count += newItem.count;
    } else if (this.inventory.length < 8) {
      this.inventory.push(newItem);
    } else {
      this.showToast('Backpack is full! Drop or use items.');
    }
    this.sfx.playPickup();
    this.updateHUD();
  }

  consumeItem(id, count = 1) {
    const item = this.inventory.find(i => i.id === id);
    if (item) {
      item.count -= count;
      if (item.count <= 0) {
        this.inventory = this.inventory.filter(i => i.id !== id);
      }
    }
  }

  craftTorch() {
    const wood = this.inventory.find(i => i.id === 'wood');
    const cloth = this.inventory.find(i => i.id === 'cloth');
    if (wood && wood.count >= 2 && cloth && cloth.count >= 1) {
      this.consumeItem('wood', 2);
      this.consumeItem('cloth', 1);
      this.torchFuel = 100;
      this.isTorchOn = true;
      this.torchLight.intensity = 2.5;
      this.flameMesh.visible = true;
      this.sfx.playTorchIgnite();
      this.showToast('Crafted brand new Torch with fuel!');
      this.renderBackpackGrid();
    } else {
      this.showToast('Need 2x Wood and 1x Cloth to craft Torch!');
    }
  }

  craftCampfire() {
    const wood = this.inventory.find(i => i.id === 'wood');
    if (wood && wood.count >= 3) {
      this.consumeItem('wood', 3);
      const campPos = this.player.position.clone().add(new THREE.Vector3(0, 0, -1.8));
      campPos.y = getTerrainHeight(campPos.x, campPos.z);

      const fireLight = new THREE.PointLight(0xff6600, 3.5, 14, 1.5);
      fireLight.position.set(campPos.x, campPos.y + 0.8, campPos.z);
      this.scene.add(fireLight);

      const logsGeom = new THREE.CylinderGeometry(0.12, 0.15, 1.2, 5);
      const logsMat = new THREE.MeshStandardMaterial({ color: 0x221307 });
      for (let i = 0; i < 3; i++) {
        const logMesh = new THREE.Mesh(logsGeom, logsMat);
        logMesh.position.set(campPos.x, campPos.y + 0.1, campPos.z);
        logMesh.rotation.y = (i * Math.PI) / 3;
        logMesh.rotation.z = Math.PI / 2;
        this.scene.add(logMesh);
      }

      const fireParticles = new FlameParticleSystem(this.scene, 28, 0.4, 1.4, 0.24);
      this.campfires.push({
        pos: campPos,
        light: fireLight,
        timeRemaining: 180,
        flameParticles: fireParticles
      });
      this.sfx.playTorchIgnite();
      this.showToast('Campfire built! Stand close for Warmth & Sleep.');
      const mFirstNight = this.missions.find(m => m.id === 'first_night');
      if (mFirstNight && !mFirstNight.completed) {
        this.completeMission('first_night');
      }
      this.renderBackpackGrid();
    } else {
      this.showToast('Need 3x Pine Wood to build a Campfire!');
    }
  }

  checkSleepNearFire() {
    let nearWarmth = false;
    this.campfires.forEach(fire => {
      if (this.player.position.distanceTo(fire.pos) < 7.5) nearWarmth = true;
    });
    if (this.player.position.distanceTo(new THREE.Vector3(-70, 18, -235)) < 15) nearWarmth = true;

    if (nearWarmth) {
      this.sleepAndRestore();
    } else {
      this.showToast('Too cold to sleep here! Build a Campfire or reach a Cabin.');
    }
  }

  sleepAndRestore() {
    this.energy = 100;
    this.warmth = 100;
    const hungerCost = 38;
    this.hunger = Math.max(0, this.hunger - hungerCost);
    this.timeOfDay = (this.timeOfDay + 6) % 24;
    if (this.timeOfDay < 6.0) this.dayCount += 1;
    this.showToast(`😴 Slept 6 hours! Warmth & Energy restored. -${hungerCost}% Hunger (Eat food to stave off starvation!).`);
    if (this.hunger <= 0) {
      this.health = Math.max(10, this.health - 20);
      this.triggerDamageFlash('rgba(239, 68, 68, 0.6)');
      this.showToast('⚠️ Starvation! Took health damage while sleeping without food in stomach.');
    }
    this.updateHUD();
  }

  performAttack() {
    this.sfx.playAttack();
    if (this.fpArms) {
      this.fpArms.triggerAttackSwing();
    }
    this.shadowWolves.forEach(wolf => {
      const dist = this.player.position.distanceTo(wolf.mesh.position);
      if (dist < 4.2) {
        wolf.hp -= 1;
        this.triggerDamageFlash('rgba(255, 160, 0, 0.3)');
        if (wolf.hp <= 0) {
          this.scene.remove(wolf.mesh);
          this.shadowWolves = this.shadowWolves.filter(w => w.id !== wolf.id);
          this.addItem({ id: 'wolf_meat', name: 'Raw Wolf Meat', icon: '🥩', count: 2 });
          this.showToast('Shadow Wolf banished! Dropped Raw Wolf Meat.');
        } else {
          const knockback = wolf.mesh.position.clone().sub(this.player.position).normalize().multiplyScalar(3);
          wolf.mesh.position.add(knockback);
          this.showToast('Hit the beast with flaming brand!');
        }
      }
    });
  }

  tryInteract() {
    const prompt = document.getElementById('interaction-prompt');
    if (!prompt.classList.contains('hidden') && this.nearestInteractable) {
      const cur = this.nearestInteractable;
      cur.onInteract();
      if (
        cur.id.startsWith('bush') ||
        cur.id.startsWith('log') ||
        cur.id === 'cabin_map' ||
        cur.id === 'suv_storage' ||
        cur.id === 'village_gear' ||
        cur.id === 'village_cable' ||
        cur.id === 'village_crank' ||
        cur.id === 'meadow_fuel' ||
        cur.id === 'lake_water' ||
        cur.id === 'mission_fuel' ||
        cur.id === 'mission_rockslide' ||
        cur.id.startsWith('pyre_')
      ) {
        this.interactables = this.interactables.filter(item => item.id !== cur.id);
      }
      this.nearestInteractable = null;
      prompt.classList.add('hidden');
    }
  }

  triggerVictory() {
    this.isVictory = true;
    this.beaconLight.intensity = 6;
    this.beaconLight.color.setHex(0x22c55e);
    this.sfx.playBeaconVictory();
    document.getElementById('victory-screen').classList.remove('hidden');
    document.exitPointerLock();
  }

  triggerGameOver(reason) {
    this.isDead = true;
    document.getElementById('death-reason').textContent = reason;
    document.getElementById('game-over-screen').classList.remove('hidden');
    document.exitPointerLock();
  }

  triggerScreenShake(intensity = 0.5) {
    this.screenShake = Math.min(1.2, Math.max(this.screenShake, intensity));
  }

  triggerDamageFlash(color = 'rgba(239, 68, 68, 0.4)', shakeIntensity = 0.45) {
    const flash = document.getElementById('damage-flash');
    if (flash) {
      flash.style.background = color;
      setTimeout(() => { if (flash) flash.style.background = 'rgba(239, 68, 68, 0)'; }, 180);
    }
    if (shakeIntensity > 0) {
      this.triggerScreenShake(shakeIntensity);
    }
  }

  teleportPlayer(x, y, z) {
    const pos = this.ensureWalkable(new THREE.Vector3(x, y, z));
    this.player.position.copy(pos);
    this.verticalVelocity = 0;
    this.fallStartY = pos.y;
    this.camera.position.set(pos.x, pos.y + 1.6, pos.z);
  }

  // Ensure position is walkable: not inside any collider, not on steep slope
  ensureWalkable(pos) {
    const maxGrade = 0.3;
    const minColliderDist = 3.0;

    const isInsideCollider = (px, pz) => {
      if (!this.colliders) return false;
      for (const col of this.colliders) {
        if (col.type === 'aabb') {
          const closestX = Math.max(col.minX, Math.min(col.maxX, px));
          const closestZ = Math.max(col.minZ, Math.min(col.maxZ, pz));
          const distX = px - closestX;
          const distZ = pz - closestZ;
          if (distX * distX + distZ * distZ < minColliderDist * minColliderDist) return true;
        } else if (col.type === 'sphere') {
          const cx = col.center.x;
          const cz = col.center.z !== undefined ? col.center.z : col.center.y;
          const dx = px - cx;
          const dz = pz - cz;
          const minDist = col.radius + minColliderDist;
          if (dx * dx + dz * dz < minDist * minDist) return true;
        }
      }
      return false;
    };

    const getGrade = (px, pz) => {
      const eps = 0.25;
      const hL = getTerrainHeight(px - eps, pz);
      const hR = getTerrainHeight(px + eps, pz);
      const hD = getTerrainHeight(px, pz - eps);
      const hU = getTerrainHeight(px, pz + eps);
      const dhdx = (hR - hL) / (2 * eps);
      const dhdz = (hU - hD) / (2 * eps);
      return Math.hypot(dhdx, dhdz);
    };

    const road = getRoadSignedDistance(pos.x, pos.z);
    const grade = getGrade(pos.x, pos.z);

    // If current position is flat road ground (|signedDist| < 2.0, grade < maxGrade) and not within 3m of any collider
    if (Math.abs(road.signedDist) < 2.0 && grade < maxGrade && !isInsideCollider(pos.x, pos.z)) {
      pos.y = getTerrainHeight(pos.x, pos.z) + 0.5;
      return pos;
    }

    // Push to nearest valid road point
    let bestDist = Infinity;
    let bestPt = null;
    for (let i = 0; i < ROAD_SAMPLES_COUNT; i += 2) {
      const s = ROAD_SAMPLES[i];
      const dSq = (pos.x - s.x) * (pos.x - s.x) + (pos.z - s.z) * (pos.z - s.z);
      if (dSq < bestDist) {
        const sGrade = getGrade(s.x, s.z);
        if (sGrade < maxGrade && !isInsideCollider(s.x, s.z)) {
          bestDist = dSq;
          bestPt = s;
        }
      }
    }

    if (bestPt) {
      return new THREE.Vector3(bestPt.x, getTerrainHeight(bestPt.x, bestPt.z) + 0.5, bestPt.z);
    }

    // Fallback: just snap to road projection
    pos.x = road.projX;
    pos.z = road.projZ;
    pos.y = getTerrainHeight(pos.x, pos.z) + 0.5;
    return pos;
  }

  // Toggle fullscreen (key G and top-right button)
  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  // Unstuck: teleport to last safe position (key U)
  unstuck() {
    if (this.lastSafePosition) {
      const sp = this.lastSafePosition;
      this.teleportPlayer(sp.x, sp.y, sp.z);
      this.showToast('Teleported to last safe position.');
    }
  }

  showToast(msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3500);
  }

  // ---------------------------------------------------------------------------
  // CINEMATIC CAMERAS: INTRO PAN & 60-SECOND SCRIPTED TRAILER MODE
  // ---------------------------------------------------------------------------
  startIntroCameraPan() {
    this.isIntroPanning = true;
    this.introPanStartTime = performance.now();
    this.introDuration = 4.5;
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
    this.updateCinematicOverlay(
      'EXPEDITION BRIEFING',
      'FROSTBOUND: THE LONG DESCENT',
      'Follow the winding mountain road north • Reach the Radio Tower summit before dusk'
    );
  }

  endIntroCameraPan() {
    if (!this.isIntroPanning) return;
    this.isIntroPanning = false;
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');
    this.cameraYaw = -0.64;
    this.cameraPitch = 0;
    this.container.requestPointerLock();
    this.showToast('Follow the mountain road north! Track active expedition missions in HUD.');
  }

  updateIntroPan(delta) {
    const elapsed = (performance.now() - this.introPanStartTime) / 1000;
    if (elapsed >= this.introDuration) {
      this.endIntroCameraPan();
      return;
    }

    const t = elapsed / this.introDuration;
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    const suv = (this.wreckedSUV && this.wreckedSUV.carGroup) ? this.wreckedSUV.carGroup : null;
    let pDriverSeat, lookDashboard, pOutDoor;
    if (suv) {
      pDriverSeat = suv.localToWorld(new THREE.Vector3(-0.48, 1.58, 0.08));
      lookDashboard = suv.localToWorld(new THREE.Vector3(-0.12, 1.38, -0.72));
      pOutDoor = suv.localToWorld(new THREE.Vector3(-2.4, 1.85, -0.1));
    } else {
      const carY = getTerrainHeight(-184, 518);
      pDriverSeat = new THREE.Vector3(-184.4, carY + 1.65, 518.2);
      lookDashboard = new THREE.Vector3(-184.0, carY + 1.45, 517.2);
      pOutDoor = new THREE.Vector3(-186.8, carY + 1.8, 517.8);
    }

    const pMid = new THREE.Vector3(-140, getTerrainHeight(-140, 430) + 18, 430);
    const pEnd = new THREE.Vector3(this.player.position.x, this.player.position.y + 1.6, this.player.position.z);

    const lookTower = new THREE.Vector3(0, 85, -550);
    const lookEnd = new THREE.Vector3(this.player.position.x - 12, this.player.position.y + 1.6, this.player.position.z - 18);

    const camPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    if (ease < 0.35) {
      // Driver seat view of dashboard & emergency radio, easing out towards open door
      const u = ease / 0.35;
      camPos.lerpVectors(pDriverSeat, pOutDoor, u);
      lookTarget.lerpVectors(lookDashboard, lookTower, u * 0.7);
    } else if (ease < 0.72) {
      // Sweeping out and up over the crash site towards the distant Radio Tower peak
      const u = (ease - 0.35) / 0.37;
      camPos.lerpVectors(pOutDoor, pMid, u);
      lookTarget.lerpVectors(lookDashboard.clone().lerp(lookTower, 0.7), lookTower, u);
    } else {
      // Descending smoothly into the player's first-person eyes ready to begin the descent
      const u = (ease - 0.72) / 0.28;
      camPos.lerpVectors(pMid, pEnd, u);
      lookTarget.lerpVectors(lookTower, lookEnd, u);
    }

    this.camera.position.copy(camPos);
    this.camera.lookAt(lookTarget);

    if (this.screenShake > 0.001) {
      this.camera.rotation.y += (Math.random() - 0.5) * this.screenShake * 0.08;
      this.camera.rotation.x += (Math.random() - 0.5) * this.screenShake * 0.08;
      this.screenShake = Math.max(0, this.screenShake - delta * 3.5);
    }
  }

  toggleTrailerMode() {
    if (this.isTrailerMode) {
      this.stopTrailerMode();
    } else {
      this.startTrailerMode();
    }
  }

  startTrailerMode() {
    this.isTrailerMode = true;
    this.trailerStartTime = performance.now();
    this.trailerDuration = 60.0;
    this.sfx.init();
    this.sfx.stopTitleAmbience();
    if (document.pointerLockElement) document.exitPointerLock();

    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('controls-modal').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  stopTrailerMode() {
    if (!this.isTrailerMode) return;
    this.isTrailerMode = false;
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');

    if (!this.isPlaying) {
      document.getElementById('main-menu').classList.remove('hidden');
      document.getElementById('hud').classList.add('hidden');
      this.sfx.startTitleAmbience();
    } else {
      this.cameraYaw = -0.64;
      this.cameraPitch = 0;
      this.container.requestPointerLock();
    }
  }

  updateCinematicOverlay(tag, title, desc) {
    const elTag = document.getElementById('cinematic-tag');
    const elTitle = document.getElementById('cinematic-title');
    const elDesc = document.getElementById('cinematic-desc');
    if (elTag && elTag.textContent !== tag) elTag.textContent = tag;
    if (elTitle && elTitle.textContent !== title) elTitle.textContent = title;
    if (elDesc && elDesc.textContent !== desc) elDesc.textContent = desc;
  }

  updateTrailer(delta) {
    const elapsed = (performance.now() - this.trailerStartTime) / 1000;
    if (elapsed >= this.trailerDuration) {
      this.stopTrailerMode();
      return;
    }

    const camPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    if (elapsed < 20.0) {
      // -------------------------------------------------------------
      // THEME I: DESOLATION & THE FROZEN WILD (0.0s - 20.0s)
      // -------------------------------------------------------------
      this.updateCinematicOverlay(
        'THEME I: DESOLATION & THE FROZEN WILD',
        'CRASH IN THE ALPINE SHADOWS',
        'Bitter sub-zero blizzards, dwindling campfire embers, and ancient wolves stalking the rocky canyon.'
      );

      if (elapsed < 7.0) {
        const u = elapsed / 7.0;
        const angle = -1.2 + u * 1.5;
        camPos.set(
          -180 + Math.cos(angle) * 16,
          24 + Math.sin(u * Math.PI) * 4,
          525 + Math.sin(angle) * 16
        );
        lookTarget.set(-180, 20.5, 525);
      } else if (elapsed < 14.0) {
        const u = (elapsed - 7.0) / 7.0;
        const p1 = new THREE.Vector3(-150, 25, 490);
        const p2 = new THREE.Vector3(-90, 23, 410);
        camPos.lerpVectors(p1, p2, u);
        lookTarget.set(-95 + Math.sin(u * 2) * 10, 21, 415);
      } else {
        const u = (elapsed - 14.0) / 6.0;
        const p1 = new THREE.Vector3(-75, 26, 425);
        const p2 = new THREE.Vector3(-30, 32, 405);
        camPos.lerpVectors(p1, p2, u);
        lookTarget.set(-40, 26, 418);
      }
    } else if (elapsed < 40.0) {
      // -------------------------------------------------------------
      // THEME II: A LIVING, BREATHING ECOSYSTEM (20.0s - 40.0s)
      // -------------------------------------------------------------
      const t = elapsed - 20.0;
      this.updateCinematicOverlay(
        'THEME II: A LIVING, BREATHING ECOSYSTEM',
        'WILDLIFE, FLOCKS & GLACIAL RIVERS',
        'Dynamic deer herds in sunlit clearings, soaring bird flocks, and schooling fish in glacial waters.'
      );

      if (t < 7.0) {
        const u = t / 7.0;
        const angle = 0.5 + u * 1.8;
        camPos.set(
          95 + Math.cos(angle) * 18,
          26 + Math.sin(u * Math.PI) * 3,
          230 + Math.sin(angle) * 18
        );
        lookTarget.set(95, 23.5, 230);
      } else if (t < 14.0) {
        const u = (t - 7.0) / 7.0;
        const p1 = new THREE.Vector3(-15, 20, 130);
        const p2 = new THREE.Vector3(-32, 18, 55);
        camPos.lerpVectors(p1, p2, u);
        lookTarget.set(-25, 14, 90 - u * 35);
      } else {
        const u = (t - 14.0) / 6.0;
        const p1 = new THREE.Vector3(-45, 24, 45);
        const p2 = new THREE.Vector3(-12, 22, 10);
        camPos.lerpVectors(p1, p2, u);
        lookTarget.set(-25, 16.5, 20);
      }
    } else {
      // -------------------------------------------------------------
      // THEME III: MACHINES OF HOPE & THE FINAL ASCENT (40.0s - 60.0s)
      // -------------------------------------------------------------
      const t = elapsed - 40.0;
      this.updateCinematicOverlay(
        'THEME III: MACHINES OF HOPE & THE FINAL ASCENT',
        'REPAIR THE RELAYS • IGNITE THE BEACON',
        'Roaring camp generator, sheer Khai cliff face with wind turbine, and the Radio Tower summit SOS beacon.'
      );

      if (t < 7.0) {
        const u = t / 7.0;
        const angle = -0.8 + u * 2.0;
        camPos.set(
          -70 + Math.cos(angle) * 16,
          27 + Math.sin(u * Math.PI) * 2.5,
          -235 + Math.sin(angle) * 16
        );
        lookTarget.set(-70, 24, -235);
      } else if (t < 13.0) {
        const u = (t - 7.0) / 6.0;
        const p1 = new THREE.Vector3(10, 42, -380);
        const p2 = new THREE.Vector3(35, 54, -435);
        camPos.lerpVectors(p1, p2, u);
        lookTarget.set(25, 46, -420);
      } else {
        const u = (t - 13.0) / 7.0;
        const angle = u * Math.PI * 1.6;
        camPos.set(
          Math.cos(angle) * 22,
          86 + u * 6,
          -550 + Math.sin(angle) * 22
        );
        lookTarget.set(0, 85, -550);
      }
    }

    this.camera.position.copy(camPos);
    this.camera.lookAt(lookTarget);

    this.sfx.updateAmbient(camPos, camPos.y, this.timeOfDay);
  }

  // ---------------------------------------------------------------------------
  // MAIN LOOP
  // ---------------------------------------------------------------------------
  updateSimulation(delta) {
    if ((!this.isPlaying && !this.isTrailerMode) || this.isDead || this.isVictory) return;

    // Time cycle
    this.timeOfDay = (this.timeOfDay + delta * this.timeSpeed) % 24;
    this.updateSkyByTimeOfDay();
    const isNight = this.timeOfDay < 6 || this.timeOfDay > 18;

    // Sun / Moon trajectory centered around player
    // Sun trajectory centered around player, framed majestically ahead over the mountain vista
    const sunAngle = ((this.timeOfDay - 6) / 12) * Math.PI;
    const sunDist = 380;
    const sunElevation = Math.max(32, Math.sin(sunAngle) * 95);
    this.sunLight.position.set(
      this.player.position.x + 110,
      this.player.position.y + sunElevation,
      this.player.position.z - 280
    );
    this.sunLight.target.position.copy(this.player.position);
    this.sunLight.target.updateMatrixWorld();

    if (this.sunGroup) {
      this.sunGroup.position.copy(this.sunLight.position);
      if (this.sunCoronaSprite) {
        this.sunCoronaSprite.lookAt(this.camera.position);
        this.sunCoronaSprite.rotation.z += delta * 0.03;
      }
    } else if (this.sunOrb) {
      this.sunOrb.position.copy(this.sunLight.position);
    }

    if (this.skyMesh) {
      this.skyMesh.position.copy(this.player.position);
    }

    // Dynamic Sky Colors
    // 5-Zone Atmospheric Fog Tint & Density Transitions
    const pz = this.player.position.z;
    const fogColorZ1 = new THREE.Color(0x7e8f9e); // Zone 1: Slate Crash Site
    const fogColorZ2 = new THREE.Color(0x668677); // Zone 2: Misty Evergreen Pine Forest
    const fogColorZ3 = new THREE.Color(0x6e98b3); // Zone 3: Crisp Glacial Lake & River
    const fogColorZ4 = new THREE.Color(0x8c8072); // Zone 4: Smoky Timber Hunter Camp
    const fogColorZ5 = new THREE.Color(0x949cba); // Zone 5: Stark Alpine Khai Ridge & Peak

    let targetFogColor = new THREE.Color();
    let targetFogDensity = 0.0033;

    if (pz > 350) {
      targetFogColor.copy(fogColorZ1);
      targetFogDensity = 0.0033;
    } else if (pz > 100) {
      const t = (350 - pz) / 250;
      targetFogColor.lerpColors(fogColorZ1, fogColorZ2, t);
      targetFogDensity = 0.0033 * (1 - t) + 0.0038 * t;
    } else if (pz > -120) {
      const t = (100 - pz) / 220;
      targetFogColor.lerpColors(fogColorZ2, fogColorZ3, t);
      targetFogDensity = 0.0038 * (1 - t) + 0.0028 * t;
    } else if (pz > -380) {
      const t = (-120 - pz) / 260;
      targetFogColor.lerpColors(fogColorZ3, fogColorZ4, t);
      targetFogDensity = 0.0028 * (1 - t) + 0.0033 * t;
    } else {
      const t = Math.min(1.0, (-380 - pz) / 180);
      targetFogColor.lerpColors(fogColorZ4, fogColorZ5, t);
      targetFogDensity = 0.0033 * (1 - t) + 0.0026 * t;
    }

    // Soft Sunset Color Grading (peaks around 17:30)
    const isSunset = (this.timeOfDay >= 16.0 && this.timeOfDay <= 19.5);
    const isSunrise = (this.timeOfDay >= 5.0 && this.timeOfDay <= 8.0);
    let sunsetBlend = 0;
    if (isSunset) {
      sunsetBlend = Math.sin(((this.timeOfDay - 16.0) / 3.5) * Math.PI);
    } else if (isSunrise) {
      sunsetBlend = Math.sin(((this.timeOfDay - 5.0) / 3.0) * Math.PI);
    }

    if (isNight) {
      const nightFog = new THREE.Color(0x0a121e);
      this.scene.background.setHex(0x0a121e);
      this.scene.fog.color.copy(nightFog);
      this.skyMesh.material.color.setHex(0x08101a);
      this.sunOrb.material.color.setHex(0xd0e8ff); // Moon glow
      if (this.sunCoronaSprite) this.sunCoronaSprite.visible = false;
      this.ambientLight.intensity = 0.25;
      if (this.hemiLight) this.hemiLight.intensity = 0.15;
      this.sunLight.intensity = 0.15;
      this.scene.fog.density = targetFogDensity * 1.25;
    } else {
      const dayFactor = Math.sin(sunAngle);
      if (this.sunCoronaSprite) this.sunCoronaSprite.visible = true;

      if (sunsetBlend > 0.02) {
        // Soft sunset color grading: warm dusty mauve/peach fog and golden amber lighting
        const sunsetFog = new THREE.Color(0x6e5262); // Soft sunset mauve
        const sunsetSky = new THREE.Color(0x7c5a6d); // Warm twilight sky
        const finalFog = targetFogColor.clone().lerp(sunsetFog, sunsetBlend * 0.82);
        this.scene.background.copy(finalFog);
        this.scene.fog.color.copy(finalFog);
        this.scene.fog.density = targetFogDensity * (1.0 - sunsetBlend * 0.08);
        this.skyMesh.material.color.copy(sunsetSky);

        this.sunOrb.material.color.setHex(0xfffaea);
        this.sunLight.color.setHex(0xffa153); // Warm golden sunset directional light
        this.ambientLight.color.setHex(0x5c546c); // Twilight fill light
        this.ambientLight.intensity = 0.65;
        this.sunLight.intensity = Math.max(0.6, dayFactor * 1.85);
      } else {
        this.scene.background.copy(targetFogColor);
        this.scene.fog.color.copy(targetFogColor);
        this.scene.fog.density = targetFogDensity;
        this.skyMesh.material.color.copy(targetFogColor).offsetHSL(0.02, 0.05, 0.05);
        this.sunOrb.material.color.setHex(0xfffae0);
        this.sunLight.color.setHex(0xfff5e0);
        this.ambientLight.color.setHex(0x7590b0);
        this.ambientLight.intensity = 0.72;
        this.sunLight.intensity = Math.max(0.4, dayFactor * 1.6);
      }
    }

    // Hunter Camp Windmill Rotation
    if (this.windmillBlades) {
      this.windmillBlades.rotation.z += delta * 0.75;
    }

    // Visible Clock & Active Chapter Dusk Deadline
    const hours = Math.floor(this.timeOfDay);
    const mins = Math.floor((this.timeOfDay % 1) * 60);
    const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    const timeElem = document.getElementById('time-display');
    if (timeElem) timeElem.textContent = timeStr;
    const clockIcon = document.getElementById('clock-icon');
    if (clockIcon) clockIcon.textContent = isNight ? '🌙' : '☀️';

    // Current Chapter Dusk Deadline Alert
    const activeMission = this.missions.find(m => !m.completed);
    const deadlineBadge = document.getElementById('dusk-deadline-badge');
    if (deadlineBadge) {
      if (!activeMission) {
        deadlineBadge.textContent = '🌟 ALL MISSIONS DONE';
        deadlineBadge.className = 'dusk-badge ready';
      } else {
        const dHour = Math.floor(activeMission.duskDeadline);
        const dMin = Math.floor((activeMission.duskDeadline % 1) * 60);
        const deadlineStr = `${dHour.toString().padStart(2, '0')}:${dMin.toString().padStart(2, '0')}`;
        const timeDiff = activeMission.duskDeadline - this.timeOfDay;

        if (timeDiff > 0) {
          const remHours = Math.floor(timeDiff);
          const remMins = Math.floor((timeDiff % 1) * 60);
          deadlineBadge.textContent = `⏳ ${activeMission.chapter} DUSK: ${deadlineStr} (${remHours > 0 ? remHours + 'h ' : ''}${remMins}m left)`;
          deadlineBadge.className = 'dusk-badge';
        } else {
          deadlineBadge.textContent = `⚠️ DUSK PASSED: NIGHTFALL - BEASTS ACTIVE!`;
          deadlineBadge.className = 'dusk-badge urgent';
        }
      }
    }

    const timeSec = performance.now() * 0.001;

    // Torch Real Flame Particles & Multi-Harmonic Flicker Light
    if (this.isTorchOn && this.torchFuel > 0) {
      this.torchFuel = Math.max(0, this.torchFuel - delta * 0.35);

      // Multi-harmonic realistic flame flicker
      const tf = Math.sin(timeSec * 24) * 0.35 + Math.sin(timeSec * 41) * 0.2 + Math.sin(timeSec * 13) * 0.25;
      this.torchLight.intensity = Math.max(1.5, 2.8 + tf);

      if (this.flameMesh) {
        this.flameMesh.visible = true;
        this.flameMesh.scale.set(
          1 + Math.sin(timeSec * 22) * 0.18,
          1 + Math.sin(timeSec * 35) * 0.28,
          1 + Math.sin(timeSec * 18) * 0.18
        );
      }

      if (this.torchFlameParticles) {
        const flameWorldPos = new THREE.Vector3();
        this.flameMesh.getWorldPosition(flameWorldPos);
        this.torchFlameParticles.update(delta, flameWorldPos, true);
      }

      if (this.torchFuel <= 0) this.toggleTorch();
    } else {
      this.torchLight.intensity = 0;
      if (this.flameMesh) this.flameMesh.visible = false;
      if (this.torchFlameParticles) {
        this.torchFlameParticles.update(delta, this.player.position, false);
      }
    }

    // Campfires Safe Zones: Real Flame Particles & Flicker Light
    let isNearFire = false;
    this.campfires.forEach((c, idx) => {
      const dist = this.player.position.distanceTo(c.pos);
      if (dist < 7.5) isNearFire = true;

      // Real flame & ember particles
      if (c.flameParticles) {
        c.flameParticles.update(delta, c.pos, true);
      }

      // Multi-harmonic light flicker
      if (c.light) {
        const cf = Math.sin(timeSec * 18 + idx * 4) * 0.45 + Math.sin(timeSec * 31 + idx * 3) * 0.25;
        c.light.intensity = Math.max(2.2, 4.0 + cf);
      }
    });

    // COLD DRAIN & SAFE ZONES
    // Day is survivable (0.25/s); Night is deadly without fire (4.5/s)
    let baseColdDrain = isNight ? 4.5 : 0.25;
    if (this.weather === 'blizzard') baseColdDrain *= 1.8;

    if (isNearFire) {
      // Safe Zone: Campfire rapidly restores warmth
      this.warmth = Math.min(100, this.warmth + delta * 6.5);
    } else if (this.isTorchOn && this.torchFuel > 0) {
      // Safe Zone: Torch protects completely against the deadly night freeze
      this.warmth = Math.max(0, this.warmth - delta * (isNight ? 0.12 : 0.04));
    } else {
      // Outside safe zones: rapid freezing at night, mild drain during day
      this.warmth = Math.max(0, this.warmth - delta * baseColdDrain);
    }

    const frostOverlay = document.getElementById('frost-overlay');
    frostOverlay.style.boxShadow = `inset 0 0 ${Math.max(0, (100 - this.warmth) * 1.6)}px rgba(56, 189, 248, ${Math.max(0, (100 - this.warmth) / 110)})`;

    this.hunger = Math.max(0, this.hunger - delta * 0.3);

    if (this.warmth <= 0 || this.hunger <= 0) {
      this.health = Math.max(0, this.health - delta * 2.5);
      if (Math.random() < 0.05) this.triggerDamageFlash('rgba(56, 189, 248, 0.45)', 0.35);
    }

    if (this.health <= 0) {
      this.triggerGameOver('Hypothermia and starvation overcame your body in the snow.');
    }

    // Handle SUV Intro First-Person Cutscene
    if (this.isSUVIntro) {
      this.updateSUVIntroCutscene(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      this.updateHUD();
      this.sfx.updateAmbient(this.camera.position, this.camera.position.y, this.timeOfDay);
      return;
    }

    // Handle Helicopter Rescue Ending Cutscene
    if (this.isHelicopterRescue) {
      this.updateHelicopterRescue(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      this.updateHUD();
      return;
    }

    // Handle Cinematic Intro Pan
    if (this.isIntroPanning) {
      this.updateIntroPan(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      this.updateHUD();
      this.sfx.updateAmbient(this.camera.position, this.camera.position.y, this.timeOfDay);
      return;
    }

    // Handle 60s Scripted Trailer Mode
    if (this.isTrailerMode) {
      this.updateTrailer(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      if (this.deerHerd) this.deerHerd.update(delta, this.camera.position, false);
      if (this.rabbitColony) this.rabbitColony.update(delta, this.camera.position);
      if (this.birdFlocks) this.birdFlocks.update(delta, this.camera.position, false);
      if (this.fishSchool) this.fishSchool.update(delta, this.camera.position);
      return;
    }

    this.handleMovement(delta);
    this.checkRopeBridgeCrossing();
    this.updateWolves(delta);
    this.checkInteractions();
    this.updateSnow(delta);
    this.updateMinimap();
    this.updateHUD();

    // Living Wildlife State Machines (Deer, Rabbits, Birds, Fish)
    const isSprinting = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && this.energy > 10;
    if (this.deerHerd) this.deerHerd.update(delta, this.player.position, isSprinting);
    if (this.rabbitColony) this.rabbitColony.update(delta, this.player.position);
    if (this.birdFlocks) this.birdFlocks.update(delta, this.player.position, isSprinting);
    if (this.fishSchool) this.fishSchool.update(delta, this.player.position);

    // Animated Flowing Water Waves
    if (this.waterMat && this.waterMat.userData && this.waterMat.userData.customUniforms) {
      this.waterMat.userData.customUniforms.uTime.value += delta;
    }

    // Grass & Wildflower Wind Sway
    if (this.grassUniforms && this.grassUniforms.uTime) {
      this.grassUniforms.uTime.value += delta;
    }

    // Working Animated Machines (Water Wheel, Wind Turbine, Generator, Crane)
    this.updateMachines(delta);

    // Update Wrecked SUV steam particles & spinning wheels
    if (this.wreckedSUV) {
      this.wreckedSUV.update(delta, 0);
    }

    // Dynamic Procedural Ambient Audio (Wind by altitude, creek, day birds, night wolves/owls)
    this.sfx.updateAmbient(this.player.position, this.player.position.y, this.timeOfDay);
  }

  // ---------------------------------------------------------------------------
  // CHARACTER CONTROLLER: GRAVITY, JUMP, SLOPE SLIDING, FALL DAMAGE & SCREEN SHAKE
  // ---------------------------------------------------------------------------
  handleMovement(delta) {
    if (this.isBackpackOpen) return;

    const px = this.player.position.x;
    const pz = this.player.position.z;
    const playerBaseOffset = 0.5;

    // 1. TERRAIN SLOPE & CLIFF DETECTION (via central differences)
    const eps = 0.25;
    const hL = getTerrainHeight(px - eps, pz);
    const hR = getTerrainHeight(px + eps, pz);
    const hD = getTerrainHeight(px, pz - eps);
    const hU = getTerrainHeight(px, pz + eps);
    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);

    const grade = Math.hypot(dhdx, dhdz);
    const maxClimbAngle = (40 * Math.PI) / 180; // ~40 deg limit
    const maxGrade = Math.tan(maxClimbAngle);   // ~0.839

    const downhillLen = Math.hypot(dhdx, dhdz) || 1;
    const downhillDirX = -dhdx / downhillLen;
    const downhillDirZ = -dhdz / downhillLen;

    const isTooSteep = grade > maxGrade;

    // 2. HORIZONTAL MOVEMENT INPUT
    const isSprinting = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && this.energy > 10;
    const moveSpeed = isSprinting ? 9.0 : 4.8;
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.cameraYaw);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.cameraYaw);

    const inputDir = new THREE.Vector3();
    if (this.keys['KeyW']) inputDir.add(forward);
    if (this.keys['KeyS']) inputDir.sub(forward);
    if (this.keys['KeyD']) inputDir.add(right);
    if (this.keys['KeyA']) inputDir.sub(right);

    // 2.5 WATER INTERACTION (Lake & River Mechanics)
    const lakeDist = Math.hypot(px - (-35), pz - 40);
    const inLake = lakeDist < 65;
    const inRiver = (px > -42 && px < 16 && pz > -20 && pz < 45 && this.player.position.y <= 5.4);
    const inWater = (inLake && this.player.position.y <= 5.35) || inRiver;

    let waterSpeedMult = 1.0;
    if (inWater) {
      const isDeep = inLake && lakeDist < 46;
      if (isDeep) {
        // Deep part: heavily slows player and rapidly drains warmth
        waterSpeedMult = 0.42;
        this.warmth = Math.max(0, this.warmth - delta * 4.2);
        if (inputDir.lengthSq() > 0) {
          if (!this.lastWaterSplash || Date.now() - this.lastWaterSplash > 550) {
            this.sfx.playWaterSplash();
            this.lastWaterSplash = Date.now();
          }
        }
      } else {
        // Shallow part: crossable with moderate resistance
        waterSpeedMult = 0.82;
        this.warmth = Math.max(0, this.warmth - delta * 1.2);
        if (inputDir.lengthSq() > 0) {
          if (!this.lastWaterSplash || Date.now() - this.lastWaterSplash > 450) {
            this.sfx.playWaterSplash();
            this.lastWaterSplash = Date.now();
          }
        }
      }
    }

    let moveX = 0;
    let moveZ = 0;

    if (inputDir.lengthSq() > 0) {
      inputDir.normalize();

      // CLIFF FACES NOT CLIMBABLE:
      // If slope > 40deg, prevent moving uphill against steep slopes!
      if (isTooSteep) {
        const uphillDot = (inputDir.x * dhdx + inputDir.z * dhdz) / downhillLen;
        if (uphillDot > 0) {
          inputDir.x -= (dhdx / downhillLen) * uphillDot;
          inputDir.z -= (dhdz / downhillLen) * uphillDot;
          if (inputDir.lengthSq() > 0) inputDir.normalize();
        }
      }

      moveX = inputDir.x * moveSpeed * waterSpeedMult;
      moveZ = inputDir.z * moveSpeed * waterSpeedMult;

      if (!this.lastFootstep || Date.now() - this.lastFootstep > (isSprinting ? 320 : 500)) {
        if (this.isGrounded && !this.isSliding && !inWater) {
          this.sfx.playFootstep();
          this.lastFootstep = Date.now();
        }
      }

      if (isSprinting && this.isGrounded) {
        this.energy = Math.max(0, this.energy - delta * 4);
      }
    } else {
      if (this.isGrounded) {
        this.energy = Math.min(100, this.energy + delta * 2.5);
      }
    }

    // 3. SLOPE SLIDING: If slope > 40deg, slide down in downhill direction!
    if (isTooSteep && this.isGrounded) {
      this.isSliding = true;
      const slideSpeed = 8.0 + (grade - maxGrade) * 6.5;
      moveX += downhillDirX * slideSpeed;
      moveZ += downhillDirZ * slideSpeed;
    } else {
      this.isSliding = false;
    }

    // 4. JUMP (Space)
    if (this.isGrounded && !this.isSliding && this.keys['Space']) {
      this.verticalVelocity = 8.4; // Jump impulse (~1.6m high)
      this.isGrounded = false;
      this.wasInAir = true;
      this.fallStartY = this.player.position.y;
      this.sfx.playJump();
    }

    // 5. SOLID COLLISION CHECK — resolve X and Z independently for wall sliding
    // 5. SOLID COLLISION CHECK — resolve X and Z separately so the player slides along walls
    const playerRadius = 0.55;

    const checkCollision = (testX, testZ) => {
      if (!this.colliders) return false;
      for (let i = 0; i < this.colliders.length; i++) {
        const col = this.colliders[i];
        if (col.type === 'aabb') {
          const closestX = Math.max(col.minX, Math.min(col.maxX, testX));
          const closestZ = Math.max(col.minZ, Math.min(col.maxZ, testZ));
          const distX = testX - closestX;
          const distZ = testZ - closestZ;
          if (distX * distX + distZ * distZ < playerRadius * playerRadius) return true;
        } else if (col.type === 'sphere') {
          const cx = col.center.x;
          const cz = col.center.z !== undefined ? col.center.z : col.center.y;
          const distX = testX - cx;
          const distZ = testZ - cz;
          const minDist = col.radius + playerRadius;
          if (distX * distX + distZ * distZ < minDist * minDist) return true;
        }
      }
      return false;
    };

    let nextPosX = px;
    let nextPosZ = pz;
    if (moveX !== 0 && !checkCollision(px + moveX * delta, pz)) {
      nextPosX = px + moveX * delta;
    }
    if (moveZ !== 0 && !checkCollision(nextPosX, pz + moveZ * delta)) {
      nextPosZ = pz + moveZ * delta;
    } else if (moveZ !== 0 && !checkCollision(px, pz + moveZ * delta)) {
      nextPosZ = pz + moveZ * delta;
    }

    this.player.position.x = nextPosX;
    this.player.position.z = nextPosZ;

    // Track last safe position (on flat road ground, updated every ~1s)
    this.lastSafePositionTimer = (this.lastSafePositionTimer || 0) + delta;
    if (this.lastSafePositionTimer > 1.0 && this.isGrounded && !this.isSliding && grade < 0.5) {
      const road = getRoadSignedDistance(this.player.position.x, this.player.position.z);
      if (Math.abs(road.signedDist) < 3.0) {
        this.lastSafePosition = this.player.position.clone();
        this.lastSafePositionTimer = 0;
      }
    }

    // 6. VERTICAL PHYSICS & GRAVITY
    const gravity = 22.0;
    this.verticalVelocity -= gravity * delta;
    const nextPosY = this.player.position.y + this.verticalVelocity * delta;

    // Grounded check via getTerrainHeight
    const currentGroundY = getTerrainHeight(this.player.position.x, this.player.position.z) + playerBaseOffset;

    if (nextPosY <= currentGroundY) {
      // LANDING ON GROUND
      if (this.wasInAir) {
        const fallDistance = this.fallStartY - nextPosY;
        // fall damage = (fallDistance - 4) * 6 clamped
        if (fallDistance > 4.0) {
          const damage = Math.min(100, Math.max(0, (fallDistance - 4.0) * 6.0));
          this.health = Math.max(0, this.health - damage);
          this.triggerDamageFlash('rgba(239, 68, 68, 0.65)');
          this.triggerScreenShake(Math.min(1.0, 0.3 + (fallDistance - 4.0) * 0.08));
          this.sfx.playHardLanding();
          if (damage > 10) {
            this.showToast(`Hard landing! -${Math.round(damage)} Health`);
          }
          if (this.health <= 0) {
            this.triggerGameOver('Fell from the icy cliffs and perished on the rocks.');
          }
        } else if (fallDistance > 1.4) {
          this.sfx.playFootstep();
        }
        this.wasInAir = false;
      }

      this.player.position.y = currentGroundY;
      this.verticalVelocity = 0;
      this.isGrounded = true;
    } else {
      // IN THE AIR (Falling or Jumping)
      if (!this.wasInAir) {
        this.wasInAir = true;
        this.fallStartY = this.player.position.y;
      } else {
        // Track the highest peak apex of the trajectory
        if (this.player.position.y > this.fallStartY) {
          this.fallStartY = this.player.position.y;
        }
      }
      this.player.position.y = nextPosY;
      this.isGrounded = false;
    }

    // 7. CAMERA POSITIONING & SCREEN SHAKE (First-Person vs Third-Person Mode)
    let shakePitch = 0;
    let shakeYaw = 0;
    let shakeRoll = 0;
    if (this.screenShake > 0.001) {
      shakePitch = (Math.random() - 0.5) * this.screenShake * 0.12;
      shakeYaw = (Math.random() - 0.5) * this.screenShake * 0.12;
      shakeRoll = (Math.random() - 0.5) * this.screenShake * 0.06;
      this.screenShake = Math.max(0, this.screenShake - delta * 3.5);
    }

    const isFirstPerson = (this.cameraMode === 'first');
    const isMoving = inputDir.lengthSq() > 0.01;
    const isTorchLit = this.isTorchOn && this.torchFuel > 0;

    // Sprint FOV Kick: Base FOV 75 in 1st person, kicks smoothly to 83 when sprinting
    const targetFOV = (isFirstPerson && isSprinting && isMoving) ? 83 : 75;
    if (Math.abs(this.camera.fov - targetFOV) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, Math.min(1.0, delta * 9.0));
      this.camera.updateProjectionMatrix();
    }

    if (isFirstPerson) {
      // 1. FIRST PERSON MODE
      this.camera.position.copy(this.player.position);
      this.camera.position.y += 1.6; // Eye level

      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.cameraYaw + shakeYaw;
      this.camera.rotation.x = this.cameraPitch + shakePitch;
      this.camera.rotation.z = shakeRoll;

      // First-person arms visible with idle sway, walking bob, sprint tilt, and item lighting
      if (this.fpArms) {
        this.fpArms.root.visible = true;
        this.fpArms.update(delta, isMoving, isSprinting, isTorchLit);
      }

      // Hide head in first-person so nothing clips into the camera
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.setFirstPerson(true);
        this.thirdPersonPlayer.update(
          delta,
          this.player.position,
          isMoving ? moveSpeed : 0,
          this.isGrounded,
          isSprinting,
          inputDir,
          isTorchLit,
          this.cameraYaw
        );
      }
    } else {
      // 2. THIRD PERSON MODE (Shoulder Camera behind & above right shoulder)
      // Hide 1st person arms
      if (this.fpArms) {
        this.fpArms.root.visible = false;
      }

      // Full player body visible with walk/run/idle/jump animations facing movement direction
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.setFirstPerson(false);
        this.thirdPersonPlayer.update(
          delta,
          this.player.position,
          isMoving ? moveSpeed : 0,
          this.isGrounded,
          isSprinting,
          inputDir,
          isTorchLit,
          this.cameraYaw
        );
      }

      const headPos = new THREE.Vector3(
        this.player.position.x,
        this.player.position.y + 1.6,
        this.player.position.z
      );

      const cosPitch = Math.cos(this.cameraPitch);
      const sinPitch = Math.sin(this.cameraPitch);
      const sinYaw = Math.sin(this.cameraYaw);
      const cosYaw = Math.cos(this.cameraYaw);

      // Look direction from yaw and pitch
      const lookDir = new THREE.Vector3(
        -sinYaw * cosPitch,
        sinPitch,
        -cosYaw * cosPitch
      ).normalize();

      // Right shoulder direction
      const rightDir = new THREE.Vector3(cosYaw, 0, -sinYaw).normalize();
      const upDir = new THREE.Vector3(0, 1, 0);

      // Base third-person distance ~3.5
      let targetDist = 3.5;
      const shoulderOffset = 0.62;
      const heightOffset = 0.38;

      // Camera collision check with terrain & trees (analytic sampling without heavy raycasts or physics engine)
      const idealBackVector = lookDir.clone().multiplyScalar(-targetDist)
        .addScaledVector(rightDir, shoulderOffset)
        .addScaledVector(upDir, heightOffset);

      const checkSteps = 6;
      for (let s = 1; s <= checkSteps; s++) {
        const frac = s / checkSteps;
        const testPos = headPos.clone().addScaledVector(idealBackVector, frac);
        const terrainY = getTerrainHeight(testPos.x, testPos.z) + 0.45;
        if (testPos.y < terrainY) {
          // Pull camera closer so it never clips terrain
          targetDist = Math.min(targetDist, Math.max(0.75, targetDist * (frac - 0.08)));
          break;
        }
      }

      // Check nearby obstacle/tree colliders so camera doesn't clip through trees
      if (this.colliders) {
        const testPos = headPos.clone().addScaledVector(idealBackVector, targetDist / 3.5);
        for (let i = 0; i < this.colliders.length; i++) {
          const col = this.colliders[i];
          if (col.type === 'sphere') {
            const dx = testPos.x - col.center.x;
            const dz = testPos.z - col.center.y;
            const distSq = dx * dx + dz * dz;
            const minR = col.radius + 0.5;
            if (distSq < minR * minR) {
              targetDist = Math.max(0.85, targetDist * 0.65);
              break;
            }
          }
        }
      }

      // Calculate final target position with adjusted distance
      const adjustedShoulder = shoulderOffset * Math.min(1.0, targetDist / 2.5);
      const adjustedHeight = heightOffset * Math.min(1.0, targetDist / 2.5);
      const targetCamPos = headPos.clone()
        .addScaledVector(rightDir, adjustedShoulder)
        .addScaledVector(upDir, adjustedHeight)
        .addScaledVector(lookDir, -targetDist);

      // Clamp camera elevation above terrain
      const groundMin = getTerrainHeight(targetCamPos.x, targetCamPos.z) + 0.55;
      if (targetCamPos.y < groundMin) {
        targetCamPos.y = groundMin;
      }

      // Spring-smoothed camera movement
      if (!this.thirdPersonCamPosInitialized) {
        this.thirdPersonCamPos.copy(targetCamPos);
        this.thirdPersonCamPosInitialized = true;
      } else {
        const springFactor = Math.min(1.0, delta * 15.0);
        this.thirdPersonCamPos.lerp(targetCamPos, springFactor);
      }

      this.camera.position.copy(this.thirdPersonCamPos);

      // Camera looks ahead in the lookDir direction from the shoulder focal point
      const lookFocus = headPos.clone().addScaledVector(rightDir, adjustedShoulder * 0.4);
      const aimTarget = lookFocus.clone().addScaledVector(lookDir, 25.0);
      this.camera.lookAt(aimTarget);

      // Apply screen shake
      if (this.screenShake > 0.001) {
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y += shakeYaw;
        this.camera.rotation.x += shakePitch;
        this.camera.rotation.z += shakeRoll;
      }
    }
  }

  updateWolves(delta) {
    const playerPos = this.player.position;

    // Check light zones: Torch light radius (~17.5m) and Campfire radius (~12m)
    const isPlayerNearCampfire = this.campfires.some(c => playerPos.distanceTo(c.pos) < 12.0);
    const playerHasTorch = this.isTorchOn && this.torchFuel > 0;

    this.shadowWolves.forEach(wolf => {
      const wolfPos = wolf.mesh.position;
      const distToPlayer = wolfPos.distanceTo(playerPos);
      const isWolfNearCampfire = this.campfires.some(c => wolfPos.distanceTo(c.pos) < 12.0);
      const inTorchLight = playerHasTorch && (distToPlayer < 17.5);
      const isSafeInLight = inTorchLight || isPlayerNearCampfire || isWolfNearCampfire;

      // 1. LIGHT RADIUS CHECK:
      // "shadow creatures only move when player's torch/fire is off or outside light radius"
      if (isSafeInLight) {
        // Wolf is repelled by light! Face player nervously
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);

        if (distToPlayer < 16.5) {
          // Recoil/retreat backwards away from the light to shadow perimeter
          const retreatDir = new THREE.Vector3().subVectors(wolfPos, playerPos).normalize();
          wolfPos.x += retreatDir.x * delta * 5.5;
          wolfPos.z += retreatDir.z * delta * 5.5;
        }
        // At shadow boundary, wolf is frozen in shadow, stalking harmlessly
        wolf.mesh.position.y = getTerrainHeight(wolfPos.x, wolfPos.z) + 0.4;
        return;
      }

      // 2. IN DARKNESS (Torch is OFF / fuel empty / outside light radius):
      // Wolves awaken and hunt! Actual speed ~4.0 units/sec, terrain-grounded, circle then attack!
      if (distToPlayer > 55.0) {
        // Outside engagement range, slowly stalk closer
        const approachDir = new THREE.Vector3().subVectors(playerPos, wolfPos).normalize();
        wolfPos.x += approachDir.x * delta * 2.8;
        wolfPos.z += approachDir.z * delta * 2.8;
        wolf.mesh.position.y = getTerrainHeight(wolfPos.x, wolfPos.z) + 0.4;
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);
        return;
      }

      // STATE MACHINE: CIRCLE THEN ATTACK
      if (wolf.state === 'circle') {
        wolf.circleTimer -= delta;
        wolf.circleAngle += delta * (wolf.speed / wolf.circleRadius);

        // Target spot orbiting player in darkness
        const targetX = playerPos.x + Math.cos(wolf.circleAngle) * wolf.circleRadius;
        const targetZ = playerPos.z + Math.sin(wolf.circleAngle) * wolf.circleRadius;

        const moveDir = new THREE.Vector3(targetX - wolfPos.x, 0, targetZ - wolfPos.z);
        const distToTarget = moveDir.length();
        if (distToTarget > 0.1) {
          moveDir.normalize();
          wolfPos.x += moveDir.x * wolf.speed * delta;
          wolfPos.z += moveDir.z * wolf.speed * delta;
        }

        // Always face player while circling
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);

        // Switch to attack when circling countdown elapses
        if (wolf.circleTimer <= 0) {
          wolf.state = 'attack';
          wolf.attackTimer = 3.2; // 3.2s charge window
          this.sfx.playWolfHowl();
        }
      } else if (wolf.state === 'attack') {
        wolf.attackTimer -= delta;

        // Charge directly at player at 5.4 units/sec!
        const chargeDir = new THREE.Vector3().subVectors(playerPos, wolfPos);
        chargeDir.y = 0;
        chargeDir.normalize();

        wolfPos.x += chargeDir.x * 5.4 * delta;
        wolfPos.z += chargeDir.z * 5.4 * delta;
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);

        // Strike player if reached
        if (distToPlayer < 2.0) {
          this.health = Math.max(0, this.health - delta * 20);
          this.triggerDamageFlash('rgba(168, 85, 247, 0.65)');
          this.triggerScreenShake(0.35);

          if (this.health <= 0) {
            this.triggerGameOver('Dragged down into the frozen shadows by the wolf pack.');
          }

          // Leap back into circling formation after bite
          wolf.state = 'circle';
          wolf.circleTimer = 3.2 + Math.random() * 2.0;
          wolf.circleAngle = Math.atan2(wolfPos.z - playerPos.z, wolfPos.x - playerPos.x);
        }

        if (wolf.attackTimer <= 0) {
          wolf.state = 'circle';
          wolf.circleTimer = 2.8 + Math.random() * 2.0;
        }
      }

      // Terrain-grounded without per-frame raycasts
      wolfPos.y = getTerrainHeight(wolfPos.x, wolfPos.z) + 0.4;
    });
  }

  checkInteractions() {
    let nearest = null;
    let bestDist = Infinity;

    this.interactables.forEach(item => {
      const dx = this.player.position.x - item.pos.x;
      const dy = (this.player.position.y - item.pos.y) * 0.55;
      const dz = this.player.position.z - item.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const reach = item.reachRadius || (item.id === 'radio_beacon' ? 6.5 : 4.4);
      if (dist < reach && dist < bestDist) {
        bestDist = dist;
        nearest = item;
      }
    });

    const prompt = document.getElementById('interaction-prompt');
    const interactText = document.getElementById('interact-text');

    if (nearest) {
      this.nearestInteractable = nearest;
      interactText.textContent = `${nearest.icon} ${nearest.name}`;
      prompt.classList.remove('hidden');
    } else {
      this.nearestInteractable = null;
      prompt.classList.add('hidden');
    }
  }

  updateSnow(delta = 0.016) {
    if (!this.snowParticles) return;
    const px = this.player.position.x;
    const py = this.player.position.y;
    const pz = this.player.position.z;

    const pos = this.snowParticles.geometry.attributes.position;
    const count = pos.count;
    const wrapRadius = 32.0;
    const wrapHeightMin = -4.0;
    const wrapHeightMax = 22.0;
    const time = performance.now() * 0.001;

    for (let i = 0; i < count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      // Light gentle falling + subtle natural drift
      const vy = this.snowVelocities[i * 3 + 1];
      const vx = this.snowVelocities[i * 3] + Math.sin(time + i * 0.2) * 0.14;
      const vz = this.snowVelocities[i * 3 + 2] + Math.cos(time + i * 0.2) * 0.14;

      y += vy * delta;
      x += vx * delta;
      z += vz * delta;

      // Wrap vertically around player's altitude
      if (y < py + wrapHeightMin) {
        y = py + wrapHeightMax;
        x = px + (Math.random() - 0.5) * 2 * wrapRadius;
        z = pz + (Math.random() - 0.5) * 2 * wrapRadius;
      } else if (y > py + wrapHeightMax + 2.0) {
        y = py + wrapHeightMin;
      }

      // Wrap horizontally around player's X and Z
      const dx = x - px;
      const dz = z - pz;
      if (dx > wrapRadius) x -= 2 * wrapRadius;
      else if (dx < -wrapRadius) x += 2 * wrapRadius;

      if (dz > wrapRadius) z -= 2 * wrapRadius;
      else if (dz < -wrapRadius) z += 2 * wrapRadius;

      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
  }

  updateHUD() {
    document.getElementById('bar-health').style.width = `${this.health}%`;
    document.getElementById('val-health').textContent = Math.round(this.health);

    document.getElementById('bar-warmth').style.width = `${this.warmth}%`;
    document.getElementById('val-warmth').textContent = `${Math.round(this.warmth)}%`;

    document.getElementById('bar-hunger').style.width = `${this.hunger}%`;
    document.getElementById('val-hunger').textContent = `${Math.round(this.hunger)}%`;

    document.getElementById('bar-energy').style.width = `${this.energy}%`;
    document.getElementById('val-energy').textContent = `${Math.round(this.energy)}%`;

    document.getElementById('bar-torch').style.width = `${this.torchFuel}%`;
    document.getElementById('val-torch').textContent = `${Math.round(this.torchFuel)}%`;
  }

  render() {
    requestAnimationFrame(() => this.render());
    const now = performance.now();
    const delta = Math.min((now - (this.lastTime || now)) / 1000, 0.1);
    this.lastTime = now;

    this.updateSimulation(delta);
    if (this.usePostProcessing && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

window.getTerrainHeight = getTerrainHeight;
window.getRoadSignedDistance = getRoadSignedDistance;

// Debug: walk road samples from start to tower, log any blocked sample
function debugRoadWalk(game) {
  if (!game || !game.colliders) return;
  const playerRadius = 0.55;
  let blockedCount = 0;
  for (let i = 0; i < ROAD_SAMPLES_COUNT; i++) {
    const s = ROAD_SAMPLES[i];
    let blocked = false;
    for (const col of game.colliders) {
      if (col.type === 'aabb') {
        const cx = Math.max(col.minX, Math.min(col.maxX, s.x));
        const cz = Math.max(col.minZ, Math.min(col.maxZ, s.z));
        const dx = s.x - cx;
        const dz = s.z - cz;
        if (dx * dx + dz * dz < playerRadius * playerRadius) {
          blocked = true;
          break;
        }
      } else if (col.type === 'sphere') {
        const dx = s.x - col.center.x;
        const dz = s.z - col.center.y;
        const minDist = col.radius + playerRadius;
        if (dx * dx + dz * dz < minDist * minDist) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) {
      console.warn(`[DEBUG ROAD] Blocked sample ${i}: x=${s.x.toFixed(1)} z=${s.z.toFixed(1)}`);
      blockedCount++;
    }
  }
  if (blockedCount === 0) {
    console.log('[DEBUG ROAD] All road samples from start to tower are clear.');
  } else {
    console.warn(`[DEBUG ROAD] ${blockedCount} road samples are blocked by colliders.`);
  }
}
window.debugRoadWalk = debugRoadWalk;

window.addEventListener('DOMContentLoaded', () => {
  window.gameInstance = new FrostboundGame();
  // Run debug road-walk check after world is built
  setTimeout(() => debugRoadWalk(window.gameInstance), 2000);
});

export { getTerrainHeight, FrostboundGame };
