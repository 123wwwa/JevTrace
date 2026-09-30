// Background music and sound effects for JevTraceShort, synthesized here so there is no licence to track and
// every hit lands on the frame its animation starts: both read src/timeline.json. Deterministic (seeded
// noise), so CI regenerates the same file before rendering: public/audio/music.wav (44.1 kHz, 16-bit mono).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const videoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeline = JSON.parse(fs.readFileSync(path.join(videoRoot, 'src', 'timeline.json'), 'utf8'));
const rate = 44100;
const seconds = timeline.duration / timeline.fps;
const at = frame => frame / timeline.fps;
const bpm = 120;
const beat = 60 / bpm;
const out = new Float32Array(Math.round(rate * seconds));

let seed = 0x5eed;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 31 - 1; };
const midi = note => 440 * 2 ** ((note - 69) / 12);

/** Adds `length` seconds of `voice(t)` (t from 0) starting at `start`, shaped by an attack/release envelope. */
function add(start, length, gain, voice, attack = 0.005, release = 0.05) {
  const from = Math.round(start * rate);
  const count = Math.round(length * rate);
  for (let index = 0; index < count && from + index < out.length; index++) {
    const t = index / rate;
    const envelope = Math.min(1, t / attack) * Math.min(1, (length - t) / release);
    out[from + index] += gain * Math.max(0, envelope) * voice(t);
  }
}
const saw = (frequency, t) => 2 * ((frequency * t) % 1) - 1;
const sine = (frequency, t) => Math.sin(2 * Math.PI * frequency * t);

// ---- music: one chord per bar (2 s) -------------------------------------------------------------------
// Am F C G three times, then F G and C for the name.
const loop = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const chords = [...loop, ...loop, ...loop, [53, 57, 60], [55, 59, 62], [48, 52, 55, 60]];
const bars = Math.ceil(seconds / (4 * beat));
chords.slice(0, bars).forEach((chord, bar) => {
  const start = bar * 4 * beat;
  const last = bar === bars - 1;
  const length = last ? seconds - start : 4 * beat + 0.3;
  // Pad: two slightly detuned saws per note through a one-pole low-pass that opens once the steps start.
  for (const note of chord) {
    let state = 0;
    const cutoff = start < at(timeline.parse[0]) ? 0.03 : 0.06;
    add(start, length, 0.05, t => {
      const raw = saw(midi(note) * 0.998, t) + saw(midi(note + 12) * 1.003, t) * 0.5;
      state += cutoff * (raw - state);
      return state;
    }, 0.35, 0.45);
  }
  // Bass on eighth notes through the four steps and the results.
  if (start >= at(timeline.task[0]) && start < at(timeline.outro[0])) {
    for (let eighth = 0; eighth < 8; eighth++) {
      add(start + eighth * beat / 2, beat / 2 - 0.02, 0.15, t => sine(midi(chord[0] - 12), t) + 0.3 * sine(midi(chord[0]), t), 0.005, 0.04);
    }
  }
});

// Drums: kick from the parse step, off-beat hats from the compiler step, both until the name.
for (let time = at(timeline.parse[0]); time < at(timeline.outro[0]); time += beat) {
  add(time, 0.28, 0.5, t => sine(45 + 110 * Math.exp(-t * 30), t) * Math.exp(-t * 9));
}
for (let time = at(timeline.compiler[0]) + beat / 2; time < at(timeline.outro[0]); time += beat) {
  add(time, 0.06, 0.07, () => noise(), 0.001, 0.05);
}

// ---- sound effects, on the frames JevTraceShort animates ------------------------------------------------
const whoosh = (start, length, gain, rising) => {
  let state = 0;
  add(start, length, gain, t => {
    const sweep = rising ? t / length : 1 - t / length;
    state += (0.02 + 0.25 * sweep) * (noise() - state);
    return state;
  }, length * 0.6, length * 0.35);
};
const pluck = (start, note, gain = 0.15) => add(start, 0.35, gain, t => (sine(midi(note), t) + 0.4 * sine(midi(note + 12), t)) * Math.exp(-t * 11));
const bell = (start, notes, gain = 0.1) => notes.forEach(note => add(start, 1.8, gain, t => (sine(midi(note), t) + 0.25 * sine(midi(note) * 2.76, t)) * Math.exp(-t * 2.2), 0.003, 0.3));
const impact = (start, gain = 0.55) => add(start, 0.9, gain, t => sine(40 + 90 * Math.exp(-t * 20), t) * Math.exp(-t * 4) + 0.3 * noise() * Math.exp(-t * 14));
const [task] = timeline.task;
const [parse] = timeline.parse;
const [jev] = timeline.jev;
const [compiler] = timeline.compiler;
const [budget] = timeline.budget;
const [results] = timeline.results;
const [outro] = timeline.outro;

whoosh(at(task - 30), at(30), 0.3, true);                                            // into the task
for (let frame = task + 6; frame < task + 60; frame += 3) add(at(frame), 0.02, 0.04, () => noise()); // typing
whoosh(at(parse - 10), at(22), 0.2, false);                                          // task docks, step 1
for (let index = 0; index < 12; index++) pluck(at(parse + 10 + index * 6), [69, 72, 76, 79][index % 4] + 12, 0.06); // files light up
whoosh(at(jev - 10), at(22), 0.2, false);                                             // step 2
for (let index = 0; index < 8; index++) pluck(at(jev + 56 + index * 5), [76, 79, 81, 84][index % 4], 0.11); // candidate cards
bell(at(jev + 96), [81, 88], 0.08);                                                  // Jev keeps the leads
whoosh(at(compiler - 8), at(30), 0.2, false);                                         // step 3, lead to the centre
for (let index = 0; index < 6; index++) pluck(at(compiler + 30 + index * 12), 69 + index * 3, 0.13); // compiler edges
whoosh(at(budget - 4), at(26), 0.28, false);                                          // step 4, collapse into the packet
add(at(budget + 20), 0.4, 0.45, t => sine(55 + 60 * Math.exp(-t * 25), t) * Math.exp(-t * 7)); // packet lands
add(at(budget + 30), at(40), 0.05, t => sine(300 + 500 * (t / at(40)), t), 0.02, 0.05); // budget bar filling
impact(at(results + 4));                                                              // less context
bell(at(results + 4), [72, 76, 79], 0.07);
impact(at(results + 40), 0.4);                                                        // 0 searches
impact(at(results + 64), 0.4);                                                        // code found
bell(at(results + 64), [84, 88], 0.06);
bell(at(outro + 2), [60, 67, 72, 76], 0.08);                                          // the name

// ---- master: gentle limiter, fades at both ends --------------------------------------------------------
const peak = out.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const pcm = Buffer.alloc(out.length * 2);
for (let index = 0; index < out.length; index++) {
  const t = index / rate;
  const fade = Math.min(1, t / 0.3, (seconds - t) / 1.2);
  const value = Math.tanh((out[index] / peak) * 1.4) * 0.8 * fade;
  pcm.writeInt16LE(Math.round(value * 32767), index * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
fs.mkdirSync(path.join(videoRoot, 'public', 'audio'), { recursive: true });
fs.writeFileSync(path.join(videoRoot, 'public', 'audio', 'music.wav'), Buffer.concat([header, pcm]));
console.log(`public/audio/music.wav: ${seconds} s`);
