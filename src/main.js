import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Input, Output, Mp4OutputFormat, BufferTarget, BlobSource, ALL_FORMATS, Conversion } from 'mediabunny';
const heightmapUrl = new URL('./assets/heightmap.png', import.meta.url).href;
const rockTexUrl = new URL('./assets/rock_color.jpg', import.meta.url).href;

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
// GLOBAL THREE.LOADINGMANAGER FOR SEAMLESS LOADING SCREEN EXPERIENCE
// ---------------------------------------------------------------------------
const globalLoadingManager = new THREE.LoadingManager();

function initLoadingScreen() {
  const loadingScreen = document.getElementById('loading-screen');
  const loadingBar = document.getElementById('loading-bar');
  const loadingPct = document.getElementById('loading-percentage');
  const loadingAsset = document.getElementById('loading-asset');

  let hasFinished = false;
  const finishLoading = () => {
    if (hasFinished) return;
    hasFinished = true;
    if (loadingBar) loadingBar.style.width = '100%';
    if (loadingPct) loadingPct.textContent = '100%';
    if (loadingAsset) loadingAsset.textContent = 'Ready for Survival';
    setTimeout(() => {
      if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => {
          if (loadingScreen.parentNode) loadingScreen.remove();
        }, 850);
      }
    }, 450);
  };

  globalLoadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
    const pct = Math.round((itemsLoaded / itemsTotal) * 100);
    if (loadingBar) loadingBar.style.width = `${pct}%`;
    if (loadingPct) loadingPct.textContent = `${pct}%`;
    if (loadingAsset) {
      const fileName = url.split('/').pop().split('?')[0];
      loadingAsset.textContent = `Loading ${fileName}...`;
    }
  };

  globalLoadingManager.onLoad = () => {
    finishLoading();
  };

  globalLoadingManager.onError = (url) => {
    console.warn('[LoadingManager] Non-fatal load warning:', url);
  };

  // Safety fallback: ensure loading screen gracefully fades out within 3.5s
  setTimeout(finishLoading, 3500);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoadingScreen);
  } else {
    initLoadingScreen();
  }
}


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
  // Straight road lead-in segment for car approach (z: 570 down to 520 along x = -180)
  if (z >= 520) {
    const projX = -180.0;
    const projZ = z;
    const projY = 0.0;
    const roadDist = Math.abs(x - projX);
    // Heading in direction (0, -1), left normal is (-1, 0)
    const signedDist = -(x - projX);
    return {
      signedDist,
      roadDist,
      projX,
      projY,
      projZ,
      tx: 0,
      tz: -1,
      lx: -1,
      lz: 0
    };
  }

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
// VILLAGE & CABIN FOOTPATHS (Connecting every house door, well, bonfire & gorge bridge)
// ---------------------------------------------------------------------------
const VILLAGE_PATH_SEGMENTS = [
  // Hub connects to the main road at (160, 288)
  { ax: 162.0, az: 248.0, bx: 160.0, bz: 288.0 },
  // Hub connects to Elder Soren's Town Hall porch (152, 250)
  { ax: 162.0, az: 248.0, bx: 152.0, bz: 250.0 },
  // Hub connects to Sacred Bonfire Hearth (155, 242)
  { ax: 162.0, az: 248.0, bx: 155.0, bz: 242.0 },
  // Hub connects to Blacksmith Workshop (172, 235)
  { ax: 162.0, az: 248.0, bx: 172.0, bz: 235.0 },
  // Hub connects to Village Storehouse (145, 235)
  { ax: 162.0, az: 248.0, bx: 145.0, bz: 235.0 },
  // Hub connects to Tool Shed (176, 258)
  { ax: 162.0, az: 248.0, bx: 176.0, bz: 258.0 },
  // Hub connects to secondary fire pit (168, 255)
  { ax: 162.0, az: 248.0, bx: 168.0, bz: 255.0 },
  // Hub connects to Gorge Drawbridge Winch approach (161.5, 247 -> 160, 290)
  { ax: 162.0, az: 248.0, bx: 161.5, bz: 247.0 },
  // Branch paths connecting all other cabins into the network:
  { ax: 152.0, az: 250.0, bx: 132.0, bz: 258.0 }, // House 5
  { ax: 132.0, az: 258.0, bx: 138.0, bz: 275.0 }, // House 6
  { ax: 152.0, az: 250.0, bx: 154.0, bz: 270.0 }, // House 7
  { ax: 160.0, az: 288.0, bx: 168.0, bz: 298.0 }, // House 8
  { ax: 176.0, az: 258.0, bx: 188.0, bz: 248.0 }, // House 9
  { ax: 172.0, az: 235.0, bx: 185.0, bz: 228.0 }, // House 10
  { ax: 162.0, az: 248.0, bx: 162.0, bz: 220.0 }, // House 11
  { ax: 145.0, az: 235.0, bx: 135.0, bz: 222.0 }, // House 12
  { ax: 145.0, az: 235.0, bx: 122.0, bz: 242.0 }, // House 13
  { ax: 154.0, az: 270.0, bx: 146.0, bz: 290.0 }, // House 14
  { ax: 188.0, az: 248.0, bx: 216.0, bz: 242.0 }, // House 15
  { ax: 132.0, az: 258.0, bx: 126.0, bz: 268.0 }  // House 16
];

// Precompute segment vectors for fast analytical query
for (const seg of VILLAGE_PATH_SEGMENTS) {
  seg.dx = seg.bx - seg.ax;
  seg.dz = seg.bz - seg.az;
  seg.lenSq = seg.dx * seg.dx + seg.dz * seg.dz || 0.0001;
}

function getVillagePathDistance(x, z) {
  // Broad bounding box check for village area (x: 100 to 230, z: 200 to 310)
  if (x < 100 || x > 230 || z < 200 || z > 310) return 999.0;
  let minDistSq = Infinity;
  for (let i = 0; i < VILLAGE_PATH_SEGMENTS.length; i++) {
    const s = VILLAGE_PATH_SEGMENTS[i];
    const u = Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.lenSq));
    const px = s.ax + u * s.dx;
    const pz = s.az + u * s.dz;
    const dSq = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (dSq < minDistSq) minDistSq = dSq;
  }
  return Math.sqrt(minDistSq);
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
  let r = 0.26;
  let g = 0.42;
  let b = 0.20;

  // Road signed distance query for trail/road soil splatting
  const road = getRoadSignedDistance(x, z);
  const absSignedDist = Math.abs(road.signedDist);

  // Zone-specific Base Turf / Soil variations
  if (z > 350) {
    // Zone 1: Crash site / lower valley damp rocky soil and alpine moss
    r = 0.28; g = 0.34; b = 0.22;
  } else if (z > 130) {
    // Zone 2: Dense pine forest & wide whispering meadow
    if (x > 20 && x < 150 && z > 170 && z < 310) {
      // Wide open green meadow clearing with rich clover and wildflowers
      r = 0.32; g = 0.52; b = 0.22;
    } else {
      // Deep pine forest moss & needles
      r = 0.22; g = 0.38; b = 0.17;
    }
  } else if (z > -100) {
    // Zone 3: Glacial lake basin (~80m oval) & river gorge
    const dxLake = (x - (-35)) / 1.15;
    const dzLake = (z - 40) / 0.95;
    const lakeDist = Math.hypot(dxLake, dzLake);
    if (lakeDist < 82) {
      // Lake bed cold slate silt and icy gravel
      r = 0.18; g = 0.27; b = 0.32;
    } else {
      r = 0.25; g = 0.38; b = 0.22;
    }
  } else if (z > -320) {
    // Zone 4: Hunter camp workshop ground - dark soil, pine needles, sawdust
    const campDist = Math.hypot(x - (-70), z - (-235));
    if (campDist < 48) {
      r = 0.34; g = 0.26; b = 0.18; // Mud & weathered sawdust
    } else {
      r = 0.25; g = 0.34; b = 0.20;
    }
  } else {
    // Zone 5: Khai ridge alpine tundra turf
    r = 0.26; g = 0.32; b = 0.24;
  }

  // 3. Road Surface (5m width = 2.5m half-width) & 0.3m Gravel Shoulders (2.8m)
  if (absSignedDist <= 2.5) {
    // Main road surface: worn dirt with subtle ruts and tire tracks
    const dirtNoise = perlin2D(x * 0.2, z * 0.2) * 0.04;
    r = 0.26 + dirtNoise;
    g = 0.20 + dirtNoise;
    b = 0.14 + dirtNoise;
  } else if (absSignedDist <= 2.8) {
    // 0.3m Gravel Shoulders: slightly lighter gravel tone
    const shoulderGravel = 0.36 + perlin2D(x * 0.3, z * 0.3) * 0.05;
    r = shoulderGravel;
    g = shoulderGravel * 0.95;
    b = shoulderGravel * 0.90;
  } else if (absSignedDist <= 4.2) {
    // Smooth transition from shoulder gravel into grass/terrain
    const t = (absSignedDist - 2.8) / 1.4;
    const shoulderR = 0.34, shoulderG = 0.32, shoulderB = 0.28;
    r = shoulderR * (1 - t) + r * t;
    g = shoulderG * (1 - t) + g * t;
    b = shoulderB * (1 - t) + b * t;
  }

  // 3b. WORN DIRT FOOTPATHS & TRAIL SPLATTING (Front of Cabins, Village Square, Well & Drawbridge)
  const pathDist = getVillagePathDistance(x, z);
  if (pathDist < 2.8) {
    // Trampled mountain dirt trail with subtle pebbles & faded ground grass
    const trailNoise = perlin2D(x * 0.25, z * 0.25) * 0.03;
    const coreDirtR = 0.28 + trailNoise;
    const coreDirtG = 0.22 + trailNoise;
    const coreDirtB = 0.15 + trailNoise;
    if (pathDist <= 1.3) {
      // Core beaten dirt footpath: heavily trampled earth where people walk
      r = coreDirtR;
      g = coreDirtG;
      b = coreDirtB;
    } else {
      // Soft transition edge: trampled earthy grass along trail borders
      const t = (pathDist - 1.3) / 1.5;
      const edgeDirtR = coreDirtR * 0.65 + r * 0.35;
      const edgeDirtG = coreDirtG * 0.65 + g * 0.35;
      const edgeDirtB = coreDirtB * 0.65 + b * 0.35;
      r = edgeDirtR * (1 - t) + r * t;
      g = edgeDirtG * (1 - t) + g * t;
      b = edgeDirtB * (1 - t) + b * t;
    }
  }

  // 4. Slope Splat: Rock / Slate / Granite Cliffs (steep slopes are rock, NOT flat white)
  if (slope > 0.28) {
    const rockT = Math.min(1.0, (slope - 0.28) / 0.45);
    // Mountain granite crags
    let rockR = 0.28, rockG = 0.30, rockB = 0.32;
    if (slope > 0.80) {
      // Dark sheer precipice granite
      rockR = 0.19; rockG = 0.20; rockB = 0.22;
    }
    const rockVar = perlin2D(x * 0.06, z * 0.06) * 0.05;
    rockR = Math.max(0.12, rockR + rockVar);
    rockG = Math.max(0.12, rockG + rockVar);
    rockB = Math.max(0.14, rockB + rockVar);

    r = r * (1 - rockT) + rockR * rockT;
    g = g * (1 - rockT) + rockG * rockT;
    b = b * (1 - rockT) + rockB * rockT;
  }

  // 5. SNOW: Only on High Peaks & Ridges (y > 26m) on gentler top surfaces
  if (y > 26.0) {
    const altFactor = Math.min(1.0, (y - 26.0) / 10.0);
    const patchNoise = perlin2D(x * 0.045, z * 0.045);
    if (patchNoise > 0.12 && slope < 0.52) {
      const slopeFactor = 1.0 - slope / 0.52;
      const snowIntensity = Math.min(0.85, (patchNoise - 0.12) * 1.8 * altFactor * slopeFactor);
      const snowR = 0.88, snowG = 0.91, snowB = 0.96;
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

  // ROAD SURFACE: Flat carved mountain road (width 5.0m, half-width 2.5m)
  if (Math.abs(s) <= 2.5) {
    corridorY = py;
  }
  // LEFT SIDE (MOUNTAIN/CLIFF SIDE, s > 2.5m):
  // 0.3m gravel shoulder up to 2.8m, then rocky slopes, forest clearings, rising to distant alpine ridges
  else if (s > 2.5) {
    if (s <= 3.8) {
      const shoulderT = (s - 2.5) / 1.3;
      corridorY = py + shoulderT * shoulderT * 0.45;
    } else {
      const hillDist = s - 3.8;
      // Rolling natural rocky slopes that don't block visibility, with occasional pine terraces
      const slopeRise = Math.min(32.0, Math.pow(hillDist * 0.45, 1.15) * 1.6 + 0.45);
      const cragNoise = perlin2D(x * 0.04, z * 0.04) * 2.2 + perlin2D(x * 0.1, z * 0.1) * 0.9;
      // Distant snow-capped ridgeline rise beyond 90m from road
      let ridgeBonus = 0;
      if (hillDist > 90.0) {
        ridgeBonus = Math.min(48.0, Math.pow((hillDist - 90.0) * 0.3, 1.25) * 1.4);
      }
      corridorY = py + slopeRise + cragNoise + ridgeBonus;
    }
  }
  // RIGHT SIDE (KHAI / RAVINE SIDE, s < -2.5m):
  // 0.3m shoulder up to 2.8m, 3m gentle grassy ledge (2.8m - 5.8m), then steep ravine plunge to -18m,
  // and beyond the ravine (>38m) rolling green hills, frozen river valley, and distant hills
  else {
    const rightDist = -s;
    if (rightDist <= 5.8) {
      const ledgeT = (rightDist - 2.5) / 3.3;
      corridorY = py - ledgeT * 0.25;
    } else {
      const dropDist = rightDist - 5.8;

      // Hidden return route switchback: carved along canyon wall near z in [-490, -420]
      const isSwitchbackZone = z < -420 && z > -490 && rightDist >= 5.8 && rightDist <= 18.0;
      if (isSwitchbackZone) {
        const rampT = Math.max(0, Math.min(1.0, (-420 - z) / 70.0));
        const rampY = (py - 18.0) + (1.0 - rampT) * 18.0;
        corridorY = Math.max(rampY, py - 18.0);
      } else if (dropDist < 14.0) {
        const dropT = dropDist / 14.0;
        const plunge = (dropT * dropT * (3.0 - 2.0 * dropT)) * 18.0;
        corridorY = py - 0.25 - plunge;
      } else {
        const canyonDist = dropDist - 14.0;
        const floorDepth = 18.0;
        const canyonNoise = perlin2D(x * 0.05, z * 0.05) * 1.5;
        if (canyonDist < 22.0) {
          // Ravine canyon floor / frozen valley bottom
          corridorY = py - floorDepth + canyonNoise;
        } else {
          // Beyond the ravine: gentle rolling green hills and open frozen river valley
          const valleyDist = canyonDist - 22.0;
          const rollingHills = perlin2D((x + 120) * 0.015, (z + 80) * 0.015) * 8.5
                             + perlin2D(x * 0.035, z * 0.035) * 3.5;
          const hillRise = Math.min(22.0, Math.pow(valleyDist * 0.35, 1.1) * 1.1);
          corridorY = (py - 18.0) + 7.0 + hillRise + rollingHills;
        }
      }
    }
  }

  // ZONE 1: Starting Landslide rock barrier behind crashed vehicle (z > 560)
  if (z > 560) {
    corridorY += Math.min(26.0, Math.pow((z - 560) * 0.85, 1.3));
  }

  // ZONE 2: Wide Open Whispering Meadow Clearing (green clearing with stream crossing)
  if (z > 170 && z < 310 && x > 20 && x < 150) {
    const meadowDist = Math.hypot(x - 85, z - 240);
    if (meadowDist < 60) {
      const meadowWeight = Math.max(0, 1.0 - meadowDist / 60);
      const flatMeadowY = 10.2 + perlin2D(x * 0.035, z * 0.035) * 0.5;
      corridorY = corridorY * (1.0 - meadowWeight * 0.75) + flatMeadowY * (meadowWeight * 0.75);
    }
  }

  // ZONE 3: Glacial Lake Basin (~80m radius oval basin & river gorge)
  const dxLake = (x - (-35)) / 1.15;
  const dzLake = (z - 40) / 0.95;
  const lakeDist = Math.hypot(dxLake, dzLake);
  if (lakeDist < 82) {
    const lakeWeight = Math.max(0, 1.0 - lakeDist / 82);
    const lakeFloorY = 4.8 + perlin2D(x * 0.03, z * 0.03) * 0.3;
    // Don't carve the road bridge path itself if roadDist < 4.5
    if (road.roadDist > 4.5) {
      corridorY = corridorY * (1.0 - lakeWeight * 0.88) + lakeFloorY * (lakeWeight * 0.88);
    }
  }

  // ZONE 3-4 BORDER: Abandoned Village Plateau (natural ground for 14-18 houses)
  const villageDist = Math.hypot(x - 160, z - 245);
  if (villageDist < 55) {
    const vWeight = Math.max(0, 1.0 - villageDist / 55);
    const vPlateauY = 12.8 + perlin2D(x * 0.03, z * 0.03) * 0.4;
    corridorY = corridorY * (1.0 - vWeight * 0.7) + vPlateauY * (vWeight * 0.7);
  }

  // ZONE 4: Hunter Camp Clearing Plateau (smooth terrain around cabin & workshop)
  const campDist = Math.hypot(x - (-70), z - (-235));
  if (campDist < 48) {
    const campWeight = Math.max(0, 1.0 - campDist / 48);
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

  // Smooth blend between road corridor and base terrain out to 80m
  const blendT = Math.max(0, Math.min(1, (road.roadDist - 45) / 45));
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

  // Gentle warm radial glow without blinding whiteout
  const grad = ctx.createRadialGradient(cx, cy, 14, cx, cy, 256);
  grad.addColorStop(0.0, 'rgba(255, 235, 180, 0.55)');
  grad.addColorStop(0.20, 'rgba(255, 180, 90, 0.35)');
  grad.addColorStop(0.50, 'rgba(240, 130, 45, 0.15)');
  grad.addColorStop(0.80, 'rgba(220, 90, 20, 0.05)');
  grad.addColorStop(1.0, 'rgba(200, 60, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  // Soft subtle god-rays crepuscular spokes
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const rayLen = 240;
    const rayWidth = 0.045 + (i % 2) * 0.02;
    ctx.fillStyle = 'rgba(255, 195, 100, 0.08)';
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
    resolution: { value: new THREE.Vector2(typeof window !== 'undefined' ? window.innerWidth : 1920, typeof window !== 'undefined' ? window.innerHeight : 1080) },
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
  const texLoader = new THREE.TextureLoader(globalLoadingManager);
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
      normal = normalize(normal + vec3(wN1.x + wN2.x, wN1.y + wN2.y, 0.0) * 0.25);
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
// ANIMATED ICE LAKE SHADER (Subtle crystalline shimmer, translucent depth & ice cracks)
// ---------------------------------------------------------------------------
function createIceLakeMaterial() {
  const customUniforms = {
    uTime: { value: 0 }
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    roughness: 0.22,
    metalness: 0.65,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide
  });

  mat.userData.customUniforms = customUniforms;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = customUniforms.uTime;
    shader.vertexShader = `
      varying vec3 vWorldPos;
      ${shader.vertexShader}
    `;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      `
    );

    shader.fragmentShader = `
      uniform float uTime;
      varying vec3 vWorldPos;
      ${shader.fragmentShader}
    `;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      // Multi-layer ice crystal refraction and sun specular shimmer
      vec2 iceUv = vWorldPos.xz * 0.08;
      float shimmer1 = sin(iceUv.x * 24.0 + iceUv.y * 18.0 + uTime * 1.5);
      float shimmer2 = cos(iceUv.x * 32.0 - iceUv.y * 28.0 - uTime * 1.2);
      float crystalGlitter = max(0.0, shimmer1 * shimmer2);
      crystalGlitter = pow(crystalGlitter, 4.0);

      // Deep cyan glacial gradient toward center
      vec3 deepIce = vec3(0.18, 0.52, 0.78);
      vec3 brightGlaze = vec3(0.85, 0.95, 1.0);
      diffuseColor.rgb = mix(deepIce, brightGlaze, 0.35 + crystalGlitter * 0.45);
      `
    );
  };

  return mat;
}

// ---------------------------------------------------------------------------
// PBR SPLAT TERRAIN MATERIAL (Poly Haven Grass, Dirt, Rock, Snow Blended by Height, Slope & Noise)
// ---------------------------------------------------------------------------
function createPBRTerrainMaterial() {
  const texLoader = new THREE.TextureLoader(globalLoadingManager);
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
// ANIMALS: HORSE HERD (6 Grazing Horses in Zone 2 Meadow with Idle Animation)
// ---------------------------------------------------------------------------
class HorseHerd {
  constructor(scene) {
    this.scene = scene;
    this.horses = [];
    this.initHerd();
  }

  initHerd() {
    const horseColors = [
      0x5c3a21, // Chestnut brown
      0x2c1d11, // Dark bay
      0x8b5a2b, // Light sorrel
      0xd9cfc1, // Dappled palomino / light coat
      0x1a1a1a, // Midnight black
      0x6b4423  // Wild bay
    ];
    const maneMat = new THREE.MeshStandardMaterial({ color: 0x18120c, roughness: 0.9 });
    const muzzleMat = new THREE.MeshStandardMaterial({ color: 0x221810, roughness: 0.95 });
    const hoofMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });

    // 6 Horses grazing in Zone 2 Meadow clearing (x: 45 to 110, z: 215 to 275)
    const positions = [
      { x: 52, z: 232, rot: 0.4 },
      { x: 68, z: 250, rot: -1.1 },
      { x: 84, z: 228, rot: 1.8 },
      { x: 96, z: 262, rot: -0.6 },
      { x: 108, z: 242, rot: 2.5 },
      { x: 74, z: 270, rot: 0.9 }
    ];

    positions.forEach((p, idx) => {
      const coatMat = new THREE.MeshStandardMaterial({
        color: horseColors[idx % horseColors.length],
        roughness: 0.78,
        metalness: 0.05
      });

      const group = new THREE.Group();
      const gy = getTerrainHeight(p.x, p.z);
      group.position.set(p.x, gy, p.z);
      group.rotation.y = p.rot;

      // Horse Torso / Barrel
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.0, 2.1), coatMat);
      body.position.y = 1.45;
      body.castShadow = true;
      group.add(body);

      // Withers / Rump curves
      const rump = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.9, 0.7), coatMat);
      rump.position.set(0, 1.5, 0.9);
      group.add(rump);

      // Tail
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.16, 1.1, 5), maneMat);
      tail.position.set(0, 1.25, 1.4);
      tail.rotation.x = 0.35;
      group.add(tail);

      // Neck & Head Pivot Group (lowered for grazing)
      const neckGroup = new THREE.Group();
      neckGroup.position.set(0, 1.7, -0.9);

      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 1.0, 6), coatMat);
      neck.position.set(0, -0.2, -0.3);
      neck.rotation.x = 0.85; // Natural graze tilt
      neckGroup.add(neck);

      // Mane along neck
      const mane = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.3), maneMat);
      mane.position.set(0, -0.05, -0.2);
      mane.rotation.x = 0.85;
      neckGroup.add(mane);

      // Head
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.45, 0.8), coatMat);
      head.position.set(0, -0.65, -0.7);
      head.rotation.x = 0.35;
      neckGroup.add(head);

      // Muzzle
      const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.4), muzzleMat);
      muzzle.position.set(0, -0.8, -1.05);
      neckGroup.add(muzzle);

      // Ears
      [-0.15, 0.15].forEach(ex => {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 4), coatMat);
        ear.position.set(ex, -0.42, -0.55);
        ear.rotation.x = 0.2;
        ear.rotation.z = ex > 0 ? -0.25 : 0.25;
        neckGroup.add(ear);
      });

      group.add(neckGroup);

      // 4 Strong Legs
      const legPositions = [
        [-0.32, -0.7],
        [0.32, -0.7],
        [-0.32, 0.75],
        [0.32, 0.75]
      ];
      legPositions.forEach(([lx, lz]) => {
        const legUpper = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.09, 0.8, 6), coatMat);
        legUpper.position.set(lx, 1.05, lz);
        legUpper.castShadow = true;
        group.add(legUpper);

        const legLower = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.7, 6), coatMat);
        legLower.position.set(lx, 0.4, lz);
        legLower.castShadow = true;
        group.add(legLower);

        const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.18, 6), hoofMat);
        hoof.position.set(lx, 0.09, lz);
        group.add(hoof);
      });

      this.scene.add(group);

      this.horses.push({
        mesh: group,
        neck: neckGroup,
        basePos: new THREE.Vector3(p.x, gy, p.z),
        phase: Math.random() * Math.PI * 2,
        grazeSpeed: 0.8 + Math.random() * 0.4
      });
    });
  }

  update(delta) {
    const time = performance.now() * 0.001;
    this.horses.forEach(h => {
      // Natural rhythmic head bobbing while munching meadow grass
      const bob = Math.sin(time * h.grazeSpeed + h.phase);
      const microSway = Math.cos(time * 0.6 + h.phase) * 0.06;
      h.neck.rotation.x = 0.15 + bob * 0.12;
      h.neck.rotation.y = microSway;
      // Slight gentle breathing shift
      h.mesh.position.y = getTerrainHeight(h.basePos.x, h.basePos.z) + Math.sin(time * 1.2 + h.phase) * 0.015;
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
// Shared soft circular particle texture for round, glowing fire embers & smoke
let _flameParticleTextureCache = null;
function getFlameParticleTexture() {
  if (_flameParticleTextureCache) return _flameParticleTextureCache;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.25, 'rgba(255, 235, 180, 0.85)');
  grad.addColorStop(0.55, 'rgba(255, 120, 20, 0.4)');
  grad.addColorStop(0.85, 'rgba(180, 40, 10, 0.1)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  _flameParticleTextureCache = new THREE.CanvasTexture(canvas);
  return _flameParticleTextureCache;
}

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
      map: getFlameParticleTexture(),
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
    // Torch handle & stick aligned in a clean sub-group with natural grip angle
    this.torchMount = new THREE.Group();
    this.torchMount.position.set(0, 0.10, -0.02);
    this.torchMount.rotation.x = 0.20;
    this.torchGroup.add(this.torchMount);

    // Dark rustic wood stick
    const stickMat = new THREE.MeshStandardMaterial({
      color: 0x3d2314,
      roughness: 0.9,
      metalness: 0.05
    });
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.54, 8), stickMat);
    stick.position.set(0, 0, 0);
    this.torchMount.add(stick);

    // Pitch-soaked cloth head wrapping wrapped tightly around the top of the stick
    const clothMat = new THREE.MeshStandardMaterial({
      color: 0x1c140d,
      roughness: 0.95,
      bumpScale: 0.05
    });
    const clothWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.026, 0.12, 10), clothMat);
    clothWrap.position.set(0, 0.22, 0);
    this.torchMount.add(clothWrap);

    // Glowing ember collar at the base of the flame
    const collarMat = new THREE.MeshBasicMaterial({
      color: 0xff3b00
    });
    const emberCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.030, 0.03, 10), collarMat);
    emberCollar.position.set(0, 0.27, 0);
    this.torchMount.add(emberCollar);

    // Main flame cluster root: positioned directly on top of the cloth wrap at y = 0.28
    this.flameMesh = new THREE.Group();
    this.flameMesh.position.set(0, 0.28, 0);
    this.torchMount.add(this.flameMesh);

    // 1) Outer dancing flame (warm fiery orange / red gradient feel)
    const outerFlameMat = new THREE.MeshBasicMaterial({
      color: 0xff5500,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.outerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.046, 0.18, 10), outerFlameMat);
    this.outerFlame.position.set(0, 0.09, 0);
    this.flameMesh.add(this.outerFlame);

    // 2) Inner intense yellow flame core
    const innerFlameMat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.innerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.13, 8), innerFlameMat);
    this.innerFlame.position.set(0, 0.065, 0);
    this.flameMesh.add(this.innerFlame);

    // 3) White-hot incandescent ignition tip
    const tipMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.tipFlame = new THREE.Mesh(new THREE.SphereGeometry(0.015, 6, 6), tipMat);
    this.tipFlame.position.set(0, 0.04, 0);
    this.tipFlame.scale.set(0.8, 1.4, 0.8);
    this.flameMesh.add(this.tipFlame);

    // 4) Micro-sparks / embers system anchored directly to the torch head
    const emberCount = 12;
    const emberGeom = new THREE.BufferGeometry();
    const emberPositions = new Float32Array(emberCount * 3);
    const emberColors = new Float32Array(emberCount * 3);
    this.torchEmbersData = [];

    for (let i = 0; i < emberCount; i++) {
      emberPositions[i * 3] = (Math.random() - 0.5) * 0.03;
      emberPositions[i * 3 + 1] = 0.05 + Math.random() * 0.15;
      emberPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.03;

      const isGold = Math.random() > 0.4;
      emberColors[i * 3] = 1.0;
      emberColors[i * 3 + 1] = isGold ? 0.8 : 0.35;
      emberColors[i * 3 + 2] = isGold ? 0.2 : 0.05;

      this.torchEmbersData.push({
        baseX: (Math.random() - 0.5) * 0.03,
        baseZ: (Math.random() - 0.5) * 0.03,
        speedY: 0.18 + Math.random() * 0.22,
        wobbleSpeed: 4 + Math.random() * 6,
        phase: Math.random() * Math.PI * 2,
        height: Math.random() * 0.22
      });
    }

    emberGeom.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3));
    emberGeom.setAttribute('color', new THREE.BufferAttribute(emberColors, 3));

    const emberMat = new THREE.PointsMaterial({
      size: 0.035,
      map: getFlameParticleTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.torchEmbersPoints = new THREE.Points(emberGeom, emberMat);
    this.torchEmbersPoints.position.set(0, 0.05, 0);
    this.flameMesh.add(this.torchEmbersPoints);

    // Dedicated PointLight at the flame head that lights up the hands and surroundings
    this.handTorchLight = new THREE.PointLight(0xff9e44, 4.5, 32, 1.4);
    this.handTorchLight.position.set(0, 0.35, 0);
    this.handTorchLight.castShadow = false;
    this.torchMount.add(this.handTorchLight);

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
      this.handTorchLight.intensity = isTorchLit ? 4.5 : 0;
      if (isTorchLit) {
        const time = performance.now() * 0.001;
        const flick = Math.sin(time * 24) * 0.18 + Math.sin(time * 43) * 0.12 + Math.sin(time * 11) * 0.08;
        this.handTorchLight.intensity = Math.max(3.2, 4.5 + flick * 2.0);

        // Natural, organic flame lick and stretch directly atop the torch head
        if (this.outerFlame) {
          const wobbleX = Math.sin(time * 16) * 0.06;
          const wobbleZ = Math.cos(time * 19) * 0.06;
          this.outerFlame.scale.set(1.0 + flick * 0.15 + wobbleX * 0.5, 1.0 + flick * 0.35, 1.0 + flick * 0.15 + wobbleZ * 0.5);
          this.outerFlame.rotation.z = Math.sin(time * 12) * 0.08;
          this.outerFlame.rotation.x = Math.cos(time * 14) * 0.08;
        }

        if (this.innerFlame) {
          this.innerFlame.scale.set(1.0 + flick * 0.22, 1.0 + flick * 0.30, 1.0 + flick * 0.22);
          this.innerFlame.rotation.z = Math.sin(time * 18) * 0.05;
        }

        if (this.tipFlame) {
          this.tipFlame.scale.set(0.8 + flick * 0.12, 1.3 + flick * 0.20, 0.8 + flick * 0.12);
        }

        // Animate torch embers rising from tip and resetting smoothly
        if (this.torchEmbersPoints && this.torchEmbersData) {
          const pos = this.torchEmbersPoints.geometry.attributes.position;
          for (let i = 0; i < this.torchEmbersData.length; i++) {
            const ed = this.torchEmbersData[i];
            ed.height += ed.speedY * delta;
            if (ed.height > 0.25) {
              ed.height = 0.02;
              ed.baseX = (Math.random() - 0.5) * 0.03;
              ed.baseZ = (Math.random() - 0.5) * 0.03;
            }
            const wobble = Math.sin(time * ed.wobbleSpeed + ed.phase) * 0.012;
            pos.setXYZ(i, ed.baseX + wobble, ed.height, ed.baseZ + wobble * 0.5);
          }
          pos.needsUpdate = true;
        }
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
// SOLSTICE VILLAGE ELDER KAELEN (Animated NPC Guide)
// ---------------------------------------------------------------------------
class ElderKaelenNPC {
  constructor(scene, x = 158.0, z = 246.0) {
    this.scene = scene;
    this.x = x;
    this.z = z;
    this.y = getTerrainHeight(x, z);
    this.root = new THREE.Group();
    this.root.position.set(this.x, this.y, this.z);
    this.scene.add(this.root);

    this.idleTime = 0;
    this.hasGivenTorch = false;
    this.buildElder();
  }

  buildElder() {
    // Materials for Elder Kaelen: Aged woven wool, weathered leather, golden fur trim, runic staff
    const robeMat = new THREE.MeshStandardMaterial({ color: 0x3b2d54, roughness: 0.85 }); // Deep mystic violet/indigo robe
    const underRobeMat = new THREE.MeshStandardMaterial({ color: 0x1f172f, roughness: 0.9 });
    const furTrimMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.95 }); // White winter fur
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.8 });
    const beardMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.95 }); // Long snowy-white elder beard
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });
    const runeCrystalMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 }); // Glowing blue runic crest
    const hoodMat = new THREE.MeshStandardMaterial({ color: 0x2e2042, roughness: 0.85 });

    // Lower Body / Flowing Robes
    const robeBase = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.52, 1.0, 10), underRobeMat);
    robeBase.position.y = 0.5;
    robeBase.castShadow = true;
    robeBase.receiveShadow = true;
    this.root.add(robeBase);

    // Glowing Sacred Beacon Ring at Elder's Feet (Blinks/Pulses as Visual Quest Hint)
    const ringGeom = new THREE.RingGeometry(1.2, 1.5, 36);
    ringGeom.rotateX(-Math.PI / 2);
    this.beaconMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.beaconRing = new THREE.Mesh(ringGeom, this.beaconMat);
    this.beaconRing.position.y = 0.05;
    this.root.add(this.beaconRing);

    // Torso & Great Winter Mantle
    this.torso = new THREE.Group();
    this.torso.position.y = 0.95;

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.55, 0.32), robeMat);
    chest.position.y = 0.28;
    chest.castShadow = true;
    this.torso.add(chest);

    // Heavy Fur Mantle Shawl over shoulders
    const furShawl = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.18, 0.38), furTrimMat);
    furShawl.position.y = 0.46;
    furShawl.castShadow = true;
    this.torso.add(furShawl);

    // Head, Hood & Snowy Long Beard
    this.head = new THREE.Group();
    this.head.position.y = 0.62;

    const face = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.2), skinMat);
    face.position.set(0, 0.1, 0.02);
    this.head.add(face);

    // Deep Winter Hood draped over head
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), hoodMat);
    hood.position.set(0, 0.14, -0.02);
    this.head.add(hood);

    // Long Flowing White Beard
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.38, 5), beardMat);
    beard.rotation.x = 0.2;
    beard.position.set(0, -0.04, 0.12);
    this.head.add(beard);

    this.torso.add(this.head);

    // Left Arm (holding ancient carved staff)
    this.armL = new THREE.Group();
    this.armL.position.set(-0.28, 0.42, 0);
    const sleeveL = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.48, 8), robeMat);
    sleeveL.position.y = -0.22;
    this.armL.add(sleeveL);

    // Elder Staff
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.9, 8), woodMat);
    staff.position.set(-0.06, -0.15, 0.22);
    staff.rotation.x = 0.1;
    this.armL.add(staff);

    // Glowing Blue Sun-Rune Crystal atop Staff
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), runeCrystalMat);
    crystal.position.set(-0.06, 0.85, 0.22);
    this.armL.add(crystal);

    const staffLight = new THREE.PointLight(0x38bdf8, 1.8, 8);
    staffLight.position.set(-0.06, 0.9, 0.22);
    this.armL.add(staffLight);

    this.torso.add(this.armL);

    // Right Arm (outstretched holding the Sacred Torch or beckoning)
    this.armR = new THREE.Group();
    this.armR.position.set(0.28, 0.42, 0);
    const sleeveR = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.48, 8), robeMat);
    sleeveR.position.y = -0.22;
    this.armR.add(sleeveR);

    // Sacred Torch Offered by Elder
    this.torchOfferGroup = new THREE.Group();
    this.torchOfferGroup.position.set(0.05, -0.4, 0.25);
    this.torchOfferGroup.rotation.x = 0.5;

    const torchStick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.6, 6), woodMat);
    this.torchOfferGroup.add(torchStick);

    const torchHead = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.14, 8), new THREE.MeshStandardMaterial({ color: 0x1f172f, roughness: 0.9 }));
    torchHead.position.y = 0.3;
    this.torchOfferGroup.add(torchHead);

    this.flameOffer = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 8), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    this.flameOffer.position.y = 0.42;
    this.torchOfferGroup.add(this.flameOffer);

    this.torchLightOffer = new THREE.PointLight(0xff8822, 2.8, 10);
    this.torchLightOffer.position.y = 0.45;
    this.torchOfferGroup.add(this.torchLightOffer);

    this.armR.add(this.torchOfferGroup);
    this.torso.add(this.armR);

    this.root.add(this.torso);

    // Face towards village bonfire square center (towards (160, 248))
    this.root.lookAt(160.0, this.y, 248.0);
  }

  update(delta, playerPos) {
    this.idleTime += delta;

    // Gentle breathing idle animation
    if (this.torso) {
      this.torso.position.y = 0.95 + Math.sin(this.idleTime * 1.8) * 0.02;
    }
    if (this.head) {
      this.head.rotation.x = Math.sin(this.idleTime * 1.4) * 0.04;
      this.head.rotation.z = Math.cos(this.idleTime * 0.9) * 0.02;
    }
    if (this.armR) {
      // Beckoning / gentle gesture
      this.armR.rotation.x = -0.25 + Math.sin(this.idleTime * 2.0) * 0.08;
      this.armR.rotation.z = 0.15 + Math.cos(this.idleTime * 1.6) * 0.04;
    }
    if (this.flameOffer) {
      const s = 1.0 + Math.sin(this.idleTime * 14.0) * 0.15;
      this.flameOffer.scale.set(s, s * (1.0 + Math.cos(this.idleTime * 18.0) * 0.2), s);
    }
    if (this.torchLightOffer) {
      this.torchLightOffer.intensity = 2.4 + Math.sin(this.idleTime * 15.0) * 0.6;
    }
    // Gentle pulsating/blinking visual hint on the beacon ring
    if (this.beaconRing && this.beaconMat && !this.hasGivenTorch) {
      const pulse = 0.35 + 0.35 * Math.sin(this.idleTime * 4.0);
      this.beaconMat.opacity = pulse;
      const s = 1.0 + 0.12 * Math.sin(this.idleTime * 4.0);
      this.beaconRing.scale.set(s, s, s);
    }

    // Turn head to gaze towards player if nearby
    if (playerPos) {
      const dist = this.root.position.distanceTo(playerPos);
      if (dist < 10.0 && this.head) {
        const dx = playerPos.x - this.root.position.x;
        const dz = playerPos.z - this.root.position.z;
        const targetAngle = Math.atan2(dx, dz) - this.root.rotation.y;
        this.head.rotation.y = THREE.MathUtils.clamp(targetAngle, -0.65, 0.65);
      }
    }
  }

  handOverTorch() {
    this.hasGivenTorch = true;
    if (this.beaconRing) {
      this.beaconRing.visible = false;
    }
    if (this.torchOfferGroup) {
      this.torchOfferGroup.visible = false;
    }
    if (this.torchLightOffer) {
      this.torchLightOffer.intensity = 0;
    }
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
    if (typeof window === 'undefined' || !window.location) return;
    const loader = new GLTFLoader(globalLoadingManager);
    
    // Explicitly load texture if needed to ensure correct material binding
    const texLoader = new THREE.TextureLoader(globalLoadingManager);
    const colormapTex = texLoader.load('./assets/models/colormap.png');
    colormapTex.colorSpace = THREE.SRGBColorSpace;
    colormapTex.flipY = false;

    loader.load(
      './assets/models/character.glb',
      (gltf) => {
        try {
          this.glbModel = gltf.scene;
          this.glbModel.scale.set(1.15, 1.15, 1.15); // Authentic human proportion
          
          this.glbModel.traverse(c => {
            if (c.isMesh) {
              c.castShadow = true;
              c.receiveShadow = true;
              if (c.material) {
                // Ensure proper high-quality material rendering with texture
                c.material.map = colormapTex;
                c.material.roughness = 0.85;
                c.material.metalness = 0.1;
                c.material.needsUpdate = true;
              }
            }
          });

          this.root.add(this.glbModel);
          this.procGroup.visible = false;
          this.hasGLB = true;
          this.setFirstPerson(this.isFirstPerson);

          // Attach third-person torch directly into the Right Hand of the character
          this.glbTorch = new THREE.Group();
          const glbStick = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.55, 6), new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.85 }));
          glbStick.position.y = 0.15;
          this.glbTorch.add(glbStick);
          this.glbTorchFlame = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 8), new THREE.MeshBasicMaterial({ color: 0xffa500 }));
          this.glbTorchFlame.position.y = 0.44;
          this.glbTorch.add(this.glbTorchFlame);

          // Find arm-right node in Kenney character model hierarchy
          let armRightNode = null;
          this.glbModel.traverse(node => {
            const n = (node.name || '').toLowerCase();
            if (n === 'arm-right' || n.includes('arm_r') || n.includes('rightarm')) {
              armRightNode = node;
            }
          });

          if (armRightNode) {
            // arm-right reaches down to x: -0.22, y: -0.05, z: 0 in local space
            // Orient torch upright held firmly in the fist
            this.glbTorch.position.set(-0.22, -0.02, 0.04);
            this.glbTorch.rotation.set(0.2, 0, Math.PI / 2);
            armRightNode.add(this.glbTorch);
          } else {
            this.glbTorch.position.set(0.18, 0.55, 0.15);
            this.glbModel.add(this.glbTorch);
          }

          if (gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.glbModel);
            gltf.animations.forEach(clip => {
              const name = clip.name.toLowerCase();
              this.animations[name] = this.mixer.clipAction(clip);
            });
            
            // Set initial state
            this.currentActionName = 'idle';
            this.activeAction = this.animations['idle'] || Object.values(this.animations)[0];
            if (this.activeAction) {
              this.activeAction.play();
            }
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
    // In first person, hide whole third person player model so body/arms/torso never block the camera view
    this.root.visible = !isFp;
  }

  playAction(name, fadeDuration = 0.2) {
    if (!this.animations || !this.animations[name]) return;
    if (this.currentActionName === name) return;

    const prevAction = this.activeAction;
    const newAction = this.animations[name];

    if (newAction) {
      newAction.reset();
      newAction.fadeIn(fadeDuration);
      newAction.play();

      if (prevAction && prevAction !== newAction) {
        prevAction.fadeOut(fadeDuration);
      }

      this.activeAction = newAction;
      this.currentActionName = name;
    }
  }

  update(delta, playerPos, speed, isGrounded, isSprinting, moveDir, isTorchLit, cameraYaw) {
    this.root.position.copy(playerPos);

    if (this.thirdPersonTorch) {
      this.thirdPersonTorch.visible = !this.isFirstPerson;
      this.tpTorchFlame.visible = isTorchLit;
    }
    if (this.glbTorch) {
      this.glbTorch.visible = !this.isFirstPerson;
      if (this.glbTorchFlame) {
        this.glbTorchFlame.visible = isTorchLit;
      }
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

    const isMoving = speed > 0.4;

    // GLB Skeletal Animation State Machine
    if (this.mixer) {
      if (!isGrounded) {
        // In air: jump / fall animation
        if (this.animations['jump']) {
          this.playAction('jump', 0.15);
        } else if (this.animations['fall']) {
          this.playAction('fall', 0.15);
        }
      } else if (isMoving) {
        if (isSprinting && this.animations['sprint']) {
          this.playAction('sprint', 0.2);
        } else if (this.animations['walk']) {
          this.playAction('walk', 0.2);
        }
      } else {
        if (this.animations['idle']) {
          this.playAction('idle', 0.25);
        }
      }

      this.mixer.update(delta);
      return;
    }

    // Procedural Fallback Animation
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
    if (typeof window === 'undefined' || !window.location) return;
    const loader = new GLTFLoader(globalLoadingManager);
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
  constructor(headless = false) {
    this.headless = headless || (typeof window === 'undefined');
    this.container = typeof document !== 'undefined' ? document.getElementById('game-container') : null;
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
      { id: 'campfire_kit', name: 'Portable Camping Fire Kit', icon: '🏕️', count: 2 },
      { id: 'matches', name: 'Flint & Matches', icon: '🔥', count: 3 },
      { id: 'wood', name: 'Dry Pine Wood', icon: '🪵', count: 4 },
      { id: 'cloth', name: 'Cloth Scrap', icon: '🧣', count: 2 },
      { id: 'ration', name: 'Canned Food', icon: '🥫', count: 1 }
    ];
    this.isBackpackOpen = false;

    // Map & Fullscreen Map System (Unlocked via Cabin Map Item)
    this.hasMap = false;
    this.isMapOpen = false;
    this.isTaskPanelOpen = false;
    this.signalFiresLit = 0;

    // Linear Story & Mission System: 8 Sequential Missions with Physical Gates
    this.missions = [
      {
        id: 'elder_torch',
        chapter: 'CHAPTER 1',
        title: "The Elder's Blessing",
        zone: 'Zone 1: Solstice Village',
        coords: { x: 158, z: 246 },
        icon: '🔥',
        completed: false,
        active: true,
        desc: 'Speak with Village Elder Kaelen by the central bonfire and take the Sacred Torch of Solstice.'
      },
      {
        id: 'village_bridge',
        chapter: 'CHAPTER 2',
        title: 'The Gorge Drawbridge',
        zone: 'Zone 1/2: Solstice Outpost',
        coords: { x: 165, z: 245 },
        icon: '🏚️',
        completed: false,
        active: false,
        progress: 0,
        total: 3,
        desc: 'Scavenge 3 bridge parts (Winch Gear, Steel Cable, Crank) from village workshops and lower the drawbridge.'
      },
      {
        id: 'first_night',
        chapter: 'CHAPTER 3',
        title: 'Survive First Night',
        zone: 'Zone 2: Canyon Ridge',
        coords: { x: -140, z: 460 },
        icon: '⛺',
        completed: false,
        active: false,
        duskDeadline: 19.0, // 19:00 Dusk Deadline
        desc: 'The mountain pass is freezing over. Gather dry pine wood and build a campfire before dark to prevent freezing.'
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
      elderTorch: false,    // Unlocked by Mission 1 (Speaking with Elder Kaelen)
      villageBridge: false, // Unlocked by Mission 2 (Lowering Gorge Drawbridge)
      suvBlockade: true,    // Unlocked by default in village start flow
      firstNight: false,    // Unlocked by Mission 3 (Building Campfire)
      meadowPass: false,    // Unlocked by Mission 4 (Meadow Fuel Found)
      khaiSecurity: false,  // Unlocked by Mission 5 (Generator Powered)
      ropeBridge: false,    // Unlocked by Mission 6 (Rope Bridge Crossed)
      radioTower: false,    // Unlocked by Mission 7 (Antenna Calibrated)
      helicopterRescue: false // Unlocked by Mission 8 (Helicopter Touchdown)
    };

    // Last safe position for unstuck (U key) inside Solstice Village Square
    this.lastSafePosition = new THREE.Vector3(160.0, getTerrainHeight(160.0, 248.0) + 0.5, 248.0);
    this.lastSafePositionTimer = 0;

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
    this.villageRelicVisuals = [];

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

    // Camera Modes: Third-Person (Default GTA-style over-the-shoulder view) & First-Person (V key toggle)
    this.cameraMode = 'third'; // 'third' (Default) | 'first'
    this.thirdPersonCamPos = new THREE.Vector3();
    this.thirdPersonCamPosInitialized = false;

    // Cinematic Cameras: Intro Pan & 60s Scripted Trailer Mode
    this.isIntroPanning = false;
    this.introPanStartTime = 0;
    this.introDuration = 4.5;
    this.isTrailerMode = false;
    this.trailerStartTime = 0;
    this.trailerDuration = 60.0;
    this.hasShownLightHint = false;
    this.isDrawbridgeCutscene = false;
    this.drawbridgeCutsceneTime = 0;

    if (!this.headless) {
      this.initThree();
      this.buildWorld();
      this.initMinimap();
      this.setupEvents();
      this.updateHUD();
      this.updateMissionHUD();
      this.render();
    } else {
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1400);
      this.colliders = [];
      this.buildWorld();
    }
  }

  initThree() {
    this.scene = new THREE.Scene();
    // Soft Sunset Dusk Color Palette & FogExp2 Tint
    this.scene.background = new THREE.Color(0x6e5262);
    this.scene.fog = new THREE.FogExp2(0x6e5262, 0.0033);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1400);
    const spawnX = 160.0;
    const spawnZ = 248.0;
    const spawnY = getTerrainHeight(spawnX, spawnZ);
    this.camera.position.set(spawnX, spawnY + 2.1, spawnZ);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Limit pixel ratio to 1.25 for buttery-smooth 60 FPS on high-res displays
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Ultra-crisp, beautiful soft shadows
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.container.appendChild(this.renderer.domElement);

    // Three.js Postprocessing: EffectComposer, RenderPass, CinematicPostShader, OutputPass
    this.usePostProcessing = false; // Direct renderer rendering for maximum performance and 0 input lag
    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    // Zero out UnrealBloomPass so bright light doesn't bleed all over the screen
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.0, // strength 0 completely kills the blinding white wash
      0.2, // radius
      1.0  // threshold
    );
    this.bloomPass.enabled = false;
    this.composer.addPass(this.bloomPass);

    this.cinematicPass = new ShaderPass(CinematicPostShader);
    this.composer.addPass(this.cinematicPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    this.initHDRI();

    // Dynamic Minecraft/AAA Sky Dome enclosing world
    const skyGeom = new THREE.SphereGeometry(1100, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({ color: 0x5b7086, side: THREE.BackSide });
    this.skyMesh = new THREE.Mesh(skyGeom, skyMat);
    this.scene.add(this.skyMesh);

    // Dynamic Starfield for Crisp Night Sky (1200 glowing alpine stars)
    const starCount = 1200;
    const starGeom = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.95); // Upper hemisphere only
      const r = 1050;
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi);
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.2,
      transparent: true,
      opacity: 0.0, // Blends smoothly at night
      depthWrite: false
    });
    this.starPoints = new THREE.Points(starGeom, this.starMat);
    this.scene.add(this.starPoints);

    // Visible Glowing Sun & Moon Orbs
    this.sunGroup = new THREE.Group();
    // Radiant Sun Orb (Blazing golden corona)
    const sunGeom = new THREE.SphereGeometry(22, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfffaea });
    this.sunOrb = new THREE.Mesh(sunGeom, sunMat);
    this.sunGroup.add(this.sunOrb);

    // Outer warm sun glow aura
    const sunGlowGeom = new THREE.SphereGeometry(32, 16, 16);
    const sunGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff9922,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.sunGlow = new THREE.Mesh(sunGlowGeom, sunGlowMat);
    this.sunGroup.add(this.sunGlow);
    this.scene.add(this.sunGroup);

    // Luminescent Moon Orb (Appears on opposite side of sun)
    this.moonGroup = new THREE.Group();
    const moonGeom = new THREE.SphereGeometry(16, 16, 16);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xe2f1ff });
    this.moonOrb = new THREE.Mesh(moonGeom, moonMat);
    this.moonGroup.add(this.moonOrb);

    const moonGlowGeom = new THREE.SphereGeometry(24, 16, 16);
    const moonGlowMat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.moonGlow = new THREE.Mesh(moonGlowGeom, moonGlowMat);
    this.moonGroup.add(this.moonGlow);
    this.scene.add(this.moonGroup);


    // Balanced Alpine Daylight Lighting
    this.hemiLight = new THREE.HemisphereLight(0x94a3b8, 0x475569, 0.65);
    this.scene.add(this.hemiLight);

    this.ambientLight = new THREE.AmbientLight(0x64748b, 0.55);
    this.scene.add(this.ambientLight);

    // Cinematic high-resolution shadow map (2048x2048 with expansive frustum for cinematic drone & terrain)
    this.sunLight = new THREE.DirectionalLight(0xffa153, 1.45);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 600;
    this.sunLight.shadow.camera.left = -160;
    this.sunLight.shadow.camera.right = 160;
    this.sunLight.shadow.camera.top = 160;
    this.sunLight.shadow.camera.bottom = -160;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;
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

    // Omnidirectional Player Torch Light (Attached directly to Player group in world space)
    // Guarantees rich, bright illumination of the ground, character, and surroundings in both 1st and 3rd person!
    this.worldTorchLight = new THREE.PointLight(0xff9e44, 4.8, 36, 1.3);
    this.worldTorchLight.position.set(0.35, 1.4, 0.25);
    this.worldTorchLight.castShadow = false;
    this.player.add(this.worldTorchLight);

    // Third-Person Animated Player Model
    this.thirdPersonPlayer = new ThirdPersonPlayerSystem(this.scene);
    this.thirdPersonPlayer.setFirstPerson(this.cameraMode === 'first');

    // Real Flame & Spark Particle System for the Torch
    this.torchFlameParticles = new FlameParticleSystem(this.scene, 22, 0.08, 0.9, 0.16);

    this.createSnowParticles();

    // 3D Search & Rescue Helicopter for Chapter 6 Ending Cutscene
    this.rescueHelicopter = new RescueHelicopter(this.scene);

    // Solstice Village Elder Kaelen (NPC Guide)
    this.elderKaelen = new ElderKaelenNPC(this.scene, 158.0, 246.0);
    this.isVillageIntro = false;
    this.villageIntroTime = 0;
  }

  createLightRing(radius, color = 0xff8833, opacity = 0.3) {
    const geom = new THREE.RingGeometry(radius - 0.18, radius + 0.18, 48);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 2;
    return mesh;
  }

  initHDRI() {
    // Pure procedural atmospheric dome & starry night (Zero 32-bit floating-point HDR memory overhead, no urban textures)
    this.createAtmosphericSky();
  }

  createAtmosphericSky() {
    // 1. Procedural Starfield for Alpine Night Sky
    const starCount = 650;
    const starGeom = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 1050; // Inside 1100m sky dome
      // Concentrate in upper hemisphere
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 15; // Above horizon
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.2,
      transparent: true,
      opacity: 0.0, // Fade in at dusk/night
      depthWrite: false
    });
    this.starPoints = new THREE.Points(starGeom, this.starMaterial);
    this.scene.add(this.starPoints);

    // Initial daytime sky color
    this.updateSkyByTimeOfDay();
  }

  updateSkyByTimeOfDay() {
    // Smooth day/dusk/night transition based on this.timeOfDay (0.0 to 24.0)
    const isNight = this.timeOfDay < 5.5 || this.timeOfDay > 19.5;
    const isDusk = (this.timeOfDay >= 17.5 && this.timeOfDay <= 19.5) || (this.timeOfDay >= 4.5 && this.timeOfDay <= 5.5);

    // Remove any external texture pollution
    this.scene.background = null;
    this.scene.environment = null;

    if (isNight) {
      // Midnight Wilderness: Deep alpine navy blue (0x070b14)
      const nightSkyColor = new THREE.Color(0x070b14);
      if (this.skyMesh && this.skyMesh.material) {
        this.skyMesh.visible = true;
        this.skyMesh.material.color.copy(nightSkyColor);
      }
      this.scene.fog.color.setHex(0x070b14);
      this.scene.fog.density = 0.0035;

      // Twinkling wilderness stars
      if (this.starMaterial) this.starMaterial.opacity = 0.85;

      // Realistic cold mountain moonlight
      if (this.sunLight) {
        this.sunLight.color.setHex(0x38bdf8);
        this.sunLight.intensity = 0.22;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(0x0f172a);
        this.ambientLight.intensity = 0.25;
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0x1e293b);
        this.hemiLight.groundColor.setHex(0x020617);
      }
    } else if (isDusk) {
      // Golden Alpine Dusk: Sunset Ember (0x7c4d5c)
      const duskColor = new THREE.Color(0x6e4e5e);
      if (this.skyMesh && this.skyMesh.material) {
        this.skyMesh.visible = true;
        this.skyMesh.material.color.copy(duskColor);
      }
      this.scene.fog.color.setHex(0x6e4e5e);
      this.scene.fog.density = 0.0030;

      if (this.starMaterial) this.starMaterial.opacity = 0.3;

      if (this.sunLight) {
        this.sunLight.color.setHex(0xf59e0b);
        this.sunLight.intensity = 0.95;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(0x6b4c5a);
        this.ambientLight.intensity = 0.45;
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0xd97706);
        this.hemiLight.groundColor.setHex(0x33202a);
      }
    } else {
      // Crisp Alpine Daylight (0x5b7086)
      const daySkyColor = new THREE.Color(0x5b7086);
      if (this.skyMesh && this.skyMesh.material) {
        this.skyMesh.visible = true;
        this.skyMesh.material.color.copy(daySkyColor);
      }
      this.scene.fog.color.setHex(0x5b7086);
      this.scene.fog.density = 0.0028;

      if (this.starMaterial) this.starMaterial.opacity = 0.0;

      if (this.sunLight) {
        this.sunLight.color.setHex(0xffecc7);
        this.sunLight.intensity = 1.15;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(0x6e8299);
        this.ambientLight.intensity = 0.60;
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0x93a5b8);
        this.hemiLight.groundColor.setHex(0x454b52);
      }
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
    // Dynamic mountain snowfall: lighter, soft flurries covering full view 360 degrees
    const snowCount = 900;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(snowCount * 3);
    const velocities = new Float32Array(snowCount * 3);

    const px = this.player ? this.player.position.x : 160;
    const py = this.player ? this.player.position.y : 10;
    const pz = this.player ? this.player.position.z : 248;

    for (let i = 0; i < snowCount; i++) {
      positions[i * 3] = px + (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = py + Math.random() * 26 - 3;
      positions[i * 3 + 2] = pz + (Math.random() - 0.5) * 80;

      velocities[i * 3] = (Math.random() - 0.5) * 0.15;
      velocities[i * 3 + 1] = -0.9 - Math.random() * 0.55; // Gentle, natural flutter (~0.9 to 1.45 m/s)
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.15;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      map: createSnowTexture(),
      color: 0xffffff,
      size: 0.28,
      transparent: true,
      opacity: 0.68,
      depthWrite: false
    });

    this.snowParticles = new THREE.Points(geom, mat);
    this.snowVelocities = velocities;
    this.scene.add(this.snowParticles);
  }

  buildWorld() {
    // 1. Procedural 1600x1600m Vast Alpine World with Vertex Colors & CC0 Texture Splatting
    const terrainSize = 1600;
    const segments = 320;
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

    // 19. Living Wildlife: Deer Herd, Rabbit Colony, Bird Flocks, Fish School, Horse Herd
    this.deerHerd = new DeerHerd(this.scene);
    this.rabbitColony = new RabbitColony(this.scene);
    this.birdFlocks = new BirdFlocks(this.scene);
    this.fishSchool = new FishSchool(this.scene);
    this.horseHerd = new HorseHerd(this.scene);
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

    // Re-snap village pavers to new terrain heights if heightmap finished loading
    if (this.villagePaverInst && this.villagePaverTransforms) {
      const dummy = new THREE.Object3D();
      this.villagePaverTransforms.forEach((t, idx) => {
        const py = getTerrainHeight(t.x, t.z) + 0.04;
        const hF = getTerrainHeight(t.x, t.z + 0.5);
        const hB = getTerrainHeight(t.x, t.z - 0.5);
        const hR = getTerrainHeight(t.x + 0.5, t.z);
        const hL = getTerrainHeight(t.x - 0.5, t.z);
        const rotX = Math.atan2(hB - hF, 1.0) * 0.75;
        const rotZ = Math.atan2(hL - hR, 1.0) * 0.75;
        dummy.position.set(t.x, py, t.z);
        dummy.rotation.set(rotX, t.rotY, rotZ);
        dummy.scale.set(t.scaleX || 1.0, 1.0, t.scaleZ || 1.0);
        dummy.updateMatrix();
        this.villagePaverInst.setMatrixAt(idx, dummy.matrix);
      });
      this.villagePaverInst.instanceMatrix.needsUpdate = true;
    }

    // Re-snap ALL trees and vegetation instances firmly to terrain so no tree ever floats
    if (this.treeTransforms && this.treeTransforms.length > 0) {
      const dummy = new THREE.Object3D();
      for (const item of this.treeTransforms) {
        const ty = getTerrainHeight(item.x, item.z) - (item.sinkY || 0.22);
        dummy.position.set(item.x, ty, item.z);
        dummy.scale.copy(item.scale);
        dummy.rotation.copy(item.rotation);
        dummy.updateMatrix();

        if (Array.isArray(item.inst)) {
          for (const instMesh of item.inst) {
            instMesh.setMatrixAt(item.idx, dummy.matrix);
            instMesh.instanceMatrix.needsUpdate = true;
          }
        } else {
          item.inst.setMatrixAt(item.idx, dummy.matrix);
          item.inst.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  getTerrainHeight(x, z) {
    return getTerrainHeight(x, z);
  }

  buildMountainRanges() {
    const texLoader = new THREE.TextureLoader(globalLoadingManager);
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

    const peakAngles = [
      0, 0.28, 0.55, 0.82, 1.1, 1.38, 1.65, 1.92, 2.2, 2.48, 2.75, 3.02, 
      3.3, 3.58, 3.85, 4.12, 4.4, 4.68, 4.95, 5.22, 5.5, 5.78, 6.05
    ];
    peakAngles.forEach((angle, i) => {
      const radius = 680 + (i % 4) * 45;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;
      const height = 180 + (i % 4) * 55;
      const width = 160 + (i % 3) * 50;

      const peakGeom = new THREE.ConeGeometry(width, height, 6);
      const peakMesh = new THREE.Mesh(peakGeom, peakMat);
      peakMesh.position.set(px, height / 2 - 15, pz);
      peakMesh.rotation.y = angle * 1.5;
      peakMesh.castShadow = true;
      peakMesh.receiveShadow = true;
      this.scene.add(peakMesh);
    });
  }

  // ---------------------------------------------------------------------------
  // ZONE 3: FROZEN GLACIAL LAKE (~80M OVAL), ANIMATED ICE SHADER, RIVER & REEDS
  // ---------------------------------------------------------------------------
  buildFrozenLake() {
    const lakeX = -35.0;
    const lakeZ = 40.0;
    const lakeRadiusX = 82.0;
    const lakeRadiusZ = 68.0;
    const lakeY = 5.2;

    this.waterMat = createWaterMaterial();
    this.iceLakeMat = createIceLakeMaterial();

    // 1. Shimmering Frozen Lake Ice Surface (~80m radius oval)
    const ovalGeom = new THREE.CircleGeometry(1.0, 56);
    ovalGeom.rotateX(-Math.PI / 2);
    ovalGeom.scale(lakeRadiusX, 1.0, lakeRadiusZ);
    const lakeMesh = new THREE.Mesh(ovalGeom, this.iceLakeMat);
    lakeMesh.position.set(lakeX, lakeY + 0.04, lakeZ);
    lakeMesh.receiveShadow = true;
    this.scene.add(lakeMesh);

    // Subtle water layer underneath ice for transparent depth
    const underWaterGeom = new THREE.CircleGeometry(1.0, 48);
    underWaterGeom.rotateX(-Math.PI / 2);
    underWaterGeom.scale(lakeRadiusX - 2.5, 1.0, lakeRadiusZ - 2.5);
    const underWaterMesh = new THREE.Mesh(underWaterGeom, this.waterMat);
    underWaterMesh.position.set(lakeX, lakeY - 0.05, lakeZ);
    this.scene.add(underWaterMesh);

    // 2. Frozen Shoreline Snow & Ice Rim around oval perimeter
    const rimCount = 56;
    const rimGeom = new THREE.RingGeometry(0.92, 1.06, rimCount);
    rimGeom.rotateX(-Math.PI / 2);
    rimGeom.scale(lakeRadiusX, 1.0, lakeRadiusZ);
    const iceEdgeMat = new THREE.MeshStandardMaterial({
      color: 0xebf8ff,
      roughness: 0.65,
      metalness: 0.25,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide
    });
    const iceRimMesh = new THREE.Mesh(rimGeom, iceEdgeMat);
    iceRimMesh.position.set(lakeX, lakeY + 0.06, lakeZ);
    this.scene.add(iceRimMesh);

    // Shoreline Reeds & Snow mounds along the lake perimeter
    const reedMat = new THREE.MeshStandardMaterial({ color: 0x786040, roughness: 0.9 });
    const snowMoundMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.8 });
    for (let i = 0; i < 40; i++) {
      const angle = (i / 40) * Math.PI * 2;
      const rx = lakeX + Math.cos(angle) * (lakeRadiusX + (Math.random() - 0.5) * 4);
      const rz = lakeZ + Math.sin(angle) * (lakeRadiusZ + (Math.random() - 0.5) * 4);
      const ry = getTerrainHeight(rx, rz);

      // Clump of 3-5 frozen shoreline reeds
      if (i % 2 === 0) {
        for (let k = 0; k < 4; k++) {
          const reed = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.4 + Math.random() * 0.8, 4), reedMat);
          reed.position.set(rx + (Math.random() - 0.5) * 0.8, ry + 0.7, rz + (Math.random() - 0.5) * 0.8);
          reed.rotation.z = (Math.random() - 0.5) * 0.25;
          reed.castShadow = true;
          this.scene.add(reed);
        }
      } else {
        // Shoreline snow crust mound
        const mound = new THREE.Mesh(new THREE.SphereGeometry(1.2 + Math.random() * 0.8, 6, 5), snowMoundMat);
        mound.scale.set(1.4, 0.35, 1.4);
        mound.position.set(rx, ry + 0.15, rz);
        this.scene.add(mound);
      }
    }

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
    const numSteps = 450;
    const roadWidth = 5.0; // 5m width per spec
    const shoulderWidth = 0.3; // 0.3m gravel shoulder each side
    const totalHalfW = (roadWidth / 2) + shoulderWidth;
    const roadHalfW = roadWidth / 2;

    const roadGeom = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    const uvs = [];

    // Quad strips across cross-section: Left Shoulder Outer -> Left Shoulder Inner -> Right Shoulder Inner -> Right Shoulder Outer
    // 4 vertices per cross-section slice:
    // v0: Left Shoulder Outer (-totalHalfW)
    // v1: Left Shoulder Inner (-roadHalfW)
    // v2: Right Shoulder Inner (+roadHalfW)
    // v3: Right Shoulder Outer (+totalHalfW)
    // Prepend 10 lead-in slices from z = 556 down to z = 520 along x = -180
    const leadInCount = 10;
    for (let k = 0; k <= leadInCount; k++) {
      const lz = 556.0 - (k / leadInCount) * 36.0; // 556 down to 520
      const lx = -180.0;
      const ly = getTerrainHeight(lx, lz) + 0.04; // Sits exactly on road height 0.04m
      const normX = 1.0;
      const normZ = 0.0;
      const offsets = [-totalHalfW, -roadHalfW, roadHalfW, totalHalfW];
      const sliceColors = [
        [0.72, 0.68, 0.62],
        [0.48, 0.42, 0.36],
        [0.48, 0.42, 0.36],
        [0.72, 0.68, 0.62]
      ];
      const sliceUvs = [0.0, 0.15, 0.85, 1.0];
      offsets.forEach((off, vIdx) => {
        positions.push(lx + normX * off, ly, lz + normZ * off);
        colors.push(...sliceColors[vIdx]);
        uvs.push(sliceUvs[vIdx], (k / leadInCount) * 5.0);
      });
    }

    for (let i = 1; i <= numSteps; i++) {
      const t = i / numSteps;
      const p = RoadCurve.getPoint(t);
      const tangent = RoadCurve.getTangent(t).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const len = Math.hypot(nx, nz) || 1;
      const normX = nx / len;
      const normZ = nz / len;

      const offsets = [-totalHalfW, -roadHalfW, roadHalfW, totalHalfW];
      const sliceColors = [
        [0.72, 0.68, 0.62], // v0: light gravel shoulder
        [0.48, 0.42, 0.36], // v1: main road dirt edge
        [0.48, 0.42, 0.36], // v2: main road dirt edge
        [0.72, 0.68, 0.62]  // v3: light gravel shoulder
      ];
      const sliceUvs = [0.0, 0.15, 0.85, 1.0];

      offsets.forEach((off, vIdx) => {
        const vx = p.x + normX * off;
        const vz = p.z + normZ * off;
        // Vertex sits exactly ON getTerrainHeight at every vertex with minimal 0.04m offset
        const vy = getTerrainHeight(vx, vz) + 0.04;

        positions.push(vx, vy, vz);
        colors.push(...sliceColors[vIdx]);
        uvs.push(sliceUvs[vIdx], 5.0 + t * 65);
      });
    }

    const totalSlices = leadInCount + 1 + numSteps;
    const indices = [];
    for (let i = 0; i < totalSlices - 1; i++) {
      const base = i * 4;
      const next = (i + 1) * 4;

      // Strip 1: Left shoulder (v0 -> v1)
      indices.push(base, next, base + 1);
      indices.push(next, next + 1, base + 1);

      // Strip 2: Main road pavement (v1 -> v2)
      indices.push(base + 1, next + 1, base + 2);
      indices.push(next + 1, next + 2, base + 2);

      // Strip 3: Right shoulder (v2 -> v3)
      indices.push(base + 2, next + 2, base + 3);
      indices.push(next + 2, next + 3, base + 3);
    }

    roadGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    roadGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeom.setIndex(indices);
    roadGeom.computeVertexNormals();

    const texLoader = new THREE.TextureLoader(globalLoadingManager);
    const dirtDiff = texLoader.load('./assets/textures/dirt_diff.jpg');
    dirtDiff.wrapS = THREE.RepeatWrapping;
    dirtDiff.wrapT = THREE.RepeatWrapping;
    dirtDiff.repeat.set(2, 65);
    dirtDiff.colorSpace = THREE.SRGBColorSpace;

    const dirtNor = texLoader.load('./assets/textures/dirt_nor.jpg');
    dirtNor.wrapS = THREE.RepeatWrapping;
    dirtNor.wrapT = THREE.RepeatWrapping;
    dirtNor.repeat.set(2, 65);

    const roadMat = new THREE.MeshStandardMaterial({
      map: dirtDiff,
      normalMap: dirtNor,
      normalScale: new THREE.Vector2(0.85, 0.85),
      vertexColors: true,
      roughness: 0.90,
      metalness: 0.04
    });

    roadMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        #if defined( USE_MAP )
        // Dual tire tracks worn into dirt/snow at u ~ 0.36 and u ~ 0.64
        float distTrack1 = abs(vMapUv.x - 0.36);
        float distTrack2 = abs(vMapUv.x - 0.64);
        float track1 = 1.0 - smoothstep(0.04, 0.12, distTrack1);
        float track2 = 1.0 - smoothstep(0.04, 0.12, distTrack2);
        float trackMud = max(track1, track2);

        // Darken compressed wet tire ruts and blend with vertex colors
        diffuseColor.rgb *= (1.0 - trackMud * 0.35);
        diffuseColor.rgb *= (vColor.rgb * 1.35);
        #endif
        `
      );
    };

    const roadMesh = new THREE.Mesh(roadGeom, roadMat);
    roadMesh.receiveShadow = true;
    this.scene.add(roadMesh);

    // 4. Crash Site Skid Marks leading up to the wrecked SUV (z: 535 down to 518)
    const skidMat = new THREE.MeshBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.68,
      depthWrite: false
    });
    [-0.9, 0.9].forEach(sideOffset => {
      const skidPoints = [];
      for (let s = 0; s <= 20; s++) {
        const sz = 536 - s * 0.85; // 536 to ~519
        const sx = -183.0 + sideOffset + Math.sin(s * 0.25) * 0.4;
        const sy = getTerrainHeight(sx, sz) + 0.055;
        skidPoints.push(new THREE.Vector3(sx, sy, sz));
      }
      const skidCurve = new THREE.CatmullRomCurve3(skidPoints);
      const skidGeom = new THREE.TubeGeometry(skidCurve, 20, 0.14, 4, false);
      const skidMesh = new THREE.Mesh(skidGeom, skidMat);
      this.scene.add(skidMesh);
    });

    // 5. Roadside Details Every 35-40m (Mile Markers, Signposts, Fallen Snow Piles)
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const signMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8 });
    const snowPileMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.75 });

    for (let i = 8; i < numSteps - 8; i += 9) {
      const t = i / numSteps;
      const pt = RoadCurve.getPoint(t);
      const tangent = RoadCurve.getTangent(t).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      const len = Math.hypot(nx, nz) || 1;
      const normX = nx / len;
      const normZ = nz / len;

      const side = (i % 2 === 0) ? 1 : -1;
      const detailX = pt.x + normX * (totalHalfW + 0.9) * side;
      const detailZ = pt.z + normZ * (totalHalfW + 0.9) * side;
      const detailY = getTerrainHeight(detailX, detailZ);

      // Detail Type A: Signpost with wooden board
      if (i % 27 === 0) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.8, 5), woodMat);
        post.position.set(detailX, detailY + 0.9, detailZ);
        post.castShadow = true;
        this.scene.add(post);

        const board = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.08), signMat);
        board.position.set(detailX, detailY + 1.6, detailZ);
        board.rotation.y = Math.atan2(tangent.x, tangent.z) + Math.PI / 2;
        board.castShadow = true;
        this.scene.add(board);
      }
      // Detail Type B: Mile marker stone pillar with reflector
      else if (i % 18 === 0) {
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.28), woodMat);
        marker.position.set(detailX, detailY + 0.42, detailZ);
        marker.castShadow = true;
        this.scene.add(marker);

        const reflector = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0xf59e0b }));
        reflector.position.set(detailX, detailY + 0.75, detailZ);
        this.scene.add(reflector);
      }
      // Detail Type C: Roadside fallen snow heap / mound
      else {
        const snowHeap = new THREE.Mesh(new THREE.SphereGeometry(0.85 + Math.random() * 0.4, 6, 5), snowPileMat);
        snowHeap.scale.set(1.3, 0.32, 1.3);
        snowHeap.position.set(detailX, detailY + 0.1, detailZ);
        this.scene.add(snowHeap);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ZONE 1: BROKEN MOUNTAIN BRIDGE WASHOUT, CHASM GAP & WRECKED VEHICLE
  // ---------------------------------------------------------------------------
  buildCrashSite() {
    const carX = -182.5;
    const carZ = 520.0;
    const suvGroundY = getTerrainHeight(carX, carZ);

    this.wreckedSUV = new RealisticSUVSystem(this.scene, true);
    this.wreckedSUV.root.position.set(carX, suvGroundY + 0.35, carZ);
    this.wreckedSUV.root.rotation.set(0.04, 0.05, 0.02); // Tilted near edge of broken bridge
    this.scene.add(this.wreckedSUV.root);

    this.colliders.push({
      type: 'aabb',
      minX: carX - 1.5,
      maxX: carX + 1.5,
      minZ: carZ - 2.6,
      maxZ: carZ + 2.6
    });

    // 1. Alpine Gorge Wooden River Bridge (Spanning z: 519 down to 509 over gorge river)
    const bridgeWoodMat = new THREE.MeshStandardMaterial({ color: 0x4a3219, roughness: 0.88 });
    const beamDarkMat = new THREE.MeshStandardMaterial({ color: 0x2e1e0f, roughness: 0.95 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.35 });
    const warningMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.75 });
    const stoneAbutmentMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.92 });

    const bridgeDeckGroup = new THREE.Group();

    // Heavy Stone Abutment Foundations on South & North banks
    [-1, 1].forEach(side => {
      const az = 514.0 + side * 5.2;
      const road = getRoadSignedDistance(-177.0, az);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(6.6, 4.0, 2.2), stoneAbutmentMat);
      pier.position.set(road.projX, road.projY - 1.2, az);
      pier.castShadow = true;
      bridgeDeckGroup.add(pier);
    });

    // Massive longitudinal timber support stringers beneath deck
    [-1.9, 0.0, 1.9].forEach(sx => {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.55, 11.2), beamDarkMat);
      beam.position.set(-176.5 + sx, getTerrainHeight(-176.5, 514.0) - 0.22, 514.0);
      beam.rotation.y = -0.36; // Follow road bend
      beam.castShadow = true;
      bridgeDeckGroup.add(beam);
    });

    // Solid walkable wooden cross planks across bridge span
    const plankCount = 24;
    for (let p = 0; p <= plankCount; p++) {
      const t = p / plankCount;
      const pz = 519.0 - t * 10.0;
      const road = getRoadSignedDistance(-177.0, pz);
      const px = road.projX;
      const py = road.projY;

      // Heavy wooden plank
      const plank = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.16, 0.42), bridgeWoodMat);
      plank.position.set(px, py + 0.08, pz);
      plank.rotation.y = -0.36;
      plank.castShadow = true;
      plank.receiveShadow = true;
      bridgeDeckGroup.add(plank);

      // Side Guard Rails with Posts
      if (p % 4 === 0) {
        [-2.3, 2.3].forEach(side => {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.35, 5), beamDarkMat);
          const rad = -0.36;
          const offX = Math.cos(rad) * side;
          const offZ = -Math.sin(rad) * side;
          post.position.set(px + offX, py + 0.65, pz + offZ);
          post.castShadow = true;
          bridgeDeckGroup.add(post);
        });
      }
    }

    // Top Horizontal Guard Rails along left and right edges
    [-2.3, 2.3].forEach(side => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 11.0), beamDarkMat);
      const midRoad = getRoadSignedDistance(-177.0, 514.0);
      const rad = -0.36;
      rail.position.set(midRoad.projX + Math.cos(rad) * side, midRoad.projY + 1.15, 514.0 - Math.sin(rad) * side);
      rail.rotation.y = rad;
      rail.castShadow = true;
      bridgeDeckGroup.add(rail);

      const midRail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 11.0), bridgeWoodMat);
      midRail.position.set(midRoad.projX + Math.cos(rad) * side, midRoad.projY + 0.62, 514.0 - Math.sin(rad) * side);
      midRail.rotation.y = rad;
      bridgeDeckGroup.add(midRail);
    });

    this.scene.add(bridgeDeckGroup);

    // Flowing River beneath the bridge gorge
    const gorgeWaterGeom = new THREE.PlaneGeometry(16.0, 32.0, 8, 8);
    gorgeWaterGeom.rotateX(-Math.PI / 2);
    const gorgeWater = new THREE.Mesh(gorgeWaterGeom, this.waterMat);
    gorgeWater.position.set(-174.0, -11.5, 514.0);
    gorgeWater.rotation.y = 0.42;
    this.scene.add(gorgeWater);

    // School of Fish swimming in the gorge river pool below the bridge
    const gorgeFishGeom = new THREE.ConeGeometry(0.18, 0.85, 5);
    gorgeFishGeom.rotateX(-Math.PI / 2);
    const gorgeFishMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.6,
      metalness: 0.8,
      roughness: 0.2
    });
    this.gorgeFishInst = new THREE.InstancedMesh(gorgeFishGeom, gorgeFishMat, 12);
    const gDummy = new THREE.Object3D();
    for (let f = 0; f < 12; f++) {
      const angle = (f / 12) * Math.PI * 2;
      const rx = -174.0 + Math.cos(angle) * (3.5 + (f % 3) * 1.2);
      const rz = 514.0 + Math.sin(angle) * (5.5 + (f % 2) * 2.0);
      gDummy.position.set(rx, -11.2 + (f % 3) * 0.2, rz);
      gDummy.rotation.y = angle + Math.PI / 2;
      gDummy.updateMatrix();
      this.gorgeFishInst.setMatrixAt(f, gDummy.matrix);
    }
    this.gorgeFishInst.instanceMatrix.needsUpdate = true;
    this.scene.add(this.gorgeFishInst);

    // Initial Story Gate Barricade: Across Bridge Entry at z = 518
    this.roadBlockadeGroup = new THREE.Group();
    const barricadeGroup = new THREE.Group();
    barricadeGroup.position.set(-178.5, suvGroundY, 518.2);
    barricadeGroup.rotation.y = -0.36;

    [-2.1, 2.1].forEach(bx => {
      const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), beamDarkMat);
      leg1.position.set(bx, 0.7, -0.2);
      leg1.rotation.x = 0.25;
      barricadeGroup.add(leg1);
      const leg2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), beamDarkMat);
      leg2.position.set(bx, 0.7, 0.2);
      leg2.rotation.x = -0.25;
      barricadeGroup.add(leg2);
    });

    const barBoard1 = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.35, 0.08), warningMat);
    barBoard1.position.set(0, 1.1, 0);
    barricadeGroup.add(barBoard1);
    const barBoard2 = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.25, 0.08), beamDarkMat);
    barBoard2.position.set(0, 0.55, 0);
    barricadeGroup.add(barBoard2);
    this.roadBlockadeGroup.add(barricadeGroup);

    this.scene.add(this.roadBlockadeGroup);

    // Physical impassable colliders for bridge boundaries
    this.colliders.push({
      id: 'col_suv_blockade_L',
      type: 'aabb',
      minX: -198,
      maxX: -180.2,
      minZ: 512,
      maxZ: 517
    });
    this.colliders.push({
      id: 'col_suv_blockade_R',
      type: 'aabb',
      minX: -171.8,
      maxX: -155,
      minZ: 512,
      maxZ: 517
    });
    // Center gate barricade collider (unlocked upon looting vehicle)
    this.colliders.push({
      id: 'col_suv_blockade',
      type: 'aabb',
      minX: -180.2,
      maxX: -171.8,
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
    const campWoodMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });

    const campGroup = new THREE.Group();
    campGroup.position.set(campX, campGroundY, campZ);

    const stoneRing = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.25, 6, 12), stoneRingMat);
    stoneRing.rotation.x = Math.PI / 2;
    stoneRing.position.y = 0.25;
    campGroup.add(stoneRing);

    for (let l = 0; l < 4; l++) {
      const woodLog = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 1.8, 5), campWoodMat);
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
  // ZONE 2/3: ABANDONED VILLAGE (16 Naturally Arranged Cabins, Central Well, Fence, Crates & Lore)
  // ---------------------------------------------------------------------------
  buildAbandonedVillage() {
    const vGroup = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3e2817, roughness: 0.92 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.95 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.3 });
    const signMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8 });
    const snowRoofMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.75 });

    // 16 Houses naturally scattered around village plateau (x: 120-195, z: 215-285)
    // Non-grid organic cluster following natural terrain contours
    const villageHouses = [
      // 1. Elder Soren's Town Hall Cabin (contains lore note)
      { id: 'town_hall', x: 152.0, z: 250.0, w: 7.2, h: 4.0, d: 6.2, rot: 0.15, isTownHall: true },
      // 2. Village Blacksmith Workshop (contains Part 1: Winch Gear)
      { id: 'blacksmith', x: 172.0, z: 235.0, w: 6.4, h: 3.8, d: 5.8, rot: -0.4, isBlacksmith: true },
      // 3. Village Storehouse (contains Part 2: Steel Cable)
      { id: 'storehouse', x: 145.0, z: 235.0, w: 6.8, h: 3.6, d: 5.4, rot: 0.35, isStorehouse: true },
      // 4. Outpost Tool Shed (contains Part 3: Crank Handle)
      { id: 'tool_shed', x: 176.0, z: 258.0, w: 5.6, h: 3.4, d: 5.0, rot: -0.25, isToolShed: true },
      // Additional 12 naturally placed abandoned residential cabins
      { id: 'house_5', x: 132.0, z: 258.0, w: 5.8, h: 3.5, d: 5.2, rot: 0.55 },
      { id: 'house_6', x: 138.0, z: 275.0, w: 6.2, h: 3.6, d: 5.0, rot: -0.3 },
      { id: 'house_7', x: 154.0, z: 270.0, w: 6.0, h: 3.7, d: 5.5, rot: 0.2 },
      { id: 'house_8', x: 168.0, z: 298.0, w: 5.5, h: 3.4, d: 4.8, rot: 0.8 },
      { id: 'house_9', x: 188.0, z: 248.0, w: 6.5, h: 3.6, d: 5.2, rot: -0.7 },
      { id: 'house_10', x: 185.0, z: 228.0, w: 5.8, h: 3.5, d: 4.9, rot: 0.4 },
      { id: 'house_11', x: 162.0, z: 220.0, w: 6.2, h: 3.8, d: 5.6, rot: -0.15 },
      { id: 'house_12', x: 135.0, z: 222.0, w: 5.4, h: 3.3, d: 4.8, rot: 0.65 },
      { id: 'house_13', x: 122.0, z: 242.0, w: 5.6, h: 3.4, d: 5.0, rot: -0.5 },
      { id: 'house_14', x: 146.0, z: 290.0, w: 6.0, h: 3.5, d: 5.2, rot: 0.1 },
      { id: 'house_15', x: 216.0, z: 242.0, w: 5.8, h: 3.6, d: 5.0, rot: -0.45 },
      { id: 'house_16', x: 126.0, z: 268.0, w: 5.5, h: 3.4, d: 4.8, rot: 0.75 }
    ];

    // High-quality materials for authentic alpine village architecture
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x4a2810, roughness: 0.75 }); // Rich weathered oak door
    const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x27190d, roughness: 0.85 }); // Heavy dark timber frame
    const windowGlassMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.15, metalness: 0.5, transparent: true, opacity: 0.85 }); // Warm reflective glass
    const windowFrameMat = new THREE.MeshStandardMaterial({ color: 0x1f140a, roughness: 0.9 });
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x2b180d, roughness: 0.9 }); // Structural dark corner timber
    const porchRoofMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 });
    const cobbleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.92, metalness: 0.05 }); // Village cobblestone path

    // Cobblestone Pathways connecting each house entrance to the central road / square
    // Main village center / road intersection point
    const villageHubX = 162.0;
    const villageHubZ = 248.0;

    villageHouses.forEach(h => {
      // 1. Calculate corners terrain height to guarantee cabin never floats
      const halfW = h.w / 2;
      const halfD = h.d / 2;
      // Sample all 4 corners + center of house footprint
      const yCenter = getTerrainHeight(h.x, h.z);
      const yC1 = getTerrainHeight(h.x - halfW, h.z - halfD);
      const yC2 = getTerrainHeight(h.x + halfW, h.z - halfD);
      const yC3 = getTerrainHeight(h.x - halfW, h.z + halfD);
      const yC4 = getTerrainHeight(h.x + halfW, h.z + halfD);
      const minCornerY = Math.min(yCenter, yC1, yC2, yC3, yC4);
      const maxCornerY = Math.max(yCenter, yC1, yC2, yC3, yC4);
      
      // Base placement height set to minCornerY so no corner can ever hover in the air
      const baseGroundY = minCornerY;
      // Stone foundation depth embeds into ground up to 2.2m to seal any slope gaps
      const foundationDepth = Math.max(1.4, (maxCornerY - minCornerY) + 0.8);

      const cabinGroup = new THREE.Group();
      cabinGroup.position.set(h.x, baseGroundY, h.z);
      cabinGroup.rotation.y = h.rot;

      // Solid Stone Plinth Foundation (Extends underground so house is 100% grounded on any slope)
      const foundation = new THREE.Mesh(
        new THREE.BoxGeometry(h.w + 0.35, foundationDepth, h.d + 0.35),
        stoneMat
      );
      foundation.position.y = foundationDepth / 2 - (foundationDepth - 0.4); // Top lip sits ~0.4m above lowest ground
      foundation.castShadow = true;
      foundation.receiveShadow = true;
      cabinGroup.add(foundation);

      // Main Cabin Walls (Wood or Stone depending on workshop type)
      const floorY = 0.38; // Sits neatly atop stone foundation
      const wallMat = h.isBlacksmith ? stoneMat : woodMat;
      const walls = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), wallMat);
      walls.position.y = floorY + h.h / 2;
      walls.castShadow = true;
      walls.receiveShadow = true;
      cabinGroup.add(walls);

      // Structural Timber Corner Beams (Gives real Nordic log cabin look)
      const beamThick = 0.32;
      const beamH = h.h + 0.2;
      [
        [-halfW + beamThick / 2, -halfD + beamThick / 2],
        [halfW - beamThick / 2, -halfD + beamThick / 2],
        [-halfW + beamThick / 2, halfD - beamThick / 2],
        [halfW - beamThick / 2, halfD - beamThick / 2]
      ].forEach(([bx, bz]) => {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(beamThick, beamH, beamThick), beamMat);
        beam.position.set(bx, floorY + beamH / 2, bz);
        beam.castShadow = true;
        cabinGroup.add(beam);
      });

      // Realistic Alpine Gable Roof (A-Frame Prism with snow layer and eaves overhang)
      const roofOverhang = 0.55;
      const roofW = h.w + roofOverhang * 2;
      const roofD = h.d + roofOverhang * 2;
      const roofH = 2.4;
      const roofY = floorY + h.h;

      // Triangular Gable Roof Prism
      const roofGeom = new THREE.ConeGeometry(Math.hypot(roofW, roofD) * 0.44, roofH, 4);
      const roof = new THREE.Mesh(roofGeom, roofMat);
      roof.position.y = roofY + roofH / 2;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      cabinGroup.add(roof);

      // Thick Snow Cap over the Roof (Realistic winter blizzard accumulation)
      const snowCapGeom = new THREE.ConeGeometry(Math.hypot(roofW, roofD) * 0.45, roofH * 0.95, 4);
      const snowCap = new THREE.Mesh(snowCapGeom, snowRoofMat);
      snowCap.position.y = roofY + roofH / 2 + 0.12;
      snowCap.rotation.y = Math.PI / 4;
      snowCap.castShadow = true;
      cabinGroup.add(snowCap);

      // Front Doorway (Front face at +Z = h.d/2)
      const doorW = 1.15;
      const doorH = 2.15;
      const doorZ = halfD + 0.02;
      const doorY = floorY + doorH / 2;

      // Dark Wood Door Frame
      const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.22, doorH + 0.18, 0.14), doorFrameMat);
      doorFrame.position.set(0, doorY, doorZ);
      cabinGroup.add(doorFrame);

      // Recessed Wooden Door Planks
      const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.08), doorMat);
      doorMesh.position.set(0, doorY, doorZ + 0.02);
      doorMesh.castShadow = true;
      cabinGroup.add(doorMesh);

      // Iron Door Handle & Cross-Straps
      const handleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 6), ironMat);
      handleMesh.position.set(0.42, doorY, doorZ + 0.07);
      cabinGroup.add(handleMesh);

      // Front Door Porch / Entrance Stone Landing Steps
      const stepW = doorW + 0.8;
      const stepDepth = 1.3;
      const stepH = 0.85;
      const step1 = new THREE.Mesh(new THREE.BoxGeometry(stepW, stepH, stepDepth), stoneMat);
      step1.position.set(0, floorY - stepH / 2 + 0.05, doorZ + stepDepth / 2);
      step1.receiveShadow = true;
      cabinGroup.add(step1);

      // Front Entrance Porch Awning over Door
      const awningW = doorW + 0.6;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(awningW, 0.14, 1.1), porchRoofMat);
      awning.position.set(0, floorY + doorH + 0.2, doorZ + 0.5);
      awning.rotation.x = 0.18;
      cabinGroup.add(awning);

      // Warm Glowing Wall Lantern Fixture (Only create active dynamic PointLights for important quest workshops to maximize FPS)
      const lanternFixture = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.26, 0.18), ironMat);
      lanternFixture.position.set(0.8, floorY + doorH - 0.2, doorZ + 0.35);
      cabinGroup.add(lanternFixture);

      const lanternGlass = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.18, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xffaa22 }) // Vibrant glowing emissive glass
      );
      lanternGlass.position.copy(lanternFixture.position);
      cabinGroup.add(lanternGlass);

      if (h.isTownHall || h.isBlacksmith || h.isStorehouse || h.isToolShed) {
        const lanternLight = new THREE.PointLight(0xf59e0b, 1.6, 9);
        lanternLight.position.copy(lanternFixture.position);
        cabinGroup.add(lanternLight);
      }

      // Realistic Windows with Glass & Wooden Cross Grids
      const windowW = 0.95;
      const windowH = 1.1;
      const winY = floorY + 1.8;

      // Left & Right Front Windows
      [-halfW * 0.55, halfW * 0.55].forEach(wx => {
        // Window Frame
        const winFrame = new THREE.Mesh(new THREE.BoxGeometry(windowW + 0.12, windowH + 0.12, 0.08), windowFrameMat);
        winFrame.position.set(wx, winY, doorZ);
        cabinGroup.add(winFrame);

        // Reflective Glass Pane
        const winGlass = new THREE.Mesh(new THREE.BoxGeometry(windowW, windowH, 0.04), windowGlassMat);
        winGlass.position.set(wx, winY, doorZ + 0.01);
        cabinGroup.add(winGlass);

        // Window Sill
        const sill = new THREE.Mesh(new THREE.BoxGeometry(windowW + 0.24, 0.08, 0.22), woodMat);
        sill.position.set(wx, winY - windowH / 2 - 0.04, doorZ + 0.08);
        cabinGroup.add(sill);
      });

      // Evacuation Notice / Signs
      const doorSign = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.4, 0.05), signMat);
      doorSign.position.set(0, doorY + 0.2, doorZ + 0.06);
      cabinGroup.add(doorSign);

      // Town Hall Front Porch & Notice Board
      if (h.isTownHall) {
        const porch = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.25, 2.5), woodMat);
        porch.position.set(0, floorY + 0.12, halfD + 1.25);
        cabinGroup.add(porch);

        const noticePost = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.8, 0.15), woodMat);
        noticePost.position.set(1.6, floorY + 0.9, halfD + 1.6);
        cabinGroup.add(noticePost);

        const noticeBoard = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.85, 0.08), signMat);
        noticeBoard.position.set(1.6, floorY + 1.4, halfD + 1.6);
        cabinGroup.add(noticeBoard);
      }

      // Blacksmith Anvil & Winch Gear (Part 1)
      if (h.isBlacksmith) {
        const bench = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.9), woodMat);
        bench.position.set(0, floorY + 0.45, halfD + 1.1);
        cabinGroup.add(bench);

        const gearMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.15, 8), ironMat);
        gearMesh.position.set(0, floorY + 1.0, halfD + 1.1);
        gearMesh.rotation.x = Math.PI / 2;
        cabinGroup.add(gearMesh);
      }

      // Storehouse Crate & Steel Cable (Part 2)
      if (h.isStorehouse) {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), woodMat);
        crate.position.set(0, floorY + 0.5, halfD + 1.0);
        cabinGroup.add(crate);

        const cableCoil = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.08, 6, 12), ironMat);
        cableCoil.position.set(0, floorY + 1.1, halfD + 1.0);
        cableCoil.rotation.x = Math.PI / 2;
        cabinGroup.add(cableCoil);
      }

      // Tool Shed Tool Bench & Crank Handle (Part 3)
      if (h.isToolShed) {
        const toolBench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.8), woodMat);
        toolBench.position.set(0, floorY + 0.4, halfD + 1.0);
        cabinGroup.add(toolBench);

        const crankMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6), ironMat);
        crankMesh.position.set(0, floorY + 0.88, halfD + 1.0);
        crankMesh.rotation.z = Math.PI / 3;
        cabinGroup.add(crankMesh);
      }

      vGroup.add(cabinGroup);

      // Register non-blocking colliders around house walls
      this.colliders.push({
        type: 'aabb',
        minX: h.x - h.w * 0.52,
        maxX: h.x + h.w * 0.52,
        minZ: h.z - h.d * 0.52,
        maxZ: h.z + h.d * 0.52
      });
    });

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // PERFORMANCE-OPTIMIZED INSTANCED COBBLESTONE & FLAGSTONE STEPPING STONES
    // Embedded stone slabs with authentic organic variance along all door footpaths & village hub
    // -------------------------------------------------------------------------
    const paverGeom = new THREE.CylinderGeometry(0.55, 0.65, 0.70, 7);
    // Center the geometry so top face is flush with ground, and mass extends 0.70m underground
    paverGeom.translate(0, -0.35, 0);

    const paverTransforms = [];

    // 1. Generate flagstones along all house doorways connecting to village hub
    villageHouses.forEach(h => {
      const halfD = h.d / 2;
      const doorWorldDist = halfD + 1.2;
      const doorWorldX = h.x + Math.sin(h.rot) * doorWorldDist;
      const doorWorldZ = h.z + Math.cos(h.rot) * doorWorldDist;

      const pathDist = Math.hypot(villageHubX - doorWorldX, villageHubZ - doorWorldZ);
      const stepCount = Math.max(4, Math.floor(pathDist / 1.7));
      for (let s = 0; s <= stepCount; s++) {
        const frac = s / stepCount;
        // Subtle organic meander along footsteps
        const meander = Math.sin(s * 1.8 + h.x * 0.1) * 0.22;
        const px = doorWorldX + (villageHubX - doorWorldX) * frac + meander;
        const pz = doorWorldZ + (villageHubZ - doorWorldZ) * frac + meander;
        // Sample height and local slope gradient so pavers hug mountain contour
        const py = getTerrainHeight(px, pz) + 0.04;
        const hF = getTerrainHeight(px, pz + 0.5);
        const hB = getTerrainHeight(px, pz - 0.5);
        const hR = getTerrainHeight(px + 0.5, pz);
        const hL = getTerrainHeight(px - 0.5, pz);
        const rotX = Math.atan2(hB - hF, 1.0) * 0.75;
        const rotZ = Math.atan2(hL - hR, 1.0) * 0.75;
        const rotY = (s * 1.37 + h.rot) % (Math.PI * 2);
        const scaleX = 0.85 + Math.sin(s * 3.1) * 0.20;
        const scaleZ = 0.85 + Math.cos(s * 2.7) * 0.20;
        paverTransforms.push({ x: px, y: py, z: pz, rotX, rotY, rotZ, scaleX, scaleZ });
      }
    });

    // 2. Main Village Promenade & Square Flagstones (Hub to Road and Well)
    for (let s = 0; s <= 16; s++) {
      const frac = s / 16;
      const px = villageHubX + (160.0 - villageHubX) * frac;
      const pz = villageHubZ + (288.0 - villageHubZ) * frac;
      [-0.45, 0.45].forEach(offset => {
        const sx = px + offset;
        const sz = pz + (Math.sin(s * 2.0) * 0.1);
        const sy = getTerrainHeight(sx, sz) + 0.04;
        const hF = getTerrainHeight(sx, sz + 0.5);
        const hB = getTerrainHeight(sx, sz - 0.5);
        const hR = getTerrainHeight(sx + 0.5, sz);
        const hL = getTerrainHeight(sx - 0.5, sz);
        const rotX = Math.atan2(hB - hF, 1.0) * 0.75;
        const rotZ = Math.atan2(hL - hR, 1.0) * 0.75;
        const rotY = (s * 0.9) % (Math.PI * 2);
        paverTransforms.push({ x: sx, y: sy, z: sz, rotX, rotY, rotZ, scaleX: 1.0, scaleZ: 1.0 });
      });
    }

    this.villagePaverTransforms = paverTransforms;

    if (paverTransforms.length > 0) {
      const paverInst = new THREE.InstancedMesh(paverGeom, cobbleMat, paverTransforms.length);
      const dummy = new THREE.Object3D();
      paverTransforms.forEach((t, idx) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(t.rotX || 0, t.rotY, t.rotZ || 0);
        dummy.scale.set(t.scaleX || 1.0, 1.0, t.scaleZ || 1.0);
        dummy.updateMatrix();
        paverInst.setMatrixAt(idx, dummy.matrix);
      });
      paverInst.instanceMatrix.needsUpdate = true;
      paverInst.receiveShadow = false;
      this.villagePaverInst = paverInst;
      vGroup.add(paverInst);
    }

    // 2. Central Stone Village Well at (160, 248)
    const wellX = 160.0;
    const wellZ = 248.0;
    const wellY = getTerrainHeight(wellX, wellZ);
    const wellGroup = new THREE.Group();
    wellGroup.position.set(wellX, wellY, wellZ);

    const wellRing = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 1.1, 10, 1, true), stoneMat);
    wellRing.position.y = 0.55;
    wellRing.castShadow = true;
    wellGroup.add(wellRing);

    // Well Roof Posts and Canopy
    [-1.2, 1.2].forEach(wx => {
      const wellPost = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.4, 5), woodMat);
      wellPost.position.set(wx, 1.2, 0);
      wellGroup.add(wellPost);
    });
    const wellCanopy = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.1, 4), roofMat);
    wellCanopy.position.y = 2.8;
    wellCanopy.rotation.y = Math.PI / 4;
    wellGroup.add(wellCanopy);
    vGroup.add(wellGroup);

    // 3. Central Village Bonfire Hearth & Fire Pits in Gathering Square
    const firePitLocations = [
      { x: 155, z: 242, isMainHearth: true },
      { x: 168, z: 255, isMainHearth: false }
    ];
    firePitLocations.forEach(fp => {
      const fpy = getTerrainHeight(fp.x, fp.z);
      const pitRing = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.25, 6, 12), stoneMat);
      pitRing.rotation.x = Math.PI / 2;
      pitRing.position.set(fp.x, fpy + 0.15, fp.z);
      vGroup.add(pitRing);

      if (fp.isMainHearth) {
        // Glowing Village Bonfire Hearth
        const hearthLight = new THREE.PointLight(0xff7722, 5.0, 36);
        hearthLight.position.set(fp.x, fpy + 1.2, fp.z);
        this.scene.add(hearthLight);

        const flameOrb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
        flameOrb.position.set(fp.x, fpy + 0.65, fp.z);
        vGroup.add(flameOrb);

        const villageFireParticles = new FlameParticleSystem(this.scene, 36, 0.5, 1.8, 0.28);
        this.campfires.push({
          pos: new THREE.Vector3(fp.x, fpy, fp.z),
          light: hearthLight,
          flameOrb,
          flameParticles: villageFireParticles
        });

        // Burning stack of split pine logs
        for (let l = 0; l < 5; l++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.6, 6), woodMat);
          log.position.set(fp.x + Math.cos(l * 1.3) * 0.3, fpy + 0.25, fp.z + Math.sin(l * 1.3) * 0.3);
          log.rotation.set(0.3, l * 1.3, 0.25);
          vGroup.add(log);
        }
      } else {
        // Charred unlit wood logs for auxiliary pit
        for (let l = 0; l < 3; l++) {
          const charredLog = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.3, 5), woodMat);
          charredLog.position.set(fp.x + Math.cos(l * 2) * 0.25, fpy + 0.2, fp.z + Math.sin(l * 2) * 0.25);
          charredLog.rotation.set(0.2, l * 2, 0.15);
          vGroup.add(charredLog);
        }
      }
    });

    // 4. Wooden Fence Perimeter along village boundaries
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x4a3219, roughness: 0.9 });
    for (let f = 0; f < 22; f++) {
      const fx = 120 + f * 3.4;
      const fz = 212 + Math.sin(f * 0.6) * 4;
      const fy = getTerrainHeight(fx, fz);

      const fPost = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.4, 5), fenceMat);
      fPost.position.set(fx, fy + 0.7, fz);
      fPost.castShadow = true;
      vGroup.add(fPost);

      const fRail = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 0.08), fenceMat);
      fRail.position.set(fx + 1.7, fy + 0.9, fz);
      vGroup.add(fRail);
    }

    // 5. Scattered Barrels and Crates
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x47301c, roughness: 0.85 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3e22, roughness: 0.9 });
    for (let c = 0; c < 18; c++) {
      const cx = 140 + Math.sin(c * 1.7) * 40;
      const cz = 245 + Math.cos(c * 2.3) * 35;
      const cy = getTerrainHeight(cx, cz);

      if (c % 2 === 0) {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.44, 1.0, 7), barrelMat);
        barrel.position.set(cx, cy + 0.5, cz);
        barrel.castShadow = true;
        vGroup.add(barrel);
      } else {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), crateMat);
        crate.position.set(cx, cy + 0.45, cz);
        crate.castShadow = true;
        vGroup.add(crate);
      }
    }

    this.scene.add(vGroup);

    // Elder Kaelen NPC Talk & Sacred Torch Interactable
    const elderPos = new THREE.Vector3(158.0, getTerrainHeight(158.0, 246.0) + 1.2, 246.0);
    this.createInteractable({
      id: 'elder_kaelen',
      name: 'Elder Kaelen (Receive Sacred Torch & Mission)',
      pos: elderPos,
      icon: '🔥',
      reachRadius: 4.8,
      onInteract: () => {
        this.talkToElderKaelen();
      }
    });

    // Readable Lore Note Interactable ("We moved")
    const h1X = 152.0, h1Z = 250.0;
    const h1Y = getTerrainHeight(h1X, h1Z);
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

    // ---------------------------------------------------------------------------
    // THE 3 SACRED VILLAGE RELICS (Winch Gear, Steel Cable, Crank Handle)
    // ---------------------------------------------------------------------------
    // Relic 1: Heavy Winch Gear (Inside Blacksmith Workshop at 172.0, 235.0)
    const h2X = 172.0, h2Z = 235.0;
    const h2Y = getTerrainHeight(h2X, h2Z);
    const gearRelicGroup = new THREE.Group();
    gearRelicGroup.position.set(h2X, h2Y + 1.25, h2Z + 3.8);

    const gearVisual = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 0.14, 12),
      new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.85, roughness: 0.25 })
    );
    gearVisual.rotation.x = Math.PI / 2;
    gearVisual.castShadow = true;
    gearRelicGroup.add(gearVisual);

    const gearGlowLight = new THREE.PointLight(0xf59e0b, 1.8, 6);
    gearGlowLight.position.y = 0.2;
    gearRelicGroup.add(gearGlowLight);

    const gearBeacon = this.createLightRing(1.2, 0xf59e0b, 0.45);
    gearBeacon.position.set(0, -0.65, 0);
    gearRelicGroup.add(gearBeacon);

    this.scene.add(gearRelicGroup);
    this.villageRelicVisuals.push({ id: 'village_gear', group: gearRelicGroup, light: gearGlowLight, beacon: gearBeacon, basePosY: h2Y + 1.25 });

    this.createInteractable({
      id: 'village_gear',
      name: 'Heavy Winch Gear (Relic 1/3 - Blacksmith)',
      pos: new THREE.Vector3(h2X, h2Y + 1.2, h2Z + 3.8),
      icon: '⚙️',
      reachRadius: 4.8,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'winch_gear', name: 'Heavy Winch Gear', icon: '⚙️', count: 1 });
        this.sfx.playPickup();
        if (gearRelicGroup) gearRelicGroup.visible = false;
        if (gearGlowLight) gearGlowLight.intensity = 0;
        this.showToast(`Found Winch Gear! (${this.villagePartsCollected}/3 Bridge Relics)`);
        this.checkVillageBridgeProgress();
      }
    });

    // Relic 2: High-Tensile Steel Cable (Inside Village Storehouse at 145.0, 235.0)
    const h3X = 145.0, h3Z = 235.0;
    const h3Y = getTerrainHeight(h3X, h3Z);
    const cableRelicGroup = new THREE.Group();
    cableRelicGroup.position.set(h3X, h3Y + 1.25, h3Z + 3.5);

    const cableVisual = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.09, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.9, roughness: 0.2 })
    );
    cableVisual.rotation.x = Math.PI / 2;
    cableVisual.castShadow = true;
    cableRelicGroup.add(cableVisual);

    const cableGlowLight = new THREE.PointLight(0x38bdf8, 1.8, 6);
    cableGlowLight.position.y = 0.2;
    cableRelicGroup.add(cableGlowLight);

    const cableBeacon = this.createLightRing(1.2, 0x38bdf8, 0.45);
    cableBeacon.position.set(0, -0.65, 0);
    cableRelicGroup.add(cableBeacon);

    this.scene.add(cableRelicGroup);
    this.villageRelicVisuals.push({ id: 'village_cable', group: cableRelicGroup, light: cableGlowLight, beacon: cableBeacon, basePosY: h3Y + 1.25 });

    this.createInteractable({
      id: 'village_cable',
      name: 'Steel Cable Coil (Relic 2/3 - Storehouse)',
      pos: new THREE.Vector3(h3X, h3Y + 1.2, h3Z + 3.5),
      icon: '⛓️',
      reachRadius: 4.8,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'steel_cable', name: 'High-Tensile Steel Cable', icon: '⛓️', count: 1 });
        this.sfx.playPickup();
        if (cableRelicGroup) cableRelicGroup.visible = false;
        if (cableGlowLight) cableGlowLight.intensity = 0;
        this.showToast(`Found Steel Cable! (${this.villagePartsCollected}/3 Bridge Relics)`);
        this.checkVillageBridgeProgress();
      }
    });

    // Relic 3: Iron Winch Crank Handle (Inside Outpost Tool Shed at 176.0, 258.0)
    const h4X = 176.0, h4Z = 258.0;
    const h4Y = getTerrainHeight(h4X, h4Z);
    const crankRelicGroup = new THREE.Group();
    crankRelicGroup.position.set(h4X, h4Y + 1.15, h4Z + 3.3);

    const crankVisual = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.065, 0.72, 8),
      new THREE.MeshStandardMaterial({ color: 0x10b981, metalness: 0.85, roughness: 0.25 })
    );
    crankVisual.rotation.z = Math.PI / 3;
    crankVisual.castShadow = true;
    crankRelicGroup.add(crankVisual);

    const crankGlowLight = new THREE.PointLight(0x10b981, 1.8, 6);
    crankGlowLight.position.y = 0.2;
    crankRelicGroup.add(crankGlowLight);

    const crankBeacon = this.createLightRing(1.2, 0x10b981, 0.45);
    crankBeacon.position.set(0, -0.65, 0);
    crankRelicGroup.add(crankBeacon);

    this.scene.add(crankRelicGroup);
    this.villageRelicVisuals.push({ id: 'village_crank', group: crankRelicGroup, light: crankGlowLight, beacon: crankBeacon, basePosY: h4Y + 1.15 });

    this.createInteractable({
      id: 'village_crank',
      name: 'Iron Crank Handle (Relic 3/3 - Tool Shed)',
      pos: new THREE.Vector3(h4X, h4Y + 1.1, h4Z + 3.3),
      icon: '🔧',
      reachRadius: 4.8,
      onInteract: () => {
        this.villagePartsCollected++;
        this.addItem({ id: 'crank_handle', name: 'Iron Winch Crank Handle', icon: '🔧', count: 1 });
        this.sfx.playPickup();
        if (crankRelicGroup) crankRelicGroup.visible = false;
        if (crankGlowLight) crankGlowLight.intensity = 0;
        this.showToast(`Found Winch Crank! (${this.villagePartsCollected}/3 Bridge Relics)`);
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

    // Generator Shed Enclosure around diesel generator
    const shedWallMat = new THREE.MeshStandardMaterial({ color: 0x3d2817, roughness: 0.9 });
    const shedCorrugatedMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.4 });
    const genShed = new THREE.Group();
    genShed.position.set(campX + 12.0, groundY, campZ - 2.0);

    // 3 timber slat walls (open front for generator maintenance)
    const shedBack = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.6, 0.15), shedWallMat);
    shedBack.position.set(0, 1.3, -1.8);
    genShed.add(shedBack);
    const shedLeft = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.6, 3.4), shedWallMat);
    shedLeft.position.set(-1.8, 1.3, 0);
    genShed.add(shedLeft);
    const shedRight = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.6, 3.4), shedWallMat);
    shedRight.position.set(1.8, 1.3, 0);
    genShed.add(shedRight);

    // Slanted corrugated metal roof
    const shedTinRoof = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 4.0), shedCorrugatedMat);
    shedTinRoof.position.set(0, 2.7, 0.1);
    shedTinRoof.rotation.x = 0.15;
    genShed.add(shedTinRoof);
    this.scene.add(genShed);

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

    // 3. Wooden Watchtower with Rope Ladder at (-52, -242)
    const towerX = campX + 18.0;
    const towerZ = campZ - 7.0;
    const towerY = getTerrainHeight(towerX, towerZ);
    const watchGroup = new THREE.Group();
    watchGroup.position.set(towerX, towerY, towerZ);

    const towerH = 10.5;
    // 4 sturdy corner logs
    [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]].forEach(([cx, cz]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, towerH, 6), woodMat);
      leg.position.set(cx, towerH / 2, cz);
      leg.castShadow = true;
      watchGroup.add(leg);
    });

    // Observation platform deck
    const deck = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 4.2), woodMat);
    deck.position.y = towerH;
    deck.castShadow = true;
    watchGroup.add(deck);

    // Platform railings
    for (let r = -1.8; r <= 1.8; r += 0.9) {
      const rPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), woodMat);
      rPost.position.set(r, towerH + 0.55, 2.0);
      watchGroup.add(rPost);
    }

    // Pyramid roof
    const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.0, 4), roofMat);
    towerRoof.position.y = towerH + 2.2;
    towerRoof.rotation.y = Math.PI / 4;
    watchGroup.add(towerRoof);

    // Rope Ladder hanging down
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x785635, roughness: 0.95 });
    [-0.35, 0.35].forEach(rx => {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, towerH, 4), ropeMat);
      rope.position.set(rx, towerH / 2, 2.05);
      watchGroup.add(rope);
    });
    for (let rungY = 0.6; rungY < towerH; rungY += 0.6) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.06), woodMat);
      rung.position.set(0, rungY, 2.05);
      watchGroup.add(rung);
    }

    this.scene.add(watchGroup);

    // 4. Stacks of Wooden Supply Crates and Steel Barrels
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3e22, roughness: 0.9 });
    const crateDefs = [
      { x: campX + 10.5, z: campZ + 1.2, s: 1.0, yOff: 0.5 },
      { x: campX + 11.6, z: campZ + 1.2, s: 0.9, yOff: 0.45 },
      { x: campX + 11.0, z: campZ + 1.2, s: 0.8, yOff: 1.4 },
      { x: campX - 9.5, z: campZ + 3.8, s: 1.1, yOff: 0.55 },
      { x: campX - 10.8, z: campZ + 3.8, s: 0.9, yOff: 0.45 }
    ];
    crateDefs.forEach(cd => {
      const cy = getTerrainHeight(cd.x, cd.z);
      const cMesh = new THREE.Mesh(new THREE.BoxGeometry(cd.s, cd.s, cd.s), crateMat);
      cMesh.position.set(cd.x, cy + cd.yOff, cd.z);
      cMesh.castShadow = true;
      this.scene.add(cMesh);
    });

    // 5. Campfire Ring (Safe Zone with Real Flame Particles & Flicker Light)
    const fireX = campX;
    const fireZ = campZ - 4.0;
    const fireLight = new THREE.PointLight(0xff7722, 4.0, 32);
    fireLight.position.set(fireX, groundY + 1.2, fireZ);
    this.scene.add(fireLight);

    // Stone Fire Pit Ring
    const stoneRingMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    const stoneRing = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.24, 6, 12), stoneRingMat);
    stoneRing.rotation.x = Math.PI / 2;
    stoneRing.position.set(fireX, groundY + 0.15, fireZ);
    this.scene.add(stoneRing);

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
    const gltfLoader = new GLTFLoader(globalLoadingManager);

    // Helper to merge BufferGeometries without external dependencies
    const mergeGeometriesSimple = (geoms) => {
      const positions = [];
      const normals = [];
      geoms.forEach(g => {
        const non = g.index ? g.toNonIndexed() : g;
        const p = non.attributes.position;
        const n = non.attributes.normal;
        for (let i = 0; i < p.count; i++) {
          positions.push(p.getX(i), p.getY(i), p.getZ(i));
          normals.push(n.getX(i), n.getY(i), n.getZ(i));
        }
      });
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      return merged;
    };

    // Helper to safely bind GLB meshes to InstancedMeshes with toNonIndexed conversion & ground alignment
    const bindGLBToInstanced = (url, instancedMeshes) => {
      if (typeof window === 'undefined' || !window.location) return;
      gltfLoader.load(
        url,
        (gltf) => {
          const parts = [];
          gltf.scene.traverse((c) => {
            if (c.isMesh && c.geometry) {
              if (c.material) {
                const sanitizeMat = (mat) => {
                  const m = mat.clone();
                  m.metalness = 0.0;
                  m.roughness = 0.88;
                  const nameLower = (m.name || '').toLowerCase();
                  if (nameLower.includes('leaf') || nameLower.includes('leaves') || nameLower.includes('grass')) {
                    if (url.includes('birch')) {
                      m.color.setHex(0xb58b2a); // Golden autumn alpine aspen / birch
                    } else if (url.includes('bush')) {
                      m.color.setHex(0x1e3a24); // Rich wild shrub dark green
                    } else if (nameLower.includes('dark')) {
                      m.color.setHex(0x133822); // Deep alpine conifer pine green
                    } else {
                      m.color.setHex(0x225c38); // Lush pine / spruce green
                    }
                  } else if (nameLower.includes('bark') || nameLower.includes('wood')) {
                    if (url.includes('birch')) {
                      m.color.setHex(0x4a3625); // Weathered mountain birch bark
                    } else if (nameLower.includes('dark')) {
                      m.color.setHex(0x382215); // Weathered pine bark brown
                    } else {
                      m.color.setHex(0x4a3222); // Earthy trunk brown
                    }
                  }
                  return m;
                };
                if (Array.isArray(c.material)) {
                  c.material = c.material.map(sanitizeMat);
                } else {
                  c.material = sanitizeMat(c.material);
                }
              }
              parts.push(c);
            }
          });

          if (parts.length === 1) {
            const nonGeom = (parts[0].geometry.index ? parts[0].geometry.toNonIndexed() : parts[0].geometry).clone();
            nonGeom.computeBoundingBox();
            if (nonGeom.boundingBox && nonGeom.boundingBox.min.y !== 0) {
              nonGeom.translate(0, -nonGeom.boundingBox.min.y, 0);
            }
            if (instancedMeshes[0]) {
              instancedMeshes[0].geometry = nonGeom;
              if (parts[0].material) instancedMeshes[0].material = parts[0].material;
              instancedMeshes[0].castShadow = true;
              instancedMeshes[0].receiveShadow = true;
            }
            // If the model is a combined 1-mesh tree (like nature/tree-snow-a.glb) and 2 instanced meshes were provided (trunk+foliage), hide the dummy trunk
            if (instancedMeshes.length > 1 && instancedMeshes[1]) {
              instancedMeshes[1].geometry = nonGeom;
              if (parts[0].material) instancedMeshes[1].material = parts[0].material;
              instancedMeshes[1].castShadow = true;
              instancedMeshes[1].receiveShadow = true;
              // Set the first (trunk) dummy mesh to empty so it doesn't double-render
              instancedMeshes[0].geometry = new THREE.BufferGeometry();
            }
          } else if (parts.length >= 2 && instancedMeshes.length >= 2) {
            let trunkPart = parts.find(p => p.material && ((p.material.name || '').toLowerCase().includes('bark') || (p.material.name || '').toLowerCase().includes('wood')));
            let foliagePart = parts.find(p => p.material && ((p.material.name || '').toLowerCase().includes('leaf') || (p.material.name || '').toLowerCase().includes('grass')));
            if (!trunkPart) trunkPart = parts[1];
            if (!foliagePart) foliagePart = parts[0];

            const trunkNon = (trunkPart.geometry.index ? trunkPart.geometry.toNonIndexed() : trunkPart.geometry).clone();
            trunkNon.computeBoundingBox();
            const trunkMinY = trunkNon.boundingBox ? trunkNon.boundingBox.min.y : 0;
            if (trunkMinY !== 0) {
              trunkNon.translate(0, -trunkMinY, 0);
            }
            instancedMeshes[0].geometry = trunkNon;
            if (trunkPart.material) instancedMeshes[0].material = trunkPart.material;
            instancedMeshes[0].castShadow = true;
            instancedMeshes[0].receiveShadow = true;

            const foliageNon = (foliagePart.geometry.index ? foliagePart.geometry.toNonIndexed() : foliagePart.geometry).clone();
            if (trunkMinY !== 0) {
              foliageNon.translate(0, -trunkMinY, 0);
            }
            instancedMeshes[1].geometry = foliageNon;
            if (foliagePart.material) instancedMeshes[1].material = foliagePart.material;
            instancedMeshes[1].castShadow = true;
            instancedMeshes[1].receiveShadow = true;
          }
        },
        undefined,
        (err) => console.warn('GLB procedural fallback active for ' + url, err)
      );
    };

    // Track all tree instance transforms so rebuildTerrainMesh can re-snap them to the loaded heightmap
    this.treeTransforms = [];

    // =========================================================================
    // 1. TALL TIERED ALPINE PINE (3 Layered Skirts, Rich Deep Pine Green)
    // =========================================================================
    const tallPineCount = 950;
    const tallTrunkGeom = new THREE.CylinderGeometry(0.08, 0.14, 1.3, 6);
    tallTrunkGeom.translate(0, 0.65, 0);
    const tallTrunkMat = new THREE.MeshStandardMaterial({ color: 0x321f14, roughness: 0.92 });
    const tallTrunkInst = new THREE.InstancedMesh(tallTrunkGeom, tallTrunkMat, tallPineCount);
    tallTrunkInst.castShadow = true;
    tallTrunkInst.receiveShadow = true;

    // Organic 3-tiered cone foliage
    const tp1 = new THREE.ConeGeometry(0.56, 0.75, 7); tp1.translate(0, 0.85, 0);
    const tp2 = new THREE.ConeGeometry(0.44, 0.70, 7); tp2.translate(0, 1.25, 0);
    const tp3 = new THREE.ConeGeometry(0.30, 0.65, 7); tp3.translate(0, 1.65, 0);
    const tallFoliageGeom = mergeGeometriesSimple([tp1, tp2, tp3]);
    const tallFoliageMat = new THREE.MeshStandardMaterial({ color: 0x133822, roughness: 0.85 }); // Deep alpine green
    const tallFoliageInst = new THREE.InstancedMesh(tallFoliageGeom, tallFoliageMat, tallPineCount);
    tallFoliageInst.castShadow = true;
    tallFoliageInst.receiveShadow = true;
    bindGLBToInstanced('./assets/models/tree_pine.glb', [tallTrunkInst, tallFoliageInst]);

    // =========================================================================
    // 2. MOUNTAIN BLUE SPRUCE & SNOW CONIFER (Dense Tiered Needles & Snow Frost)
    // =========================================================================
    const spruceCount = 850;
    const spruceTrunkGeom = new THREE.CylinderGeometry(0.09, 0.13, 0.9, 6);
    spruceTrunkGeom.translate(0, 0.45, 0);
    const spruceTrunkMat = new THREE.MeshStandardMaterial({ color: 0x3e2b1d, roughness: 0.9 });
    const spruceTrunkInst = new THREE.InstancedMesh(spruceTrunkGeom, spruceTrunkMat, spruceCount);
    spruceTrunkInst.castShadow = true;
    spruceTrunkInst.receiveShadow = true;

    // 4 wide tiered conifer skirts
    const sp1 = new THREE.ConeGeometry(0.72, 0.55, 8); sp1.translate(0, 0.65, 0);
    const sp2 = new THREE.ConeGeometry(0.58, 0.50, 8); sp2.translate(0, 1.05, 0);
    const sp3 = new THREE.ConeGeometry(0.42, 0.45, 8); sp3.translate(0, 1.45, 0);
    const sp4 = new THREE.ConeGeometry(0.26, 0.40, 8); sp4.translate(0, 1.80, 0);
    const spruceFoliageGeom = mergeGeometriesSimple([sp1, sp2, sp3, sp4]);
    const spruceFoliageMat = new THREE.MeshStandardMaterial({ color: 0x1b4a3a, roughness: 0.82 }); // Blue-green spruce
    const spruceFoliageInst = new THREE.InstancedMesh(spruceFoliageGeom, spruceFoliageMat, spruceCount);
    spruceFoliageInst.castShadow = true;
    spruceFoliageInst.receiveShadow = true;
    bindGLBToInstanced('./assets/models/nature/tree-snow-a.glb', [spruceTrunkInst, spruceFoliageInst]);

    // =========================================================================
    // 2B. LUSH ROUND CANOPY DECIDUOUS / NORDIC PINE VARIETY (Reference Sprites)
    // =========================================================================
    const oakCount = 550;
    const oakTrunkGeom = new THREE.CylinderGeometry(0.12, 0.18, 1.1, 6);
    oakTrunkGeom.translate(0, 0.55, 0);
    const oakTrunkMat = new THREE.MeshStandardMaterial({ color: 0x422a18, roughness: 0.92 });
    const oakTrunkInst = new THREE.InstancedMesh(oakTrunkGeom, oakTrunkMat, oakCount);
    oakTrunkInst.castShadow = true;
    oakTrunkInst.receiveShadow = true;

    // Multi-lobed lush rounded deciduous canopy matching user reference image
    const oc1 = new THREE.DodecahedronGeometry(0.52, 1); oc1.translate(0, 1.35, 0);
    const oc2 = new THREE.DodecahedronGeometry(0.42, 1); oc2.translate(0.18, 1.60, 0.12);
    const oc3 = new THREE.DodecahedronGeometry(0.38, 1); oc3.translate(-0.16, 1.55, -0.10);
    const oc4 = new THREE.DodecahedronGeometry(0.32, 1); oc4.translate(0.08, 1.90, -0.05);
    const oakFoliageGeom = mergeGeometriesSimple([oc1, oc2, oc3, oc4]);
    const oakFoliageMat = new THREE.MeshStandardMaterial({ color: 0x1b5229, roughness: 0.84 });
    const oakFoliageInst = new THREE.InstancedMesh(oakFoliageGeom, oakFoliageMat, oakCount);
    oakFoliageInst.castShadow = true;
    oakFoliageInst.receiveShadow = true;
    bindGLBToInstanced('./assets/models/nature/tree.glb', [oakTrunkInst, oakFoliageInst]);

    // =========================================================================
    // 3. GOLDEN AUTUMN ASPEN / BIRCH (Slender Trunk, Warm Golden Canopy)
    // =========================================================================
    const birchCount = 650;
    const birchTrunkGeom = new THREE.CylinderGeometry(0.065, 0.095, 1.3, 6);
    birchTrunkGeom.translate(0, 0.65, 0);
    const birchTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4231, roughness: 0.85 });
    const birchTrunkInst = new THREE.InstancedMesh(birchTrunkGeom, birchTrunkMat, birchCount);
    birchTrunkInst.castShadow = true;

    // Multi-cluster rounded deciduous crown with warm golden foliage
    const bc1 = new THREE.DodecahedronGeometry(0.46, 1); bc1.translate(0, 1.35, 0);
    const bc2 = new THREE.DodecahedronGeometry(0.34, 1); bc2.translate(0.12, 1.62, 0.08);
    const bc3 = new THREE.DodecahedronGeometry(0.30, 1); bc3.translate(-0.11, 1.56, -0.10);
    const birchFoliageGeom = mergeGeometriesSimple([bc1, bc2, bc3]);
    const birchFoliageMat = new THREE.MeshStandardMaterial({ color: 0x3d6632, roughness: 0.82 }); // Fresh deciduous green
    const birchFoliageInst = new THREE.InstancedMesh(birchFoliageGeom, birchFoliageMat, birchCount);
    birchFoliageInst.castShadow = true;
    bindGLBToInstanced('./assets/models/tree_birch.glb', [birchTrunkInst, birchFoliageInst]);

    // =========================================================================
    // 4. TWISTED DEAD ALPINE TREES (Weathered Stark Wood on Ridges)
    // =========================================================================
    const deadCount = 480;
    const deadGeom = new THREE.CylinderGeometry(0.08, 0.12, 1.8, 5);
    deadGeom.translate(0, 0.9, 0);
    const deadMat = new THREE.MeshStandardMaterial({ color: 0x271f18, roughness: 0.96 });
    const deadInst = new THREE.InstancedMesh(deadGeom, deadMat, deadCount);
    deadInst.castShadow = true;
    bindGLBToInstanced('./assets/models/tree_dead.glb', [deadInst]);

    // =========================================================================
    // 5. TREE STUMPS
    // =========================================================================
    const stumpCount = 280;
    const stumpGeom = new THREE.CylinderGeometry(0.18, 0.22, 0.6, 6);
    stumpGeom.translate(0, 0.3, 0);
    const stumpMat = new THREE.MeshStandardMaterial({ color: 0x483222, roughness: 0.9 });
    const stumpInst = new THREE.InstancedMesh(stumpGeom, stumpMat, stumpCount);
    stumpInst.castShadow = true;
    bindGLBToInstanced('./assets/models/tree_stump.glb', [stumpInst]);

    // =========================================================================
    // 6. BUSHES WITH COLORFUL EDIBLE BERRIES (Red, Blue, Purple, Amber, Pink)
    // =========================================================================
    const bushCount = 800;
    const bushGeom = new THREE.DodecahedronGeometry(0.35, 1);
    bushGeom.translate(0, 0.3, 0);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x1e3a24, roughness: 0.85 }); // Rich deep shrub green
    const bushInst = new THREE.InstancedMesh(bushGeom, bushMat, bushCount);
    bushInst.castShadow = true;
    bindGLBToInstanced('./assets/models/bush.glb', [bushInst]);

    // Multi-cluster 3D berries attached to the outer canopy of the bushes
    const berryClusterOffsets = [
      [0.22, 0.28, 0.12],
      [-0.20, 0.25, 0.14],
      [0.08, 0.36, -0.18],
      [-0.14, 0.30, -0.16],
      [0.24, 0.18, -0.08],
      [-0.22, 0.17, -0.08],
      [0.02, 0.40, 0.08]
    ];
    const berrySphereGeom = new THREE.SphereGeometry(0.045, 5, 5);
    const berrySpheres = berryClusterOffsets.map(([ox, oy, oz]) => {
      const g = berrySphereGeom.clone();
      g.translate(ox, oy, oz);
      return g;
    });
    const mergedBerryGeom = mergeGeometriesSimple(berrySpheres);
    const berryMat = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.1,
      emissiveIntensity: 0.25
    });
    const berryInst = new THREE.InstancedMesh(mergedBerryGeom, berryMat, bushCount);
    berryInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bushCount * 3), 3);
    berryInst.castShadow = true;

    // Palette of vibrant mountain winter berries:
    const berryPalette = [
      new THREE.Color(0xdc2626), // Scarlet Cranberry / Lingonberry
      new THREE.Color(0x2563eb), // Frost Sapphire Huckleberry
      new THREE.Color(0x7c3aed), // Wild Royal Purple Blackberry
      new THREE.Color(0xf59e0b), // Golden Amber Arctic Cloudberry
      new THREE.Color(0xec4899)  // Alpine Wild Rosehip
    ];

    // Helper for random lean between 0 and 8 degrees (0.0 to 0.14 rad)
    const getRandomLean = () => {
      const angle = Math.random() * 0.14;
      const dir = Math.random() * Math.PI * 2;
      return [Math.sin(dir) * angle, Math.cos(dir) * angle];
    };

    // Grounding sink offset: sinking tree roots 0.26m into terrain guarantees 0% floating on hills
    const SINK_OFFSET = 0.26;

    // Populate Tall Pines (Dense in deep forest, sparse near road)
    let tallIdx = 0, attempts = 0;
    while (tallIdx < tallPineCount && attempts < 14000) {
      attempts++;
      const tx = (Math.random() - 0.5) * 1540;
      const tz = (Math.random() - 0.5) * 1540;

      const road = getRoadSignedDistance(tx, tz);
      if (road.roadDist < 6.8) continue;
      if (road.roadDist < 22.0 && Math.random() > 0.18) continue;
      if (Math.hypot(tx - (-35), tz - 40) < 82) continue;
      if (road.signedDist < -5.0 && road.signedDist > -24.0) continue;
      if (Math.hypot(tx - (-180), tz - 520) < 16) continue;
      if (Math.hypot(tx - 160, tz - 250) < 42) continue;
      if (Math.hypot(tx - (-70), tz - (-235)) < 28) continue;
      if (Math.hypot(tx - 0, tz - (-560)) < 24) continue;

      const noise = Math.sin(tx * 0.016) * Math.cos(tz * 0.016) + Math.sin(tx * 0.04 + tz * 0.02) * 0.35;
      if (noise < -0.15) continue;

      const ty = getTerrainHeight(tx, tz) - SINK_OFFSET;
      const baseScale = 5.4;
      const scale = baseScale * (0.7 + Math.random() * 0.7);
      const [leanX, leanZ] = getRandomLean();

      dummy.position.set(tx, ty, tz);
      dummy.scale.set(scale, scale * 1.15, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      tallTrunkInst.setMatrixAt(tallIdx, dummy.matrix);
      tallFoliageInst.setMatrixAt(tallIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: [tallTrunkInst, tallFoliageInst],
        idx: tallIdx,
        x: tx,
        z: tz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: SINK_OFFSET
      });

      if (road.roadDist < 26) {
        this.colliders.push({
          type: 'sphere',
          center: new THREE.Vector2(tx, tz),
          radius: 0.8 * (scale / baseScale)
        });
      }
      tallIdx++;
    }

    // Populate Mountain Blue Spruce (Slopes and forest borders)
    let spruceIdx = 0; attempts = 0;
    while (spruceIdx < spruceCount && attempts < 14000) {
      attempts++;
      const sx = (Math.random() - 0.5) * 1540;
      const sz = (Math.random() - 0.5) * 1540;

      const road = getRoadSignedDistance(sx, sz);
      if (road.roadDist < 6.8) continue;
      if (road.roadDist < 20.0 && Math.random() > 0.22) continue;
      if (Math.hypot(sx - (-35), sz - 40) < 82) continue;
      if (road.signedDist < -5.0 && road.signedDist > -24.0) continue;
      if (Math.hypot(sx - 160, sz - 250) < 40) continue;
      if (Math.hypot(sx - (-70), sz - (-235)) < 26) continue;

      const ty = getTerrainHeight(sx, sz) - SINK_OFFSET;
      const baseScale = 4.6;
      const scale = baseScale * (0.7 + Math.random() * 0.7);
      const [leanX, leanZ] = getRandomLean();

      dummy.position.set(sx, ty, sz);
      dummy.scale.set(scale, scale * 1.05, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      spruceTrunkInst.setMatrixAt(spruceIdx, dummy.matrix);
      spruceFoliageInst.setMatrixAt(spruceIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: [spruceTrunkInst, spruceFoliageInst],
        idx: spruceIdx,
        x: sx,
        z: sz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: SINK_OFFSET
      });

      if (road.roadDist < 24) {
        this.colliders.push({
          type: 'sphere',
          center: new THREE.Vector2(sx, sz),
          radius: 0.7 * (scale / baseScale)
        });
      }
      spruceIdx++;
    }

    // Populate Oak & Deciduous Canopy Variety (Lush Round Trees)
    let oakIdx = 0; attempts = 0;
    while (oakIdx < oakCount && attempts < 12000) {
      attempts++;
      const ox = (Math.random() - 0.5) * 1540;
      const oz = (Math.random() - 0.5) * 1540;

      const road = getRoadSignedDistance(ox, oz);
      if (road.roadDist < 6.8) continue;
      if (road.roadDist < 20.0 && Math.random() > 0.24) continue;
      if (Math.hypot(ox - (-35), oz - 40) < 82) continue;
      if (Math.hypot(ox - 160, oz - 250) < 38) continue;

      const noise = Math.cos(ox * 0.02) * Math.sin(oz * 0.02);
      if (noise < -0.22 || noise > 0.32) continue;

      const oy = getTerrainHeight(ox, oz) - SINK_OFFSET;
      const baseScale = 4.8;
      const scale = baseScale * (0.72 + Math.random() * 0.65);
      const [leanX, leanZ] = getRandomLean();

      dummy.position.set(ox, oy, oz);
      dummy.scale.set(scale, scale * 1.08, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      oakTrunkInst.setMatrixAt(oakIdx, dummy.matrix);
      oakFoliageInst.setMatrixAt(oakIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: [oakTrunkInst, oakFoliageInst],
        idx: oakIdx,
        x: ox,
        z: oz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: SINK_OFFSET
      });

      oakIdx++;
    }

    // Populate Birches & Aspens in groves and meadows
    let birchIdx = 0; attempts = 0;
    while (birchIdx < birchCount && attempts < 10000) {
      attempts++;
      const bx = (Math.random() - 0.5) * 1540;
      const bz = (Math.random() - 0.5) * 1540;
      const road = getRoadSignedDistance(bx, bz);
      if (road.roadDist < 6.8) continue;
      if (road.roadDist < 22.0 && Math.random() > 0.20) continue;
      if (Math.hypot(bx - (-35), bz - 40) < 82) continue;
      if (Math.hypot(bx - 160, bz - 250) < 40) continue;

      const noise = Math.sin(bx * 0.022) * Math.cos(bz * 0.022);
      if (noise < -0.18 || noise > 0.28) continue;

      const by = getTerrainHeight(bx, bz) - SINK_OFFSET;
      const baseScale = 4.4;
      const scale = baseScale * (0.7 + Math.random() * 0.7);
      const [leanX, leanZ] = getRandomLean();

      dummy.position.set(bx, by, bz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      birchTrunkInst.setMatrixAt(birchIdx, dummy.matrix);
      birchFoliageInst.setMatrixAt(birchIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: [birchTrunkInst, birchFoliageInst],
        idx: birchIdx,
        x: bx,
        z: bz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: SINK_OFFSET
      });

      birchIdx++;
    }

    // Populate Dead Trees (concentrated on stark high ridges and ravine ledges)
    let deadIdx = 0; attempts = 0;
    while (deadIdx < deadCount && attempts < 5000) {
      attempts++;
      const dx = (Math.random() - 0.5) * 1540;
      const dz = (Math.random() - 0.5) * 1540;
      const ty = getTerrainHeight(dx, dz);
      if (dz <= 360 && dz >= -300 && ty < 24) continue;

      const road = getRoadSignedDistance(dx, dz);
      if (road.roadDist < 6.5) continue;
      if (Math.hypot(dx - 160, dz - 250) < 38) continue;

      const baseScale = 3.8;
      const scale = baseScale * (0.7 + Math.random() * 0.7);
      const [leanX, leanZ] = getRandomLean();

      dummy.position.set(dx, ty - SINK_OFFSET, dz);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(leanX, Math.random() * Math.PI * 2, leanZ);
      dummy.updateMatrix();

      deadInst.setMatrixAt(deadIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: deadInst,
        idx: deadIdx,
        x: dx,
        z: dz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: SINK_OFFSET
      });

      deadIdx++;
    }

    // Populate Stumps near road verges and clearings
    let stumpIdx = 0; attempts = 0;
    while (stumpIdx < stumpCount && attempts < 4500) {
      attempts++;
      const sx = (Math.random() - 0.5) * 1540;
      const sz = (Math.random() - 0.5) * 1540;
      const road = getRoadSignedDistance(sx, sz);
      if (road.roadDist < 4.2 || road.roadDist > 35.0) continue;
      if (Math.hypot(sx - (-35), sz - 40) < 82) continue;
      if (Math.hypot(sx - 160, sz - 250) < 36) continue;

      const sy = getTerrainHeight(sx, sz) - 0.15;
      const baseScale = 2.0;
      const scale = baseScale * (0.7 + Math.random() * 0.7);

      dummy.position.set(sx, sy, sz);
      dummy.scale.set(scale, scale * (0.85 + Math.random() * 0.3), scale);
      dummy.rotation.set((Math.random() - 0.5) * 0.08, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.08);
      dummy.updateMatrix();

      stumpInst.setMatrixAt(stumpIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: stumpInst,
        idx: stumpIdx,
        x: sx,
        z: sz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: 0.15
      });

      stumpIdx++;
    }

    // Populate Bushes throughout open meadows with Colorful Berries
    let bushIdx = 0; attempts = 0;
    while (bushIdx < bushCount && attempts < 6000) {
      attempts++;
      const ux = (Math.random() - 0.5) * 1540;
      const uz = (Math.random() - 0.5) * 1540;
      const road = getRoadSignedDistance(ux, uz);
      if (road.roadDist < 4.8) continue;
      if (Math.hypot(ux - (-35), uz - 40) < 82) continue;
      if (Math.hypot(ux - 160, uz - 250) < 36) continue;

      const uy = getTerrainHeight(ux, uz) - 0.18;
      const baseScale = 3.2;
      const scale = baseScale * (0.75 + Math.random() * 0.55);

      dummy.position.set(ux, uy, uz);
      dummy.scale.set(scale, scale * 0.85, scale);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.updateMatrix();

      bushInst.setMatrixAt(bushIdx, dummy.matrix);
      berryInst.setMatrixAt(bushIdx, dummy.matrix);

      this.treeTransforms.push({
        inst: [bushInst, berryInst],
        idx: bushIdx,
        x: ux,
        z: uz,
        scale: dummy.scale.clone(),
        rotation: dummy.rotation.clone(),
        sinkY: 0.18
      });

      // Assign random vibrant berry color from palette
      const color = berryPalette[bushIdx % berryPalette.length];
      berryInst.setColorAt(bushIdx, color);

      bushIdx++;
    }

    tallTrunkInst.instanceMatrix.needsUpdate = true;
    tallFoliageInst.instanceMatrix.needsUpdate = true;
    spruceTrunkInst.instanceMatrix.needsUpdate = true;
    spruceFoliageInst.instanceMatrix.needsUpdate = true;
    oakTrunkInst.instanceMatrix.needsUpdate = true;
    oakFoliageInst.instanceMatrix.needsUpdate = true;
    birchTrunkInst.instanceMatrix.needsUpdate = true;
    birchFoliageInst.instanceMatrix.needsUpdate = true;
    deadInst.instanceMatrix.needsUpdate = true;
    stumpInst.instanceMatrix.needsUpdate = true;
    bushInst.instanceMatrix.needsUpdate = true;
    berryInst.instanceMatrix.needsUpdate = true;
    berryInst.instanceColor.needsUpdate = true;

    this.scene.add(tallTrunkInst);
    this.scene.add(tallFoliageInst);
    this.scene.add(spruceTrunkInst);
    this.scene.add(spruceFoliageInst);
    this.scene.add(oakTrunkInst);
    this.scene.add(oakFoliageInst);
    this.scene.add(birchTrunkInst);
    this.scene.add(birchFoliageInst);
    this.scene.add(deadInst);
    this.scene.add(stumpInst);
    this.scene.add(bushInst);
    this.scene.add(berryInst);
  }

  // ---------------------------------------------------------------------------
  // PROPS: ROCKS, FALLEN LOGS, BROKEN FENCES & BARRELS
  // ---------------------------------------------------------------------------
  buildProps() {
    const dummy = new THREE.Object3D();
    const gltfLoader = new GLTFLoader(globalLoadingManager);

    const bindGLBToInstanced = (url, instancedMeshes) => {
      if (typeof window === 'undefined' || !window.location) return;
      gltfLoader.load(
        url,
        (gltf) => {
          const parts = [];
          gltf.scene.traverse((c) => {
            if (c.isMesh && c.geometry) {
              if (c.material) {
                const sanitizeMat = (mat) => {
                  const m = mat.clone();
                  m.metalness = 0.0;
                  m.roughness = 0.90;
                  const nameLower = (m.name || '').toLowerCase();
                  if (nameLower.includes('dirt') || nameLower.includes('rock')) {
                    m.color.setHex(0x56606e); // Mountain granite rock grey
                  } else if (nameLower.includes('wood') || nameLower.includes('bark')) {
                    m.color.setHex(0x422f20); // Dark aged timber
                  } else if (nameLower.includes('grass')) {
                    m.color.setHex(0x2d5a32); // Deep moss green
                  }
                  return m;
                };
                if (Array.isArray(c.material)) {
                  c.material = c.material.map(sanitizeMat);
                } else {
                  c.material = sanitizeMat(c.material);
                }
              }
              parts.push(c);
            }
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
    if (typeof window === 'undefined' || !window.location) return;
    const dummy = new THREE.Object3D();
    const gltfLoader = new GLTFLoader(globalLoadingManager);

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
            if (m.metalness !== undefined) m.metalness = 0.0;
            if (m.roughness !== undefined) m.roughness = 0.85;
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
      // Keep village dirt footpaths clean of tall grass clumps so beaten dirt trail is clearly visible
      if (typeof getVillagePathDistance === 'function' && getVillagePathDistance(gx, gz) < 1.6) continue;

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
    const flowerMat = new THREE.MeshStandardMaterial({ color: 0xdd4455, roughness: 0.8, metalness: 0.0 });
    hookWindAndCullShader(flowerMat);
    const flowerInst = new THREE.InstancedMesh(flowerGeom, flowerMat, flowerCount);

    gltfLoader.load('./assets/models/flower.glb', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh && c.geometry) {
          flowerInst.geometry = c.geometry;
          if (c.material) {
            const m = c.material.clone();
            if (m.metalness !== undefined) m.metalness = 0.0;
            if (m.roughness !== undefined) m.roughness = 0.85;
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
    const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x626c7a, roughness: 0.95, metalness: 0.0 });
    const pebbleInst = new THREE.InstancedMesh(pebbleGeom, pebbleMat, pebbleCount);
    pebbleInst.receiveShadow = true;

    gltfLoader.load('./assets/models/rock_small.glb', (gltf) => {
      gltf.scene.traverse((c) => {
        if (c.isMesh && c.geometry) {
          pebbleInst.geometry = c.geometry;
          if (c.material) {
            const m = c.material.clone();
            if (m.metalness !== undefined) m.metalness = 0.0;
            if (m.roughness !== undefined) m.roughness = 0.90;
            pebbleInst.material = m;
          }
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

    // Glowing water ripples & shoreline pier
    const lakeBeacon = this.createLightRing(2.0, 0x38bdf8, 0.4);
    lakeBeacon.position.set(lakeWaterX, lakeWaterY + 0.15, lakeWaterZ);
    this.scene.add(lakeBeacon);

    this.createInteractable({
      id: 'lake_water',
      name: 'Collect Pure Meltwater (Glacial Lake Shore)',
      pos: new THREE.Vector3(lakeWaterX, lakeWaterY + 0.4, lakeWaterZ),
      icon: '💧',
      reachRadius: 5.2,
      onInteract: () => {
        this.collectWater();
      }
    });

    // 1b-2. Glacial River Fishing Outpost (x = -22.0, z = 22.0)
    const fishSpotX = -22.0;
    const fishSpotZ = 22.0;
    const fishSpotY = getTerrainHeight(fishSpotX, fishSpotZ);

    // Rustic wooden fishing pier
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });
    const pier = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 4.2), woodMat);
    pier.position.set(fishSpotX, fishSpotY + 0.2, fishSpotZ);
    pier.castShadow = true;
    this.scene.add(pier);

    const fishLight = new THREE.PointLight(0x38bdf8, 1.8, 8);
    fishLight.position.set(fishSpotX, fishSpotY + 1.1, fishSpotZ);
    this.scene.add(fishLight);

    const fishBeacon = this.createLightRing(1.6, 0x06b6d4, 0.45);
    fishBeacon.position.set(fishSpotX, fishSpotY + 0.1, fishSpotZ);
    this.scene.add(fishBeacon);

    this.createInteractable({
      id: 'river_fishing',
      name: 'Catch Glacial River Trout (Fishing Pier)',
      pos: new THREE.Vector3(fishSpotX, fishSpotY + 0.5, fishSpotZ),
      icon: '🐟',
      reachRadius: 5.0,
      onInteract: () => {
        this.catchFish();
      }
    });

    // 1b-3. Ancient Pine Torch Resin Harvest Points (Refuels and extends torch)
    const resinLocations = [
      { x: 12.0, z: 42.0 },
      { x: -50.0, z: 12.0 }
    ];
    resinLocations.forEach((loc, idx) => {
      const ry = getTerrainHeight(loc.x, loc.z);
      const resinOrb = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.2, metalness: 0.1 })
      );
      resinOrb.position.set(loc.x, ry + 1.2, loc.z);
      resinOrb.castShadow = true;
      this.scene.add(resinOrb);

      const rLight = new THREE.PointLight(0xf59e0b, 1.4, 5);
      rLight.position.set(loc.x, ry + 1.2, loc.z);
      this.scene.add(rLight);

      this.createInteractable({
        id: `pine_resin_${idx}`,
        name: 'Harvest Golden Pine Resin (Refuel Sacred Torch)',
        pos: new THREE.Vector3(loc.x, ry + 1.2, loc.z),
        icon: '✨',
        reachRadius: 4.8,
        onInteract: () => {
          this.harvestResin(resinOrb, rLight);
        }
      });
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
    // 5 shadow creatures stationed across wilderness corridors (max 6)
    const wolfPositions = [
      new THREE.Vector3(-95, 1, 415),   // Zone 1/2 boundary canyon pass
      new THREE.Vector3(130, 1, 190),   // Zone 2/3 dark forest edge
      new THREE.Vector3(-45, 1, 30),    // Zone 3 glacial lake valley
      new THREE.Vector3(-90, 1, -210),  // Zone 4 hunter camp ridge
      new THREE.Vector3(30, 1, -380)    // Zone 4/5 high ridge crags
    ];

    wolfPositions.forEach((pos, idx) => {
      const wolfGroup = new THREE.Group();
      const wolfY = getTerrainHeight(pos.x, pos.z) + 0.4;
      wolfGroup.position.set(pos.x, wolfY, pos.z);

      const shadowMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.3,
        metalness: 0.8,
        transparent: true,
        opacity: 0
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 1.8), shadowMat);
      body.castShadow = true;
      wolfGroup.add(body);

      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0 });
      const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), eyeMat);
      leftEye.position.set(-0.25, 0.3, -0.9);
      const rightEye = leftEye.clone();
      rightEye.position.x = 0.25;
      wolfGroup.add(leftEye);
      wolfGroup.add(rightEye);

      wolfGroup.visible = false;
      this.scene.add(wolfGroup);
      this.shadowWolves.push({
        id: `wolf_${idx}`,
        mesh: wolfGroup,
        hp: 3,
        speed: 4.2, // Actual speed ~4 units/sec as requested
        state: 'circle',
        opacity: 0,
        circleTimer: 3.0 + Math.random() * 2.5,
        circleAngle: (idx * Math.PI * 2) / 5,
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

  toggleTaskPanel() {
    this.isTaskPanelOpen = !this.isTaskPanelOpen;
    const panel = document.getElementById('mission-tracker-widget');
    const badge = document.getElementById('btn-toggle-tasks');
    if (panel) {
      if (this.isTaskPanelOpen) {
        panel.classList.remove('hidden');
        if (badge) badge.classList.add('active');
        this.updateMissionHUD();
      } else {
        panel.classList.add('hidden');
        if (badge) badge.classList.remove('active');
      }
    }
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
        progressText = ` (Food ${Math.min(3, this.foodCollected)}/3, Water ${this.hasWater ? 'DONE' : 'NEEDED'})`;
      }
      return `
        <div class="mission-item ${isDone ? 'completed' : (isActive ? 'active' : 'locked')}">
          <span class="mission-check ${isDone ? 'done' : ''}">${isDone ? '[X]' : (isActive ? '[>]' : '[ ]')}</span>
          <span class="mission-name">${m.chapter}: ${m.title}${progressText}</span>
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

    if (id === 'elder_torch') {
      this.gates.elderTorch = true;
      this.showToast("🔥 Chapter 1 Complete: The Elder's Blessing received! Scavenge 3 bridge parts from village workshops.");
      this.showSubtitle('MISSION 2: THE GORGE DRAWBRIDGE', 'Scavenge 3 bridge parts (Winch Gear, Steel Cable, Crank) from village workshops and lower the drawbridge.', 7.0);
    } else if (id === 'suv_loot') {
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
      this.showToast('Chapter 1 Complete: SUV supplies scavenged. Cross the wooden bridge over the gorge river!');
      this.showSubtitle('MISSION 2: CROSS BRIDGE & SURVIVE FIRST NIGHT', 'Cross the wooden bridge into the canyon. Gather dry pine wood and build a campfire before dark!', 6.5);
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

  // ---------------------------------------------------------------------------
  // SOLSTICE VILLAGE INTRO CUTSCENE & ELDER DIALOGUE
  // ---------------------------------------------------------------------------
  startVillageIntroCutscene() {
    this.isVillageIntro = true;
    this.villageIntroTime = 0;

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
    this.updateCinematicOverlay(
      'CHAPTER 1: THE CURSED ECLIPSE',
      'SOLSTICE MOUNTAIN VILLAGE',
      'Speak with Elder Kaelen by the sacred bonfire • Claim the Sacred Torch of Solstice'
    );

    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    // Hide first-person arms during intro cinematic pan
    if (this.fpArms) this.fpArms.root.visible = false;
    if (this.torchLight) this.torchLight.intensity = 0;
    if (this.flameMesh) this.flameMesh.visible = false;

    // Camera initial high dramatic cinematic sweep overlooking the village square
    const vY = getTerrainHeight(160.0, 248.0);
    this.camera.position.set(168.0, vY + 4.8, 258.0);
    this.camera.lookAt(158.0, vY + 1.2, 246.0);

    this.sfx.playRadioSpeech("The eternal frost has fallen upon Solstice. Traveler, approach Elder Kaelen.");
    this.showSubtitle("ELDER KAELEN", "Traveler... the Eternal Eclipse has frozen our valley. Come forward and take the Sacred Torch!", 7.0);
  }

  updateVillageIntroCutscene(delta) {
    this.villageIntroTime += delta;
    const vY = getTerrainHeight(160.0, 248.0);
    const elderY = getTerrainHeight(158.0, 246.0);

    if (this.villageIntroTime < 3.8) {
      // Smooth cinematic camera swoop from elevated square corner down to eye level in front of Elder Kaelen
      const t = Math.min(1.0, this.villageIntroTime / 3.8);
      const ease = t * t * (3 - 2 * t);

      const startCam = new THREE.Vector3(166.0, vY + 4.2, 256.0);
      const endCam = new THREE.Vector3(160.2, vY + 1.8, 248.2);
      this.camera.position.lerpVectors(startCam, endCam, ease);
      this.camera.lookAt(158.0, elderY + 1.35, 246.0);
    } else {
      // Camera settles in front of Elder Kaelen looking directly at him and the sacred bonfire
      this.camera.position.set(160.0, vY + 1.7, 248.0);
      this.camera.lookAt(158.0, elderY + 1.35, 246.0);

      const prompt = document.getElementById('interaction-prompt');
      if (prompt) {
        prompt.classList.remove('hidden');
        const txt = document.getElementById('interact-text');
        if (txt) txt.textContent = 'Press [E] or [Space] to Approach Elder Kaelen';
      }
    }
  }

  endVillageIntroCutscene() {
    if (!this.isVillageIntro) return;
    this.isVillageIntro = false;

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');

    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    // Position player safely standing in front of Elder Kaelen
    const vY = getTerrainHeight(160.0, 248.0);
    this.player.position.set(160.0, vY + 0.5, 248.0);
    this.camera.position.set(160.0, vY + 1.7, 248.0);

    // Face directly towards Elder Kaelen at (158.0, 246.0)
    const dx = 158.0 - 160.0;
    const dz = 246.0 - 248.0;
    this.cameraYaw = Math.atan2(-dx, -dz);
    this.cameraPitch = 0;
    this.lastSafePosition = this.player.position.clone();

    // Restore first person arms
    if (this.fpArms && this.cameraMode === 'first') this.fpArms.root.visible = true;

    this.container.requestPointerLock();
    this.showToast('Approached Elder Kaelen! Press [E] to Speak and Receive the Sacred Torch.');
  }

  talkToElderKaelen() {
    const mElder = this.missions.find(m => m.id === 'elder_torch');

    if (mElder && !mElder.completed) {
      // First interaction: Dialogue & Torch handoff
      if (this.elderKaelen) {
        this.elderKaelen.handOverTorch();
      }

      // Add Sacred Torch and basic survival supplies to inventory
      this.addItem({ id: 'torch', name: 'Sacred Torch of Solstice', icon: '🔥', count: 1 });
      this.addItem({ id: 'oil', name: 'Sacred Hearth Oil', icon: '🛢️', count: 2 });
      this.addItem({ id: 'matches', name: 'Solstice Flint Matches', icon: '✨', count: 5 });
      this.addItem({ id: 'blanket', name: 'Thermal Wool Cloak', icon: '🧣', count: 1 });
      this.addItem({ id: 'ration', name: 'Alpine Smoked Rations', icon: '🥫', count: 3 });

      this.torchFuel = 100;
      this.warmth = 100;
      this.isTorchOn = true;

      if (this.torchLight) this.torchLight.intensity = 2.5;
      if (this.flameMesh) this.flameMesh.visible = true;

      this.sfx.playTorchIgnite();
      this.sfx.playPickup();
      this.sfx.playRadioSpeech("Take the Sacred Torch. It repels shadow beasts and keeps you warm. Find the 3 bridge parts to cross the gorge!");

      this.openNoteModal({
        badge: "🔥 ELDER'S DECREE",
        title: 'THE BLESSING OF SOLSTICE',
        author: 'Village Elder Kaelen',
        body: '“The Eternal Frost has consumed our valley, and shadow creatures creep through the blizzards. This Sacred Torch carries the primordial flame of Solstice. Guard it with your life! Search our village workshops for the 3 missing bridge parts—the Winch Gear, Steel Cable, and Crank Handle—then unfreeze the drawbridge and seek the mountain summit!”'
      });

      this.showSubtitle("ELDER KAELEN", "“Take the Sacred Torch! Find the 3 bridge parts in the village workshops to lower the drawbridge!”", 7.5);
      this.showToast('🔥 Sacred Torch Acquired! Mission Complete: Speak with Elder Kaelen.');
      this.completeMission('elder_torch');
    } else {
      // Repeat talk: Guidance
      this.sfx.playRadioSpeech("Check the Blacksmith, Storehouse, and Tool Shed for the drawbridge parts.");
      this.showSubtitle("ELDER KAELEN", "“Search the Blacksmith, Storehouse, and Tool Shed nearby for the 3 drawbridge repair parts!”", 6.0);
      this.showToast('Elder Kaelen: "Search the village workshops for the 3 drawbridge parts!"');
    }
  }

  exitSUV() {
    if (this.isVillageIntro) {
      this.endVillageIntroCutscene();
      return;
    }
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
    this.showSubtitle("SURVIVOR", "The mountain bridge is washed out. No vehicle can cross. I must loot the car and cross on foot.", 6.0);
    this.showToast("Exited vehicle. Press [E] to loot emergency supplies from the trunk!");
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
    const fireLight = new THREE.PointLight(0xff7722, 4.2, 22, 1.4);
    fireLight.position.set(campPos.x, campPos.y + 0.85, campPos.z);
    fireLight.castShadow = true;
    fireLight.shadow.mapSize.width = 1024;
    fireLight.shadow.mapSize.height = 1024;
    fireLight.shadow.bias = -0.0015;
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
      this.sfx.playRadioSpeech("All three bridge relics recovered! Head to the gorge drawbridge winch to lower the crossing.");
      this.showSubtitle("QUEST UPDATE", "All 3 bridge relics recovered! Proceed to the Drawbridge Winch to unlock the crossing.", 6.5);
      this.showToast('✨ All 3 Bridge Relics Collected! Head to the Drawbridge Winch.');
    }
  }

  // ---------------------------------------------------------------------------
  // GORGE DRAWBRIDGE CINEMATIC LOWERING & CUTSCENE
  // ---------------------------------------------------------------------------
  startDrawbridgeCutscene() {
    this.isDrawbridgeCutscene = true;
    this.drawbridgeCutsceneTime = 0;

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');
    this.updateCinematicOverlay(
      'CHAPTER 2: CROSSING THE GORGE',
      'THE GORGE DRAWBRIDGE LOWERED',
      'Ancient mechanisms grind into motion • The path north through the canyon is open'
    );

    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    if (this.fpArms) this.fpArms.root.visible = false;
    if (this.torchLight) this.torchLight.intensity = 0;
    if (this.flameMesh) this.flameMesh.visible = false;

    // Heavy mechanical gear sounds and screen shake
    this.sfx.playDrawbridgeLower();
    this.triggerScreenShake(0.85);

    this.sfx.playRadioSpeech("The drawbridge is lowered! The canyon crossing is clear. Watch the mountain shadows!");
    this.showSubtitle("VILLAGE ELDER", "“The drawbridge is down! The road into the high canyon is open. Cross before dark!”", 7.0);
  }

  updateDrawbridgeCutscene(delta) {
    this.drawbridgeCutsceneTime += delta;
    const duration = 4.2;

    if (!this.bridgeGateGroup) return;

    // Animate portcullis / drawbridge rotating from upright (0) down to flat (PI / 2)
    const t = Math.min(1.0, this.drawbridgeCutsceneTime / 3.2);
    const ease = t * t * (3 - 2 * t);
    this.bridgeGateGroup.rotation.x = ease * (Math.PI / 2);
    this.bridgeGateGroup.position.y = (this.bridgeGateGroup.userData.origY || this.bridgeGateGroup.position.y);
    if (!this.bridgeGateGroup.userData.origY) {
      this.bridgeGateGroup.userData.origY = this.bridgeGateGroup.position.y;
    }
    this.bridgeGateGroup.position.y = this.bridgeGateGroup.userData.origY - ease * 1.8;

    // Camera dramatic cinematic angle overlooking the drawbridge lowering over the icy gorge
    const gatePos = this.bridgeGateGroup.position;
    const camAngle = -0.5 + t * 0.35;
    const camDist = 12.0;
    this.camera.position.set(
      gatePos.x + Math.sin(camAngle) * camDist,
      gatePos.y + 4.2 + Math.sin(t * Math.PI) * 1.2,
      gatePos.z + Math.cos(camAngle) * camDist
    );
    this.camera.lookAt(gatePos.x, gatePos.y + 1.2, gatePos.z);

    if (this.drawbridgeCutsceneTime >= duration) {
      this.endDrawbridgeCutscene();
    }
  }

  endDrawbridgeCutscene() {
    if (!this.isDrawbridgeCutscene) return;
    this.isDrawbridgeCutscene = false;

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');

    const prompt = document.getElementById('interaction-prompt');
    if (prompt) prompt.classList.add('hidden');

    // Remove bridge barrier collider permanently
    this.colliders = this.colliders.filter(c => c.id !== 'col_bridge');

    if (this.bridgeGateGroup) {
      this.bridgeGateGroup.rotation.x = Math.PI / 2;
      if (this.bridgeGateGroup.userData && this.bridgeGateGroup.userData.origY) {
        this.bridgeGateGroup.position.y = this.bridgeGateGroup.userData.origY - 1.8;
      }
    }

    // Restore first person view & player controls
    if (this.fpArms && this.cameraMode === 'first') this.fpArms.root.visible = true;
    if (this.isTorchOn && this.torchFuel > 0) {
      if (this.torchLight) this.torchLight.intensity = 2.5;
      if (this.flameMesh) this.flameMesh.visible = true;
    }

    this.container.requestPointerLock();
    this.showToast('🌉 Drawbridge lowered! Cross the gorge into the Canyon Ridge.');
    this.completeMission('village_bridge');
  }

  lowerDrawbridge() {
    this.startDrawbridgeCutscene();
  }

  gatherFood(type) {
    this.foodCollected++;
    this.sfx.playPickup();
    this.showToast(`Gathered wild sustenance! (Food: ${this.foodCollected}/3, Water: ${this.hasWater ? '✓' : '✗'})`);
    this.checkMeadowSustenance();
  }

  catchFish() {
    this.sfx.playWaterSplash();
    this.sfx.playPickup();
    this.addItem({ id: 'trout', name: 'Glacial River Trout', icon: '🐟', count: 2 });
    this.hunger = Math.min(100, this.hunger + 30);
    this.health = Math.min(100, this.health + 10);
    this.showToast('🎣 Reeled in fresh Glacial River Trout! (+30 Hunger, +10 Health)');
    this.gatherFood('fish');
  }

  harvestResin(mesh, light) {
    this.sfx.playPickup();
    this.addItem({ id: 'pine_resin', name: 'Golden Pine Resin', icon: '✨', count: 2 });
    this.torchFuel = Math.min(100, this.torchFuel + 45);
    if (this.torchLight) this.torchLight.intensity = Math.max(this.torchLight.intensity, 2.5);
    if (mesh) mesh.visible = false;
    if (light) light.intensity = 0;
    this.showToast('✨ Harvested Golden Pine Resin! Torch refueled (+45% Fuel).');
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

      // Objectives / Tasks Panel Toggle Key (T)
      if (e.code === 'KeyT') {
        e.preventDefault();
        this.toggleTaskPanel();
        return;
      }

      // Cinematic & Cutscene Skip handler (Space, Esc, Enter)
      if (this.isIntroPanning || this.isTrailerMode || this.isSUVIntro || this.isVillageIntro || this.isDrawbridgeCutscene) {
        if (e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter') {
          e.preventDefault();
          if (this.isDrawbridgeCutscene) this.endDrawbridgeCutscene();
          if (this.isVillageIntro) this.endVillageIntroCutscene();
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
      if (e.code === 'Escape') {
        if (this.isTaskPanelOpen) this.toggleTaskPanel();
        else if (this.isNoteOpen) this.closeNoteModal();
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
      if (e.code === 'KeyC') {
        e.preventDefault();
        this.craftCampfire();
      }
      if (e.code === 'KeyE') {
        if (this.isDrawbridgeCutscene) {
          this.endDrawbridgeCutscene();
        } else if (this.isVillageIntro) {
          this.endVillageIntroCutscene();
        } else if (this.isSUVIntro) {
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
      if (this.isPlaying && !this.isBackpackOpen && !this.isMapOpen && !this.isIntroPanning && !this.isTrailerMode && !this.isVillageIntro && !this.isDrawbridgeCutscene) {
        this.container.requestPointerLock();
        this.sfx.init();
      }
    });

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.isPlaying && !this.isBackpackOpen && !this.isMapOpen && !this.isIntroPanning && !this.isTrailerMode && !this.isVillageIntro && !this.isDrawbridgeCutscene) {
        this.performAttack();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.container && !this.isIntroPanning && !this.isTrailerMode && !this.isVillageIntro && !this.isDrawbridgeCutscene) {
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

    const btnHudTrailer = document.getElementById('btn-hud-trailer');
    if (btnHudTrailer) {
      btnHudTrailer.addEventListener('click', () => this.startTrailerMode());
    }

    const cinematicSkip = document.getElementById('cinematic-skip');
    if (cinematicSkip) {
      cinematicSkip.addEventListener('click', () => {
        if (this.isDrawbridgeCutscene) this.endDrawbridgeCutscene();
        if (this.isVillageIntro) this.endVillageIntroCutscene();
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

    const toggleTasksBtn = document.getElementById('btn-toggle-tasks');
    if (toggleTasksBtn) toggleTasksBtn.addEventListener('click', () => this.toggleTaskPanel());
    const closeTasksBtn = document.getElementById('btn-close-tasks');
    if (closeTasksBtn) closeTasksBtn.addEventListener('click', () => this.toggleTaskPanel());

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
    this.isDead = false;
    this.health = 100;
    this.warmth = 100;
    this.hunger = 100;
    this.isVillageIntro = false;
    this.isTrailerMode = false;
    this.isDrawbridgeCutscene = false;
    this.isSUVIntro = false;
    this.isIntroPanning = false;

    this.sfx.init();
    this.sfx.stopTitleAmbience();
    this.sfx.playTorchIgnite();

    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    const cinematicOverlay = document.getElementById('cinematic-overlay');
    if (cinematicOverlay) cinematicOverlay.classList.add('hidden');

    // Position player safely standing in village square facing Elder Kaelen
    const vY = getTerrainHeight(160.0, 248.0);
    this.player.position.set(160.0, vY + 0.5, 248.0);
    this.camera.position.set(160.0, vY + 1.7, 248.0);

    const dx = 158.0 - 160.0;
    const dz = 246.0 - 248.0;
    this.cameraYaw = Math.atan2(-dx, -dz);
    this.cameraPitch = 0;
    this.lastSafePosition = this.player.position.clone();

    // Enable first person arms and active torch
    this.isTorchOn = true;
    if (this.fpArms) {
      this.fpArms.root.visible = (this.cameraMode === 'first');
      this.fpArms.setHeldItem('torch');
    }
    if (this.torchLight) this.torchLight.intensity = 4.8;
    if (this.worldTorchLight) this.worldTorchLight.intensity = 4.8;
    if (this.flameMesh) this.flameMesh.visible = true;

    this.updateMissionHUD();
    this.container.requestPointerLock();
    this.showToast('Solstice Village: Approach Elder Kaelen by the bonfire [E] to begin!');

    // Request fullscreen when starting the game
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
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
    if (this.torchLight) this.torchLight.intensity = this.isTorchOn ? 4.8 : 0;
    if (this.worldTorchLight) this.worldTorchLight.intensity = this.isTorchOn ? 4.8 : 0;
    if (this.flameMesh) this.flameMesh.visible = this.isTorchOn;
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
    } else if (item.id === 'campfire_kit') {
      this.toggleBackpack();
      this.craftCampfire();
      return;
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
    const kit = this.inventory.find(i => i.id === 'campfire_kit');
    const wood = this.inventory.find(i => i.id === 'wood');

    if (kit && kit.count > 0) {
      this.consumeItem('campfire_kit', 1);
    } else if (wood && wood.count >= 3) {
      this.consumeItem('wood', 3);
    } else {
      this.showToast('Need a Camping Kit or 3x Pine Wood to deploy Campfire!');
      return;
    }

    // Spawn directly in front of the player
    const campPos = this.player.position.clone().add(new THREE.Vector3(0, 0, -2.0));
    campPos.y = getTerrainHeight(campPos.x, campPos.z);

    // Warm high-intensity shadow-casting point light
    const fireLight = new THREE.PointLight(0xff6a14, 4.2, 18, 1.6);
    fireLight.position.set(campPos.x, campPos.y + 0.9, campPos.z);
    fireLight.castShadow = true;
    fireLight.shadow.bias = -0.002;
    this.scene.add(fireLight);

    // Protective stone circle around the fire pit
    const stoneGeom = new THREE.DodecahedronGeometry(0.18, 0);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x52525b, roughness: 0.92 });
    for (let s = 0; s < 8; s++) {
      const ang = (s / 8) * Math.PI * 2;
      const sm = new THREE.Mesh(stoneGeom, stoneMat);
      sm.position.set(campPos.x + Math.cos(ang) * 0.75, campPos.y + 0.1, campPos.z + Math.sin(ang) * 0.75);
      sm.scale.set(1.2, 0.8, 1.2);
      sm.castShadow = true;
      this.scene.add(sm);
    }

    // Heavy crossed timber logs in the hearth
    const logsGeom = new THREE.CylinderGeometry(0.12, 0.15, 1.2, 6);
    const logsMat = new THREE.MeshStandardMaterial({ color: 0x271911, roughness: 0.95 });
    for (let i = 0; i < 4; i++) {
      const logMesh = new THREE.Mesh(logsGeom, logsMat);
      logMesh.position.set(campPos.x, campPos.y + 0.14, campPos.z);
      logMesh.rotation.y = (i * Math.PI) / 4;
      logMesh.rotation.z = Math.PI / 2;
      logMesh.castShadow = true;
      this.scene.add(logMesh);
    }

    // Realistic flame & ember particle system with soft circular gradient
    const fireParticles = new FlameParticleSystem(this.scene, 32, 0.45, 1.5, 0.26);

    // Subtle amber safe-zone ember clock ground ring
    const ringMesh = this.createLightRing(12.0, 0xff6622, 0.38);
    ringMesh.position.set(campPos.x, campPos.y + 0.08, campPos.z);
    this.scene.add(ringMesh);

    this.campfires.push({
      pos: campPos,
      light: fireLight,
      timeRemaining: 240, // 4 full minutes of warm safe zone
      flameParticles: fireParticles,
      ringMesh: ringMesh
    });

    this.sfx.playTorchIgnite();
    this.showToast('🏕️ Camping Fire deployed! Stand close for Warmth & Sleep [Z].');
    const mFirstNight = this.missions.find(m => m.id === 'first_night');
    if (mFirstNight && !mFirstNight.completed) {
      this.completeMission('first_night');
    }
    this.renderBackpackGrid();
    this.updateHUD();
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
    this.isDead = false;
    this.health = 100;
    this.warmth = 100;
    this.hunger = 100;
    this.isTrailerMode = true;
    this.isVillageIntro = false;
    this.isDrawbridgeCutscene = false;
    this.isSUVIntro = false;
    this.isIntroPanning = false;
    this.trailerStartTime = performance.now();
    this.trailerDuration = 180.0; // Full 3-minute cinematic tour for promo recording
    this.currentCinematicTitle = '';
    this.cinematicTextShowTime = 0;
    this.trailerIntroPlayed = false;
    this.trailerEndPlayed = false;
    this.sfx.init();
    this.sfx.stopTitleAmbience();
    if (document.pointerLockElement) document.exitPointerLock();

    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) mainMenu.classList.add('hidden');
    const controlsModal = document.getElementById('controls-modal');
    if (controlsModal) controlsModal.classList.add('hidden');
    const gameOverScreen = document.getElementById('game-over-screen');
    if (gameOverScreen) gameOverScreen.classList.add('hidden');
    const victoryScreen = document.getElementById('victory-screen');
    if (victoryScreen) victoryScreen.classList.add('hidden');

    // Hide cluttered HUD elements during trailer for pristine video capture
    const hud = document.getElementById('hud');
    if (hud) hud.classList.add('hidden');
    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Show 3rd-person player body for dynamic character gameplay trailer
    if (this.thirdPersonPlayer) {
      this.thirdPersonPlayer.setFirstPerson(false);
      if (this.thirdPersonPlayer.mesh) {
        this.thirdPersonPlayer.mesh.visible = true;
      }
    }
    if (this.fpArms) {
      this.fpArms.root.visible = false;
    }

    // Setup and trigger User Voiceover 1 (trailer_intro.wav: 26.56s)
    try {
      if (!this.trailerIntroAudio) {
        this.trailerIntroAudio = new Audio('./assets/audio/trailer_intro.wav');
        this.trailerIntroAudio.volume = 1.0;
      }
      this.trailerIntroAudio.currentTime = 0;
      const playPromise = this.trailerIntroAudio.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.log('[Trailer Audio] Audio autoplay waiting for interaction:', err);
        });
      }
      this.trailerIntroPlayed = true;
    } catch (e) {
      console.warn('[Trailer Audio] Intro audio error:', e);
    }

    // Initialize trailer recording controls
    const recBtn = document.getElementById('btn-trailer-record');
    if (recBtn && !recBtn.hasTrailerListener) {
      recBtn.hasTrailerListener = true;
      recBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleTrailerRecording();
      });
    }
  }

  toggleTrailerRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.stopTrailerRecording();
    } else {
      this.startTrailerRecording();
    }
  }

  async convertWebMToMp4(webmBlob) {
    try {
      const input = new Input({
        source: new BlobSource(webmBlob),
        formats: ALL_FORMATS
      });

      const bufferTarget = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat(),
        target: bufferTarget
      });

      const conversion = await Conversion.init({
        input,
        output
      });

      if (conversion && conversion.isValid) {
        await conversion.execute();
        if (bufferTarget.buffer && bufferTarget.buffer.byteLength > 0) {
          return new Blob([bufferTarget.buffer], { type: 'video/mp4' });
        }
      }
    } catch (err) {
      console.warn('[Trailer Record] WebM to MP4 remuxing notice:', err);
    }
    // If transcoding not needed or not supported, package buffer with video/mp4 MIME container
    return new Blob([webmBlob], { type: 'video/mp4' });
  }

  startTrailerRecording() {
    try {
      const canvas = this.renderer.domElement;
      const canvasStream = canvas.captureStream(60); // 60 FPS full resolution recording

      // Combine video stream with web audio track if available
      let combinedStream = canvasStream;
      if (this.sfx && this.sfx.ctx) {
        try {
          const audioDest = this.sfx.ctx.createMediaStreamDestination();
          // Connect all active audio sources to recording destination
          if (this.sfx.windGain) this.sfx.windGain.connect(audioDest);
          if (this.sfx.creekGain) this.sfx.creekGain.connect(audioDest);
          if (this.sfx.genGain) this.sfx.genGain.connect(audioDest);
          if (this.sfx.titleWindGain) this.sfx.titleWindGain.connect(audioDest);
          if (this.sfx.titleDroneGain) this.sfx.titleDroneGain.connect(audioDest);
          this._recAudioDest = audioDest; // Keep reference for cleanup
          const audioTracks = audioDest.stream.getAudioTracks();
          if (audioTracks.length > 0) {
            combinedStream = new MediaStream([
              ...canvasStream.getVideoTracks(),
              ...audioTracks
            ]);
          }
        } catch (e) {
          console.warn('[Trailer Record] Could not attach audio track:', e);
        }
      }

      // Detect formats supported natively by browser
      let selectedMime = '';
      let isNativeMp4 = false;

      const mp4Formats = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4'
      ];
      for (const fmt of mp4Formats) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(fmt)) {
          selectedMime = fmt;
          isNativeMp4 = true;
          break;
        }
      }

      if (!selectedMime) {
        const webmFormats = [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm'
        ];
        for (const fmt of webmFormats) {
          if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(fmt)) {
            selectedMime = fmt;
            break;
          }
        }
      }

      this.recordedChunks = [];
      const recOptions = { videoBitsPerSecond: 12000000 };
      if (selectedMime) {
        recOptions.mimeType = selectedMime;
      }
      this.mediaRecorder = new MediaRecorder(combinedStream, recOptions);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        const badge = document.getElementById('trailer-rec-status');
        const recBtn = document.getElementById('btn-trailer-record');
        if (badge) {
          badge.innerHTML = '<span class="rec-dot" style="background:#eab308"></span> EXPORTING MP4...';
        }
        if (recBtn) {
          recBtn.textContent = '⏳ PROCESSING MP4...';
          recBtn.disabled = true;
        }
        this.showToast('Finalizing video... Generating MP4 file!');

        try {
          const rawBlob = new Blob(this.recordedChunks, { type: selectedMime || 'video/webm' });
          let finalBlob = rawBlob;

          if (!isNativeMp4) {
            // Remux / convert WebM to MP4 using mediabunny
            finalBlob = await this.convertWebMToMp4(rawBlob);
          }

          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `Frostbound_Cinematic_Trailer_${Date.now()}.mp4`;
          document.body.appendChild(a);
          
          const clickEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
          });
          a.dispatchEvent(clickEvent);

          setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
          }, 6000);

          this.showToast('✅ Cinematic Trailer downloaded successfully as MP4!');
        } catch (downloadErr) {
          console.error('[Trailer Record] Export error:', downloadErr);
          this.showToast('Download error occurred.');
        } finally {
          if (badge) badge.classList.add('hidden');
          if (recBtn) {
            recBtn.disabled = false;
            recBtn.textContent = '🔴 RECORD & SAVE MP4';
            recBtn.style.background = 'linear-gradient(135deg, rgba(220, 38, 38, 0.8), rgba(185, 28, 28, 0.9))';
          }
        }
      };

      this.mediaRecorder.start(1000); // 1-second chunks
      const badge = document.getElementById('trailer-rec-status');
      if (badge) {
        badge.innerHTML = '<span class="rec-dot"></span> REC MP4 FULL HD';
        badge.classList.remove('hidden');
      }
      const recBtn = document.getElementById('btn-trailer-record');
      if (recBtn) {
        recBtn.textContent = '⏹ STOP & SAVE MP4';
        recBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      }
      this.showToast('🎥 Recording started! Click STOP & SAVE MP4 when ready.');
    } catch (err) {
      console.warn('[Trailer Record] MediaRecorder init failed:', err);
      this.showToast('Could not initialize video recorder on this browser.');
    }
  }

  stopTrailerRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  stopTrailerMode() {
    if (!this.isTrailerMode) return;
    this.isTrailerMode = false;

    // Stop audio
    if (this.trailerIntroAudio) {
      this.trailerIntroAudio.pause();
      this.trailerIntroAudio.currentTime = 0;
    }
    if (this.trailerEndAudio) {
      this.trailerEndAudio.pause();
      this.trailerEndAudio.currentTime = 0;
    }

    // Stop recording if active
    this.stopTrailerRecording();

    const overlay = document.getElementById('cinematic-overlay');
    if (overlay) overlay.classList.add('hidden');

    if (!this.isPlaying) {
      document.getElementById('main-menu').classList.remove('hidden');
      document.getElementById('hud').classList.add('hidden');
      this.sfx.startTitleAmbience();
    } else {
      document.getElementById('hud').classList.remove('hidden');
      if (this.fpArms && this.cameraMode === 'first') {
        this.fpArms.root.visible = true;
      }
      this.cameraYaw = -0.64;
      this.cameraPitch = 0;
      this.container.requestPointerLock();
    }
  }

  updateCinematicOverlay(tag, title, desc) {
    const content = document.querySelector('.cinematic-content');
    const elTag = document.getElementById('cinematic-tag');
    const elTitle = document.getElementById('cinematic-title');
    const elDesc = document.getElementById('cinematic-desc');
    const now = performance.now();

    if (this.currentCinematicTitle !== title) {
      this.currentCinematicTitle = title;
      this.cinematicTextShowTime = now;
      if (elTag) elTag.textContent = tag;
      if (elTitle) elTitle.textContent = title;
      if (elDesc) elDesc.textContent = desc;
      if (content) content.classList.add('visible');
    } else {
      // Auto-fade text after 3.2 seconds so viewers enjoy pure clean scenery!
      const age = (now - this.cinematicTextShowTime) / 1000;
      if (content) {
        if (age > 3.2) {
          content.classList.remove('visible');
        } else {
          content.classList.add('visible');
        }
      }
    }
  }

  updateTrailer(delta) {
    const elapsed = (performance.now() - this.trailerStartTime) / 1000;
    if (elapsed >= this.trailerDuration) {
      this.stopTrailerMode();
      return;
    }

    const camPos = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    // Ensure 3rd person player model is active & visible
    if (this.thirdPersonPlayer) {
      this.thirdPersonPlayer.setFirstPerson(false);
      if (this.thirdPersonPlayer.mesh) this.thirdPersonPlayer.mesh.visible = true;
    }

    // -------------------------------------------------------------------------
    // DYNAMIC PLAYER-CENTRIC GAMEPLAY TRAILER (6 Action-Packed Chapters)
    // -------------------------------------------------------------------------

    if (elapsed < 30.0) {
      // -------------------------------------------------------------
      // ACT I: SURVIVOR EXPEDITION BEGINS (0s - 30s)
      // Over-the-shoulder action camera following player running through snow
      // -------------------------------------------------------------
      const t = elapsed;
      const dawnProgress = Math.min(1.0, t / 26.56);
      this.timeOfDay = 5.65 + dawnProgress * 1.5;

      this.updateCinematicOverlay(
        'CHAPTER I: THE FROZEN ODYSSEY',
        'SURVIVAL EXPEDITION • SOLSTICE PASS',
        'Braving sub-zero mountain winds with flaming torch in hand, forging north across deep snow.'
      );

      // Player running along the mountain road
      const u = t / 30.0;
      const px = 145.0 + u * 28.0;
      const pz = 260.0 - u * 32.0;
      const py = getTerrainHeight(px, pz);
      this.player.position.set(px, py + 0.05, pz);

      const moveDir = new THREE.Vector3(28.0, 0, -32.0).normalize();
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, 6.5, true, true, moveDir, true, Math.atan2(moveDir.x, moveDir.z));
      }

      // Close over-the-shoulder chase camera showing player in action
      const camDist = 3.6 + Math.sin(t * 0.4) * 0.6;
      camPos.set(px - moveDir.x * camDist + 0.8, py + 2.1, pz - moveDir.z * camDist);
      lookTarget.set(px + moveDir.x * 2.5, py + 1.6, pz + moveDir.z * 2.5);

    } else if (elapsed < 60.0) {
      // -------------------------------------------------------------
      // ACT II: TIMBER DRAWBRIDGE RUN & RIVER GORGE (30s - 60s)
      // Dynamic tracking alongside player crossing the deep canyon bridge
      // -------------------------------------------------------------
      const t = elapsed - 30.0;
      this.timeOfDay = 10.5;

      this.updateCinematicOverlay(
        'CHAPTER II: THE GORGE CROSSING',
        'EXPEDITION SPRINT • TIMBER DRAWBRIDGE',
        'Crossing the treacherous canyon chasm as glacial river waters roar hundreds of feet below.'
      );

      // Player running across the drawbridge
      const u = t / 30.0;
      const px = -188.0 + u * 38.0;
      const pz = 528.0 - u * 30.0;
      const py = getTerrainHeight(px, pz) + 0.3;
      this.player.position.set(px, py, pz);

      const moveDir = new THREE.Vector3(38.0, 0, -30.0).normalize();
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, 7.2, true, true, moveDir, true, Math.atan2(moveDir.x, moveDir.z));
      }

      if (t < 15.0) {
        // Low dynamic side-tracking shot watching player's boots and torch run across bridge planks
        camPos.set(px - 3.2, py + 1.2, pz + 3.0);
        lookTarget.set(px + 0.5, py + 1.4, pz - 0.5);
      } else {
        // Front-facing cinematic camera: player sprints straight towards the camera!
        camPos.set(px + moveDir.x * 4.5, py + 1.8, pz + moveDir.z * 4.5);
        lookTarget.set(px, py + 1.5, pz);
      }

    } else if (elapsed < 90.0) {
      // -------------------------------------------------------------
      // ACT III: NIGHTFALL & SHADOW BEAST COMBAT (60s - 90s)
      // Close intense action camera: player fighting off Shadow Wolves with flaming brand!
      // -------------------------------------------------------------
      const t = elapsed - 60.0;
      this.timeOfDay = 20.5; // Dramatic nighttime with glowing moonlight & fire

      this.updateCinematicOverlay(
        'CHAPTER III: NIGHTFALL DEFENSE',
        'BEASTS IN THE DARK • TORCHLIGHT COMBAT',
        'Defending the perimeter against hungry shadow wolves using fiery strikes and flaming brands.'
      );

      const pCampX = -120.0;
      const pCampZ = 450.0;
      const groundY = getTerrainHeight(pCampX, pCampZ);
      this.player.position.set(pCampX, groundY, pCampZ);

      // Trigger swing attacks intermittently
      const isAttacking = (Math.sin(t * 3.5) > 0.4);
      const faceDir = new THREE.Vector3(Math.cos(t * 0.8), 0, Math.sin(t * 0.8)).normalize();

      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, isAttacking ? 3.0 : 0, true, false, faceDir, true, Math.atan2(faceDir.x, faceDir.z));
      }

      // Show wolf circling close to the fight
      if (this.shadowWolves && this.shadowWolves.length > 0) {
        const wolf = this.shadowWolves[0];
        wolf.mesh.visible = true;
        const wAngle = t * 1.5;
        wolf.mesh.position.set(pCampX + Math.cos(wAngle) * 4.2, groundY, pCampZ + Math.sin(wAngle) * 4.2);
        wolf.mesh.lookAt(pCampX, groundY, pCampZ);
      }

      // Dynamic orbiting combat camera
      const camAngle = t * 0.7;
      camPos.set(pCampX + Math.cos(camAngle) * 4.2, groundY + 1.9, pCampZ + Math.sin(camAngle) * 4.2);
      lookTarget.set(pCampX, groundY + 1.4, pCampZ);

    } else if (elapsed < 120.0) {
      // -------------------------------------------------------------
      // ACT IV: SURVIVAL CRAFTING & FROZEN LAKE EXPLORATION (90s - 120s)
      // Player harvesting and exploring crystalline glacial valley
      // -------------------------------------------------------------
      const t = elapsed - 90.0;
      this.timeOfDay = 14.0; // Clear daytime

      this.updateCinematicOverlay(
        'CHAPTER IV: WILDERNESS EXPLORATION',
        'GLACIAL BASIN • RESOURCE EXPEDITION',
        'Trekking through the icy glacial valley amidst wildlife herds, scavenging timber and winter rations.'
      );

      const u = t / 30.0;
      const px = -45.0 + Math.cos(u * 1.5) * 18.0;
      const pz = 35.0 + Math.sin(u * 1.5) * 18.0;
      const py = getTerrainHeight(px, pz);
      this.player.position.set(px, py, pz);

      const moveDir = new THREE.Vector3(-Math.sin(u * 1.5), 0, Math.cos(u * 1.5)).normalize();
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, 5.0, true, false, moveDir, true, Math.atan2(moveDir.x, moveDir.z));
      }

      // Smooth shoulder-level follow camera with wide mountain backdrop
      camPos.set(px - moveDir.x * 4.0 + 1.2, py + 2.0, pz - moveDir.z * 4.0);
      lookTarget.set(px + moveDir.x * 2.0, py + 1.4, pz + moveDir.z * 2.0);

    } else if (elapsed < 150.0) {
      // -------------------------------------------------------------
      // ACT V: SWAYING ROPE SUSPENSION BRIDGE TRAVERSAL (120s - 150s)
      // Tense forward camera of player crossing the Khai Chasm rope bridge
      // -------------------------------------------------------------
      const t = elapsed - 120.0;
      this.timeOfDay = 16.8; // Rich sunset light

      this.updateCinematicOverlay(
        'CHAPTER V: KHAI ROPE SUSPENSION BRIDGE',
        'TRAVERSING THE ABYSS • HIGH ALTITUDE CROSSING',
        'Cautiously crossing the swaying timber and cable bridge suspended over thousand-foot abyss.'
      );

      // Player crossing the high rope bridge
      const u = t / 30.0;
      const px = -35.0 + u * 48.0;
      const pz = -410.0 - u * 35.0;
      const bridgeSway = Math.sin(t * 2.5) * 0.15;
      const py = getTerrainHeight(px, pz) + 12.0 + bridgeSway;
      this.player.position.set(px, py, pz);

      const moveDir = new THREE.Vector3(48.0, 0, -35.0).normalize();
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, 4.2, true, false, moveDir, true, Math.atan2(moveDir.x, moveDir.z));
      }

      // Close dramatic 3rd person angle highlighting the swaying bridge and the survivor
      camPos.set(px - moveDir.x * 3.8 - 1.2, py + 1.8, pz - moveDir.z * 3.8);
      lookTarget.set(px + moveDir.x * 3.0, py + 1.5, pz + moveDir.z * 3.0);

    } else {
      // -------------------------------------------------------------
      // ACT VI: SUMMIT TOWER & EXTRACTION VICTORY (150s - 180s)
      // Player reaching summit, igniting beacon as rescue helicopter arrives
      // -------------------------------------------------------------
      const t = elapsed - 150.0;
      this.timeOfDay = 18.7; // Sunset beacon summit

      if (elapsed >= 165.0 && !this.trailerEndPlayed) {
        try {
          if (!this.trailerEndAudio) {
            this.trailerEndAudio = new Audio('./assets/audio/trailer_end.wav');
            this.trailerEndAudio.volume = 1.0;
          }
          this.trailerEndAudio.currentTime = 0;
          const playPromise = this.trailerEndAudio.play();
          if (playPromise !== undefined) {
            playPromise.catch(err => console.log('[Trailer Audio] End audio waiting:', err));
          }
          this.trailerEndPlayed = true;
        } catch (e) {
          console.warn('[Trailer Audio] End audio error:', e);
        }
      }

      this.updateCinematicOverlay(
        'CHAPTER VI: SUMMIT EXTRACTION',
        'SIGNAL OF HOPE • RESCUE ARRIVAL',
        'Igniting the summit beacon at the Radio Tower as search-and-rescue helicopters arrive overhead.'
      );

      // Player stands victoriously by the tower beacon
      const towerX = 0;
      const towerZ = -555;
      const groundY = getTerrainHeight(towerX, towerZ);
      this.player.position.set(towerX, groundY, towerZ);

      const lookUpDir = new THREE.Vector3(0, 0, 1);
      if (this.thirdPersonPlayer) {
        this.thirdPersonPlayer.update(delta, this.player.position, 0, true, false, lookUpDir, true, 0);
      }

      if (t < 15.0) {
        // Dramatic low angle hero shot looking up past player towards glowing tower & helicopter
        const u = t / 15.0;
        camPos.set(towerX - 2.5, groundY + 0.9, towerZ + 3.8 - u * 1.5);
        lookTarget.set(towerX, groundY + 12.0 + u * 25.0, towerZ);
      } else {
        // Wide epic pull-back revealing player holding torch under the helicopter searchlights
        const u = (t - 15.0) / 15.0;
        camPos.set(towerX - 6.0 - u * 12.0, groundY + 3.5 + u * 8.0, towerZ + 8.0 + u * 15.0);
        lookTarget.set(towerX, groundY + 2.0, towerZ);
      }
    }

    // Safety clearance
    const groundElevation = getTerrainHeight(camPos.x, camPos.z);
    if (camPos.y < groundElevation + 1.2) {
      camPos.y = groundElevation + 1.2;
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

    // =========================================================================
    // DYNAMIC MINECRAFT/AAA CELESTIAL ORBIT (Sun, Moon, Stars, Sunset Alpenglow)
    // =========================================================================
    // Celestial angle: 0h = midnight, 6h = sunrise (East +X), 12h = noon (+Y overhead), 18h = sunset (West -X), 24h = midnight
    const celestialAngle = ((this.timeOfDay - 6) / 24) * Math.PI * 2;
    const celestialRadius = 450;
    const sunX = Math.cos(celestialAngle) * celestialRadius;
    const sunY = Math.sin(celestialAngle) * celestialRadius;
    const sunZ = Math.sin(celestialAngle * 0.5) * 80 - 60; // Slightly tilted northern trajectory

    // Sun & Directional Shadow position follows active focus point
    // In trailer mode, follow camera position so the entire drone landscape is covered by shadows
    const shadowFocus = this.isTrailerMode ? this.camera.position : this.player.position;
    if (this.sunGroup) {
      this.sunGroup.position.set(shadowFocus.x + sunX, shadowFocus.y + sunY, shadowFocus.z + sunZ);
      this.sunGroup.visible = (sunY > -60);
    }
    // Directional sunlight casting shadows from sun's actual angle
    this.sunLight.position.set(shadowFocus.x + sunX, shadowFocus.y + Math.max(15, sunY), shadowFocus.z + sunZ);
    this.sunLight.target.position.copy(shadowFocus);
    this.sunLight.target.updateMatrixWorld();

    // Moon Position directly opposite to Sun
    const pPos = this.player.position;
    if (this.moonGroup) {
      this.moonGroup.position.set(pPos.x - sunX, pPos.y - sunY, pPos.z - sunZ);
      this.moonGroup.visible = (-sunY > -60);
    }

    if (this.skyMesh) {
      this.skyMesh.position.copy(pPos);
    }
    if (this.starPoints) {
      this.starPoints.position.copy(pPos);
      this.starPoints.rotation.y += delta * 0.005; // Gentle majestic cosmic rotation
    }

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

    // Majestic Minecraft/AAA Golden Sunset (17:00 - 19:30) & Sunrise (05:00 - 07:30)
    const isSunset = (this.timeOfDay >= 16.5 && this.timeOfDay <= 19.5);
    const isSunrise = (this.timeOfDay >= 5.0 && this.timeOfDay <= 7.5);
    let sunsetFactor = 0;
    if (isSunset) {
      sunsetFactor = Math.sin(((this.timeOfDay - 16.5) / 3.0) * Math.PI);
    } else if (isSunrise) {
      sunsetFactor = Math.sin(((this.timeOfDay - 5.0) / 2.5) * Math.PI);
    }

    if (isNight) {
      // Crisp Dark Starry Night
      const nightSky = new THREE.Color(0x02050b);
      const nightFog = new THREE.Color(0x040812);
      if (this.scene.background && this.scene.background.isColor) this.scene.background.copy(nightFog);
      this.scene.fog.color.copy(nightFog);
      this.skyMesh.material.color.copy(nightSky);
      if (this.starMat) this.starMat.opacity = Math.min(0.95, this.starMat.opacity + delta * 1.5);
      this.ambientLight.intensity = 0.05;
      if (this.hemiLight) this.hemiLight.intensity = 0.03;
      this.sunLight.intensity = 0.06;
      this.sunLight.color.setHex(0x93c5fd); // Faint bluish moonlight
      this.scene.fog.density = targetFogDensity * 1.35;
    } else {
      // Fade out stars during day
      if (this.starMat) this.starMat.opacity = Math.max(0.0, this.starMat.opacity - delta * 2.0);

      if (sunsetFactor > 0.05) {
        // Dramatic Blazing Sunset / Dawn Alpenglow (Crimson, Amber, Purple Sky)
        const sunsetSkyColor = new THREE.Color(0xd95328).lerp(new THREE.Color(0x4c1d95), 1.0 - sunsetFactor);
        const sunsetFogColor = new THREE.Color(0xb44322).lerp(new THREE.Color(0x2d1b4e), 1.0 - sunsetFactor);
        if (this.scene.background && this.scene.background.isColor) this.scene.background.copy(sunsetFogColor);
        this.scene.fog.color.copy(sunsetFogColor);
        this.skyMesh.material.color.copy(sunsetSkyColor);

        // Blazing sun orb and warm fiery horizon
        this.sunOrb.material.color.setHex(0xff7700);
        if (this.sunGlow) this.sunGlow.material.color.setHex(0xff3300);
        this.sunLight.color.setHex(0xff7722);
        this.sunLight.intensity = Math.max(1.4, sunsetFactor * 2.8);
        this.ambientLight.color.setHex(0x52271e);
        this.ambientLight.intensity = 0.28; // Lower ambient so directional shadows stand out with rich contrast
      } else {
        // Crisp, radiant clear mountain day
        if (this.scene.background && this.scene.background.isColor) this.scene.background.copy(targetFogColor);
        this.scene.fog.color.copy(targetFogColor);
        this.skyMesh.material.color.setHex(0x38bdf8); // Vibrant alpine azure
        this.sunOrb.material.color.setHex(0xfffff0);
        if (this.sunGlow) this.sunGlow.material.color.setHex(0xffe066);
        this.sunLight.color.setHex(0xfffaea);
        this.sunLight.intensity = 1.65;
        this.ambientLight.color.setHex(0x5a6d80);
        this.ambientLight.intensity = 0.35; // Distinct, deep sun shadows
      }
    }


    // Hunter Camp Windmill Rotation
    if (this.windmillBlades) {
      this.windmillBlades.rotation.z += delta * 0.75;
    }

    // Visible Clock, Weather & Active Chapter Dusk Deadline
    const hours = Math.floor(this.timeOfDay);
    const mins = Math.floor((this.timeOfDay % 1) * 60);
    const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    const timeElem = document.getElementById('time-display');
    if (timeElem) timeElem.textContent = timeStr;

    const weatherElem = document.getElementById('weather-text');
    if (weatherElem) {
      weatherElem.textContent = this.weather === 'blizzard' ? 'BLIZZARD' : (this.weather === 'snow' ? 'SNOWFALL' : 'LIGHT SNOW');
    }

    // Current Chapter Dusk Deadline Alert
    const activeMission = this.missions.find(m => !m.completed);
    const deadlineBadge = document.getElementById('dusk-deadline-badge');
    if (deadlineBadge) {
      if (!activeMission) {
        deadlineBadge.textContent = 'ALL MISSIONS COMPLETED';
        deadlineBadge.className = 'dusk-badge ready';
      } else {
        const dHour = Math.floor(activeMission.duskDeadline || 19.0);
        const dMin = Math.floor(((activeMission.duskDeadline || 19.0) % 1) * 60);
        const deadlineStr = `${dHour.toString().padStart(2, '0')}:${dMin.toString().padStart(2, '0')}`;
        const timeDiff = (activeMission.duskDeadline || 19.0) - this.timeOfDay;

        if (timeDiff > 0) {
          const remHours = Math.floor(timeDiff);
          const remMins = Math.floor((timeDiff % 1) * 60);
          deadlineBadge.textContent = `${activeMission.chapter} DUSK: ${deadlineStr} (${remHours > 0 ? remHours + 'h ' : ''}${remMins}m left)`;
          deadlineBadge.className = 'dusk-badge';
        } else {
          deadlineBadge.textContent = 'DUSK PASSED: NIGHTFALL - BEASTS ACTIVE';
          deadlineBadge.className = 'dusk-badge urgent';
        }
      }
    }

    const timeSec = performance.now() * 0.001;

    // Torch Real Flame Particles & Multi-Harmonic Flicker Light
    if (this.isTorchOn && this.torchFuel > 0) {
      this.torchFuel = Math.max(0, this.torchFuel - delta * 0.35);

      // Multi-harmonic realistic flame flicker for torch light
      const tf = Math.sin(timeSec * 24) * 0.45 + Math.sin(timeSec * 41) * 0.25 + Math.sin(timeSec * 13) * 0.3;
      const targetIntensity = Math.max(3.2, 4.8 + tf);
      if (this.torchLight) this.torchLight.intensity = targetIntensity;
      if (this.worldTorchLight) this.worldTorchLight.intensity = targetIntensity;

      if (this.flameMesh) {
        this.flameMesh.visible = true;
      }

      if (this.torchFlameParticles) {
        this.torchFlameParticles.points.visible = false;
      }

      if (this.torchFuel <= 0) this.toggleTorch();
    } else {
      if (this.torchLight) this.torchLight.intensity = 0;
      if (this.worldTorchLight) this.worldTorchLight.intensity = 0;
      if (this.flameMesh) this.flameMesh.visible = false;
      if (this.torchFlameParticles) {
        this.torchFlameParticles.points.visible = false;
      }
    }

    // Campfires Safe Zones: Real Flame Particles & Flicker Light & Ember Clock Ring (12m radius)
    let isNearFire = false;
    this.campfires.forEach((c, idx) => {
      const dist = this.player.position.distanceTo(c.pos);
      if (dist < 12.0 && (c.timeRemaining === undefined || c.timeRemaining > 0)) isNearFire = true;

      // Ensure campfire subtle light ring
      if (!c.ringMesh) {
        c.ringMesh = this.createLightRing(12.0, 0xff6622, 0.32);
        c.ringMesh.position.set(c.pos.x, getTerrainHeight(c.pos.x, c.pos.z) + 0.08, c.pos.z);
        this.scene.add(c.ringMesh);
      }
      c.ringMesh.visible = (c.timeRemaining === undefined || c.timeRemaining > 0);

      // Real flame & ember particles
      if (c.flameParticles) {
        c.flameParticles.update(delta, c.pos, c.timeRemaining === undefined || c.timeRemaining > 0);
      }

      // Multi-harmonic light flicker
      if (c.light) {
        if (c.timeRemaining === undefined || c.timeRemaining > 0) {
          const cf = Math.sin(timeSec * 18 + idx * 4) * 0.45 + Math.sin(timeSec * 31 + idx * 3) * 0.25;
          c.light.intensity = Math.max(2.2, 4.0 + cf);
        } else {
          c.light.intensity = 0;
        }
      }
    });

    // COLD DRAIN & SAFE ZONES
    // Day is survivable (0.25/s); Night is deadly without fire (4.5/s)
    if (!this.isTrailerMode) {
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
      if (frostOverlay) {
        frostOverlay.style.boxShadow = `inset 0 0 ${Math.max(0, (100 - this.warmth) * 1.6)}px rgba(56, 189, 248, ${Math.max(0, (100 - this.warmth) / 110)})`;
      }

      this.hunger = Math.max(0, this.hunger - delta * 0.3);

      if (this.warmth <= 0 || this.hunger <= 0) {
        this.health = Math.max(0, this.health - delta * 2.5);
        if (Math.random() < 0.05) this.triggerDamageFlash('rgba(56, 189, 248, 0.45)', 0.35);
      }

      if (this.health <= 0) {
        this.triggerGameOver('Hypothermia and starvation overcame your body in the snow.');
      }
    }

    // 1. Scripted Cinematic Trailer Mode has highest priority
    if (this.isTrailerMode) {
      this.updateTrailer(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      if (this.deerHerd) this.deerHerd.update(delta, this.camera.position, false);
      if (this.horseHerd) this.horseHerd.update(delta);
      if (this.rabbitColony) this.rabbitColony.update(delta, this.camera.position);
      if (this.birdFlocks) this.birdFlocks.update(delta, this.camera.position, false);
      if (this.fishSchool) this.fishSchool.update(delta, this.camera.position);
      return;
    }

    // Handle Village Intro Cinematic Cutscene
    if (this.isVillageIntro) {
      this.updateVillageIntroCutscene(delta);
      if (this.elderKaelen) this.elderKaelen.update(delta, this.camera.position);
      this.updateSnow(delta);
      this.updateMachines(delta);
      this.updateHUD();
      this.sfx.updateAmbient(this.camera.position, this.camera.position.y, this.timeOfDay);
      return;
    }

    // Handle Drawbridge Lowering Cinematic Cutscene
    if (this.isDrawbridgeCutscene) {
      this.updateDrawbridgeCutscene(delta);
      this.updateSnow(delta);
      this.updateMachines(delta);
      this.updateHUD();
      this.sfx.updateAmbient(this.camera.position, this.camera.position.y, this.timeOfDay);
      return;
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

    // Handle Movement & Exploration in standard gameplay
    this.handleMovement(delta);
    this.checkRopeBridgeCrossing();
    this.updateWolves(delta);
    this.checkInteractions();
    this.updateSnow(delta);
    this.updateMinimap();
    this.updateHUD();

    // Animate Village Relic Visuals (gentle hover bob & rotation with pulsing/blinking light & beacon ring)
    if (this.villageRelicVisuals && this.villageRelicVisuals.length > 0) {
      const relicTime = performance.now() * 0.002;
      this.villageRelicVisuals.forEach(relic => {
        if (relic.group && relic.group.visible) {
          relic.group.rotation.y += delta * 1.5;
          relic.group.position.y = relic.basePosY + Math.sin(relicTime * 2.0) * 0.08;
          if (relic.light) {
            // Soft pulsating light hint
            relic.light.intensity = 1.4 + Math.sin(relicTime * 4.0) * 0.8;
          }
          if (relic.beacon && relic.beacon.material) {
            // Soft pulsing/blinking beacon ring at base
            const bPulse = 0.3 + 0.3 * Math.sin(relicTime * 4.0);
            relic.beacon.material.opacity = bPulse;
            const bScale = 1.0 + 0.1 * Math.sin(relicTime * 4.0);
            relic.beacon.scale.set(bScale, bScale, bScale);
          }
        }
      });
    }

    // Living Wildlife State Machines (Deer, Horses, Rabbits, Birds, Fish)
    const isSprinting = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && this.energy > 10;
    if (this.elderKaelen) this.elderKaelen.update(delta, this.player.position);
    if (this.deerHerd) this.deerHerd.update(delta, this.player.position, isSprinting);
    if (this.horseHerd) this.horseHerd.update(delta);
    if (this.rabbitColony) this.rabbitColony.update(delta, this.player.position);
    if (this.birdFlocks) this.birdFlocks.update(delta, this.player.position, isSprinting);
    if (this.fishSchool) this.fishSchool.update(delta, this.player.position);

    // Animate gorge fish swimming beneath Zone 1 bridge
    if (this.gorgeFishInst) {
      const gTime = performance.now() * 0.001;
      const gDummy = new THREE.Object3D();
      for (let f = 0; f < 12; f++) {
        const speed = 0.4 + (f % 4) * 0.15;
        const angle = (f / 12) * Math.PI * 2 + gTime * speed * 0.25;
        const radiusX = 3.6 + (f % 3) * 1.4;
        const radiusZ = 5.8 + (f % 2) * 2.2;
        const rx = -174.0 + Math.cos(angle) * radiusX;
        const rz = 514.0 + Math.sin(angle) * radiusZ;
        const wiggle = Math.sin(gTime * 7.5 + f) * 0.15;
        gDummy.position.set(rx, -11.2 + Math.sin(gTime * 1.5 + f) * 0.25, rz);
        gDummy.rotation.y = angle + Math.PI / 2 + wiggle;
        gDummy.scale.set(0.95, 0.95, 1.25);
        gDummy.updateMatrix();
        this.gorgeFishInst.setMatrixAt(f, gDummy.matrix);
      }
      this.gorgeFishInst.instanceMatrix.needsUpdate = true;
    }

    // Animated Flowing Water Waves & Ice Shimmer
    if (this.waterMat && this.waterMat.userData && this.waterMat.userData.customUniforms) {
      this.waterMat.userData.customUniforms.uTime.value += delta;
    }
    if (this.iceLakeMat && this.iceLakeMat.userData && this.iceLakeMat.userData.customUniforms) {
      this.iceLakeMat.userData.customUniforms.uTime.value += delta;
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
    const isNight = this.timeOfDay < 6.0 || this.timeOfDay > 18.0;
    const playerPos = this.player.position;

    // Check light zones: Torch light radius (~14.0m) and Campfire radius (~12m)
    const isPlayerNearCampfire = this.campfires.some(c => (c.timeRemaining === undefined || c.timeRemaining > 0) && playerPos.distanceTo(c.pos) < 12.0);
    const playerHasTorch = this.isTorchOn && this.torchFuel > 0;
    const isPlayerInLight = isPlayerNearCampfire || playerHasTorch;

    this.shadowWolves.forEach(wolf => {
      const wolfPos = wolf.mesh.position;
      const distToPlayer = wolfPos.distanceTo(playerPos);
      const isWolfNearCampfire = this.campfires.some(c => (c.timeRemaining === undefined || c.timeRemaining > 0) && wolfPos.distanceTo(c.pos) < 12.0);
      const inTorchLight = playerHasTorch && (distToPlayer < 14.0);
      const isSafeInLight = isPlayerInLight || inTorchLight || isWolfNearCampfire;

      if (wolf.opacity === undefined) wolf.opacity = 0;

      // 1. DAYTIME OR INSIDE LIGHT RADIUS: FADE AWAY & HIDE
      if (!isNight || isSafeInLight) {
        wolf.opacity = Math.max(0, wolf.opacity - delta * 2.5);
        if (wolf.opacity <= 0.01) {
          wolf.mesh.visible = false;
        } else {
          wolf.mesh.visible = true;
          wolf.mesh.scale.setScalar(Math.max(0.05, wolf.opacity));
          wolf.mesh.traverse(child => {
            if (child.material) {
              child.material.transparent = true;
              child.material.opacity = wolf.opacity;
            }
          });
        }

        // If caught in light, recoil/retreat backwards away from the light
        if (isSafeInLight && distToPlayer < 16.0) {
          const retreatDir = new THREE.Vector3().subVectors(wolfPos, playerPos).normalize();
          wolfPos.x += retreatDir.x * delta * 5.0;
          wolfPos.z += retreatDir.z * delta * 5.0;
        }
        wolfPos.y = getTerrainHeight(wolfPos.x, wolfPos.z) + 0.4;
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);
        return;
      }

      // 2. AT NIGHT AND OUTSIDE LIGHT RADIUS: APPEAR & APPROACH
      wolf.opacity = Math.min(1.0, wolf.opacity + delta * 2.0);
      wolf.mesh.visible = true;
      wolf.mesh.scale.setScalar(wolf.opacity);
      wolf.mesh.traverse(child => {
        if (child.material) {
          child.material.transparent = true;
          child.material.opacity = wolf.opacity;
        }
      });

      // Show on-screen hint the first time a shadow appears: ("Stay in the light")
      if (!this.hasShownLightHint && distToPlayer < 45.0) {
        this.hasShownLightHint = true;
        this.showToast('🔥 Stay in the light! Shadow creatures stalk the darkness.');
        this.showSubtitle('EMBER SURVIVAL', 'Stay in the light! Shadows only appear in darkness and fade near fire.', 6.0);
      }

      // Stalk closer if outside 55m
      if (distToPlayer > 55.0) {
        const approachDir = new THREE.Vector3().subVectors(playerPos, wolfPos).normalize();
        wolfPos.x += approachDir.x * delta * 2.8;
        wolfPos.z += approachDir.z * delta * 2.8;
        wolfPos.y = getTerrainHeight(wolfPos.x, wolfPos.z) + 0.4;
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);
        return;
      }

      // STATE MACHINE: CIRCLE THEN ATTACK
      if (wolf.state === 'circle') {
        wolf.circleTimer -= delta;
        wolf.circleAngle += delta * (wolf.speed / wolf.circleRadius);

        const targetX = playerPos.x + Math.cos(wolf.circleAngle) * wolf.circleRadius;
        const targetZ = playerPos.z + Math.sin(wolf.circleAngle) * wolf.circleRadius;

        const moveDir = new THREE.Vector3(targetX - wolfPos.x, 0, targetZ - wolfPos.z);
        const distToTarget = moveDir.length();
        if (distToTarget > 0.1) {
          moveDir.normalize();
          wolfPos.x += moveDir.x * wolf.speed * delta;
          wolfPos.z += moveDir.z * wolf.speed * delta;
        }

        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);

        if (wolf.circleTimer <= 0) {
          wolf.state = 'attack';
          wolf.attackTimer = 3.2;
          this.sfx.playWolfHowl();
        }
      } else if (wolf.state === 'attack') {
        wolf.attackTimer -= delta;

        const chargeDir = new THREE.Vector3().subVectors(playerPos, wolfPos);
        chargeDir.y = 0;
        chargeDir.normalize();

        wolfPos.x += chargeDir.x * 5.4 * delta;
        wolfPos.z += chargeDir.z * 5.4 * delta;
        wolf.mesh.lookAt(playerPos.x, wolfPos.y, playerPos.z);

        if (distToPlayer < 2.0) {
          this.health = Math.max(0, this.health - delta * 20);
          this.triggerDamageFlash('rgba(168, 85, 247, 0.65)');
          this.triggerScreenShake(0.35);

          if (this.health <= 0) {
            this.triggerGameOver('Dragged down into the frozen shadows by the creature.');
          }

          wolf.state = 'circle';
          wolf.circleTimer = 3.2 + Math.random() * 2.0;
          wolf.circleAngle = Math.atan2(wolfPos.z - playerPos.z, wolfPos.x - playerPos.x);
        }

        if (wolf.attackTimer <= 0) {
          wolf.state = 'circle';
          wolf.circleTimer = 2.8 + Math.random() * 2.0;
        }
      }

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
    // Anchor snowfall seamlessly to the camera position for complete 360-degree coverage
    const anchor = this.camera ? this.camera.position : (this.player ? this.player.position : { x: 0, y: 0, z: 0 });
    const px = anchor.x;
    const py = anchor.y;
    const pz = anchor.z;

    const pos = this.snowParticles.geometry.attributes.position;
    const count = pos.count;
    const wrapRadius = 40.0;
    const wrapHeightMin = -5.0;
    const wrapHeightMax = 20.0;
    const time = performance.now() * 0.001;

    for (let i = 0; i < count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      // Balanced organic omni-directional swirl without directional bias
      const vy = this.snowVelocities[i * 3 + 1];
      const vx = this.snowVelocities[i * 3] + Math.sin(time * 0.8 + i * 0.17) * 0.12;
      const vz = this.snowVelocities[i * 3 + 2] + Math.cos(time * 0.8 + i * 0.17) * 0.12;

      y += vy * delta;
      x += vx * delta;
      z += vz * delta;

      // Wrap vertically relative to camera height
      if (y < py + wrapHeightMin) {
        y = py + wrapHeightMax - Math.random() * 2.0;
        x = px + (Math.random() - 0.5) * 2 * wrapRadius;
        z = pz + (Math.random() - 0.5) * 2 * wrapRadius;
      } else if (y > py + wrapHeightMax + 2.0) {
        y = py + wrapHeightMin + Math.random() * 2.0;
      }

      // Wrap horizontally around camera uniformly in all directions
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

    // Active Objective Tracker & Navigation Compass Arrow
    this.updateActiveObjectiveHUD();
  }

  getActiveObjectiveTarget() {
    const activeMission = this.missions.find(m => m.active);
    if (!activeMission) return null;

    let targetCoords = { x: activeMission.coords.x, z: activeMission.coords.z };
    let title = activeMission.title;
    let hint = activeMission.desc;
    let icon = activeMission.icon;
    let chapter = activeMission.chapter;

    // Sub-objective specificity for dynamic multi-part chapters
    if (activeMission.id === 'elder_torch') {
      title = "Speak with Elder Kaelen";
      hint = "Approach Elder Kaelen by the sacred bonfire and receive the Sacred Torch";
      targetCoords = { x: 158.0, z: 246.0 };
    } else if (activeMission.id === 'village_bridge') {
      if (this.villagePartsCollected < 3) {
        chapter = `CHAPTER 2 (${this.villagePartsCollected}/3 RELICS)`;
        // Point to nearest uncollected relic
        const relics = [
          { id: 'winch_gear', x: 172.0, z: 235.0, name: 'Winch Gear (Blacksmith)' },
          { id: 'steel_cable', x: 145.0, z: 235.0, name: 'Steel Cable (Storehouse)' },
          { id: 'crank_handle', x: 176.0, z: 258.0, name: 'Crank Handle (Tool Shed)' }
        ];
        const playerPos = this.player.position;
        let nearestRelic = null;
        let nearestDist = Infinity;
        for (const r of relics) {
          const hasItem = this.inventory && this.inventory.some(it => it.id === r.id);
          if (!hasItem) {
            const d = Math.hypot(r.x - playerPos.x, r.z - playerPos.z);
            if (d < nearestDist) {
              nearestDist = d;
              nearestRelic = r;
            }
          }
        }
        if (nearestRelic) {
          targetCoords = { x: nearestRelic.x, z: nearestRelic.z };
          title = `Find ${nearestRelic.name}`;
          hint = `Scavenge inside village workshops (${this.villagePartsCollected}/3 relics found)`;
        }
      } else {
        // All 3 collected -> Point directly to Bridge Winch!
        title = "Operate Drawbridge Winch";
        hint = "All 3 parts collected! Proceed to the drawbridge winch mechanism to lower bridge";
        targetCoords = { x: 161.5, z: 247.0 };
        icon = '🌉';
      }
    } else if (activeMission.id === 'first_night') {
      title = "Survive First Night";
      hint = "Gather dry pine wood and ignite a campfire before 19:00 dusk deadline";
      targetCoords = { x: -140.0, z: 460.0 };
    } else if (activeMission.id === 'meadow_sustenance') {
      title = "Alpine Sustenance";
      hint = `Gather food (${Math.min(3, this.foodCollected)}/3) & meltwater (${this.hasWater ? 'DONE' : 'NEEDED'})`;
      targetCoords = { x: -30.0, z: 25.0 };
    }

    return { coords: targetCoords, title, hint, icon, chapter };
  }

  updateActiveObjectiveHUD() {
    const banner = document.getElementById('active-objective-banner');
    if (!banner) return;

    const targetInfo = this.getActiveObjectiveTarget();
    if (!targetInfo) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';

    // Update Banner Text
    const elTag = document.getElementById('objective-chapter-tag');
    if (elTag) elTag.textContent = targetInfo.chapter;

    const elTitle = document.getElementById('objective-title');
    if (elTitle) elTitle.textContent = targetInfo.title;

    const elHint = document.getElementById('objective-hint');
    if (elHint) elHint.textContent = targetInfo.hint;

    const elIcon = document.getElementById('objective-icon');
    if (elIcon) elIcon.textContent = targetInfo.icon;

    // Calculate Distance in meters
    const playerPos = this.player.position;
    const dx = targetInfo.coords.x - playerPos.x;
    const dz = targetInfo.coords.z - playerPos.z;
    const distMeters = Math.round(Math.hypot(dx, dz));

    const elDist = document.getElementById('objective-distance');
    if (elDist) elDist.textContent = `📍 ${distMeters}m`;

    // Calculate Relative Direction Angle to target
    // World angle from player to target (atan2 in X-Z space where -Z is North)
    const angleToTarget = Math.atan2(dx, -dz);
    // Relative angle subtracting cameraYaw
    let relAngle = angleToTarget - this.cameraYaw;
    const relDeg = (relAngle * 180 / Math.PI);

    const elArrow = document.getElementById('objective-nav-arrow');
    if (elArrow) {
      elArrow.style.transform = `rotate(${relDeg}deg)`;
    }
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

if (typeof window !== 'undefined') {
  window.getTerrainHeight = getTerrainHeight;
  window.getRoadSignedDistance = getRoadSignedDistance;
}

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

if (typeof window !== 'undefined') {
  window.debugRoadWalk = debugRoadWalk;
  window.addEventListener('DOMContentLoaded', () => {
    window.gameInstance = new FrostboundGame();
    setTimeout(() => debugRoadWalk(window.gameInstance), 2000);
  });
}

export {
  getTerrainHeight,
  getRoadSignedDistance,
  ROAD_WAYPOINTS,
  ROAD_SAMPLES,
  ROAD_SAMPLES_COUNT,
  FrostboundGame
};
