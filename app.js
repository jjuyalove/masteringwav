const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let originalBuffer = null;
let masteredBuffer = null;
let source = null;
let startedAt = 0;
let pausedAt = 0;
let playing = false;
let listenMode = 'mastered';
let animationFrame = null;
let originalAnalysis = null;
let masteredAnalysis = null;

const settings = { low: 0, mid: 0, high: 0, compression: 35, width: 100, saturation: 12, target: -14, ceiling: -1 };
const presetValues = {
  balanced: { low: 0, mid: 0, high: 0, compression: 35, width: 100, saturation: 12 },
  warm: { low: 2.2, mid: 0.8, high: -1.2, compression: 42, width: 92, saturation: 35 },
  punchy: { low: 1.5, mid: -0.5, high: 1.3, compression: 64, width: 105, saturation: 24 },
  open: { low: -0.5, mid: -0.8, high: 2.5, compression: 24, width: 132, saturation: 8 }
};

const controls = ['low', 'mid', 'high', 'compression', 'width', 'saturation', 'ceiling'];
const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function updateOutputs() {
  ['low', 'mid', 'high'].forEach(id => { $(`#${id}Out`).value = `${Number(settings[id]).toFixed(1)} dB`; });
  $('#compressionOut').value = `${settings.compression}%`;
  $('#widthOut').value = `${settings.width}%`;
  $('#saturationOut').value = `${settings.saturation}%`;
  $('#ceilingOut').value = `${Number(settings.ceiling).toFixed(1)} dB`;
  $('#lufs').innerHTML = `${Number(settings.target).toFixed(1)} <em>LUFS-I</em>`;
  $('#peak').textContent = `${Number(settings.ceiling).toFixed(1)} dB`;
  $('#stereoStat').textContent = `${settings.width}%`;
  $('#dynamic').textContent = `${Math.max(5.2, 11.2 - settings.compression * 0.08).toFixed(1)} dB`;
  $('#levelState').textContent = 'TARGET';
  $('#resultText').textContent = describeResult();
}

function analyzeBuffer(buffer) {
  const blockSize = Math.max(1, Math.floor(buffer.sampleRate * .4));
  const blockPowers = [];
  let peak = 0;
  for (let start = 0; start < buffer.length; start += blockSize) {
    const end = Math.min(buffer.length, start + blockSize);
    let sum = 0, count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = start; i < end; i++) { const sample = data[i]; peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; count++; }
    }
    blockPowers.push(sum / Math.max(1, count));
  }
  const absoluteGate = Math.pow(10, (-70 + .691) / 10);
  let gated = blockPowers.filter(power => power > absoluteGate);
  const firstMean = gated.reduce((sum, value) => sum + value, 0) / Math.max(1, gated.length);
  const relativeGate = firstMean * .1;
  gated = gated.filter(power => power > relativeGate);
  const mean = gated.reduce((sum, value) => sum + value, 0) / Math.max(1, gated.length);
  const loudness = -0.691 + 10 * Math.log10(Math.max(mean, 1e-12));
  const sorted = gated.map(power => -0.691 + 10 * Math.log10(power)).sort((a, b) => a - b);
  const percentile = value => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * value)))] || loudness;
  return { lufs: loudness, peakDb: 20 * Math.log10(Math.max(peak, 1e-12)), dynamic: Math.max(0, percentile(.95) - percentile(.1)) };
}

function showMeasuredResult(analysis) {
  $('#resultLabel').textContent = 'MEASURED RESULT';
  $('#lufsLabel').textContent = '분석 음압';
  $('#lufs').innerHTML = `${analysis.lufs.toFixed(1)} <em>LUFS-I*</em>`;
  $('#levelState').textContent = 'MEASURED';
  $('#peak').textContent = `${analysis.peakDb.toFixed(1)} dBFS`;
  $('#dynamic').textContent = `${analysis.dynamic.toFixed(1)} dB`;
  const difference = analysis.lufs - settings.target;
  $('#processStatus').className = `process-status ${Math.abs(difference) > 1 ? 'warning' : 'ready'}`;
  $('#processStatus').textContent = `렌더링 완료 · 목표 대비 ${difference >= 0 ? '+' : ''}${difference.toFixed(1)} LU · *브라우저 근사 측정값`;
}

function markResultStale() {
  masteredBuffer = null; masteredAnalysis = null;
  $('[data-mode="mastered"]').disabled = true;
  if (listenMode === 'mastered') { stopAudio(); listenMode = 'original'; $$('.compare button').forEach(button => button.classList.toggle('active', button.dataset.mode === 'original')); }
  $('#masterButton').dataset.ready = '';
  $('#resultLabel').textContent = 'EXPECTED RESULT'; $('#lufsLabel').textContent = '목표 음압';
  if (originalBuffer) { $('#masterButtonText').textContent = '변경된 설정으로 다시 마스터링'; $('#processStatus').className = 'process-status'; $('#processStatus').textContent = '설정이 변경되었습니다. 결과를 다시 렌더링해 주세요.'; }
}

function describeResult() {
  const tone = settings.high > 1 ? '밝고 선명한 고역' : settings.low > 1 ? '따뜻하고 단단한 저역' : '자연스러운 톤 밸런스';
  const dynamics = settings.compression > 55 ? '응집력 있고 강한 밀도' : '숨결이 살아 있는 안정적인 다이내믹';
  const space = settings.width > 115 ? '넓은 공간감' : settings.width < 80 ? '중앙에 집중된 이미지' : '균형 잡힌 스테레오 이미지';
  return `${tone}, ${dynamics}, ${space}를 목표로 합니다. 피크는 ${Number(settings.ceiling).toFixed(1)} dB에서 안전하게 보호됩니다.`;
}

function drawWaveform(buffer = null, progress = 0) {
  const canvas = $('#waveform');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height, mid = height / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#171b1c'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, height * i / 5); ctx.lineTo(width, height * i / 5); ctx.stroke(); }
  const samples = buffer?.getChannelData(0);
  const bars = Math.floor(width / 4);
  for (let i = 0; i < bars; i++) {
    let amp;
    if (samples) {
      const start = Math.floor(i * samples.length / bars); const end = Math.floor((i + 1) * samples.length / bars); let max = 0;
      for (let j = start; j < end; j += Math.max(1, Math.floor((end - start) / 20))) max = Math.max(max, Math.abs(samples[j]));
      amp = Math.max(2, max * height * .43);
    } else amp = 5 + (Math.sin(i * .37) + 1) * 8 + Math.sin(i * .12) * 4;
    ctx.fillStyle = i / bars <= progress ? '#c7f36b' : (samples ? '#4c5550' : '#222728');
    ctx.fillRect(i * 4, mid - amp, 2, amp * 2);
  }
}

async function loadFile(file) {
  if (!file || !/\.wav$/i.test(file.name)) { alert('WAV 형식의 파일을 선택해 주세요.'); return; }
  if (file.size > 500 * 1024 * 1024) { alert('파일은 500MB 이하여야 합니다.'); return; }
  try {
    $('#uploadTitle').textContent = '오디오를 분석하고 있어요…';
    originalBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    originalAnalysis = analyzeBuffer(originalBuffer); masteredBuffer = null; masteredAnalysis = null; pausedAt = 0; stopAudio(); listenMode = 'original';
    $('#uploadTitle').textContent = file.name;
    $('#uploadMeta').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · ${originalBuffer.sampleRate / 1000} kHz · ${originalBuffer.numberOfChannels === 2 ? 'Stereo' : 'Mono'}`;
    $('#trackName').textContent = file.name;
    $('#totalTime').textContent = formatTime(originalBuffer.duration);
    $('#playButton').disabled = false; $('#restartButton').disabled = false; $('#masterButton').disabled = false;
    $('#masterButtonText').textContent = '이 설정으로 마스터링';
    $('[data-mode="mastered"]').disabled = true;
    $$('.compare button').forEach(button => button.classList.toggle('active', button.dataset.mode === 'original'));
    $('#width').disabled = originalBuffer.numberOfChannels === 1;
    $('#processStatus').className = 'process-status ready';
    $('#processStatus').textContent = `원본 분석 완료 · ${originalAnalysis.lufs.toFixed(1)} LUFS-I* · Peak ${originalAnalysis.peakDb.toFixed(1)} dBFS`;
    drawWaveform(originalBuffer);
  } catch (error) { alert('이 WAV 파일을 읽을 수 없습니다. 다른 파일로 시도해 주세요.'); $('#uploadTitle').textContent = 'WAV 파일을 올려주세요'; }
}

function createCurve(amount) {
  const curve = new Float32Array(44100); const k = amount * 2;
  for (let i = 0; i < curve.length; i++) { const x = i * 2 / curve.length - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
  return curve;
}

async function renderMaster() {
  const ctx = new OfflineAudioContext(originalBuffer.numberOfChannels, originalBuffer.length, originalBuffer.sampleRate);
  const input = ctx.createBufferSource(); input.buffer = originalBuffer;
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = settings.low;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = .7; mid.gain.value = settings.mid;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 6500; high.gain.value = settings.high;
  const saturator = ctx.createWaveShaper(); saturator.curve = createCurve(settings.saturation / 25); saturator.oversample = '4x';
  const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -12 - settings.compression * .16; compressor.knee.value = 20; compressor.ratio.value = 1.5 + settings.compression * .055; compressor.attack.value = .015; compressor.release.value = .22;
  const targetGainDb = Math.max(-12, Math.min(12, settings.target - (originalAnalysis?.lufs ?? settings.target)));
  const gain = ctx.createGain(); gain.gain.value = Math.pow(10, targetGainDb / 20);
  const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = settings.ceiling; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .001; limiter.release.value = .08;
  input.connect(low).connect(mid).connect(high).connect(saturator).connect(compressor);
  if (originalBuffer.numberOfChannels > 1) {
    const splitter = ctx.createChannelSplitter(2), merger = ctx.createChannelMerger(2);
    const width = settings.width / 100;
    const directL = ctx.createGain(), directR = ctx.createGain(), crossL = ctx.createGain(), crossR = ctx.createGain();
    directL.gain.value = directR.gain.value = (1 + width) / 2;
    crossL.gain.value = crossR.gain.value = (1 - width) / 2;
    compressor.connect(splitter);
    splitter.connect(directL, 0); directL.connect(merger, 0, 0);
    splitter.connect(crossR, 0); crossR.connect(merger, 0, 1);
    splitter.connect(crossL, 1); crossL.connect(merger, 0, 0);
    splitter.connect(directR, 1); directR.connect(merger, 0, 1);
    merger.connect(gain);
  } else compressor.connect(gain);
  gain.connect(limiter).connect(ctx.destination);
  input.start(); return ctx.startRendering();
}

async function startMastering() {
  if (!originalBuffer) return;
  stopAudio(); const button = $('#masterButton'); button.disabled = true; $('#masterButtonText').textContent = '마스터링 처리 중…';
  $('#processStatus').className = 'process-status'; $('#processStatus').textContent = '전체 파일을 렌더링하고 있습니다…';
  try { masteredBuffer = await renderMaster(); masteredAnalysis = analyzeBuffer(masteredBuffer); $('#masterButtonText').textContent = '24-bit WAV 다운로드'; button.disabled = false; button.dataset.ready = 'true'; $('[data-mode="mastered"]').disabled = false; showMeasuredResult(masteredAnalysis); drawWaveform(masteredBuffer); }
  catch { $('#masterButtonText').textContent = '다시 시도하기'; button.disabled = false; $('#processStatus').className = 'process-status warning'; $('#processStatus').textContent = '마스터링을 완료하지 못했습니다. 설정은 유지되었어요.'; }
}

function playAudio() {
  if (!originalBuffer) return;
  if (playing) { pausedAt = Math.min((listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer).duration, audioContext.currentTime - startedAt); stopAudio(); return; }
  audioContext.resume(); const buffer = listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer;
  source = audioContext.createBufferSource(); source.buffer = buffer;
  const gain = audioContext.createGain();
  const matchDb = listenMode === 'mastered' && masteredAnalysis && $('#levelMatch').checked ? originalAnalysis.lufs - masteredAnalysis.lufs : 0;
  gain.gain.value = Number($('#volume').value) * Math.pow(10, matchDb / 20); source.connect(gain).connect(audioContext.destination);
  source.start(0, pausedAt); startedAt = audioContext.currentTime - pausedAt; playing = true; $('#playButton').textContent = 'Ⅱ';
  source.onended = () => { if (playing) { pausedAt = 0; stopAudio(); drawWaveform(buffer, 0); } };
  tick();
}

function stopAudio() { if (source) { source.onended = null; try { source.stop(); } catch {} source = null; } playing = false; cancelAnimationFrame(animationFrame); $('#playButton').textContent = '▶'; }
function tick() { if (!playing) return; const buffer = listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer; const elapsed = Math.min(buffer.duration, audioContext.currentTime - startedAt); $('#currentTime').textContent = formatTime(elapsed); drawWaveform(buffer, elapsed / buffer.duration); animationFrame = requestAnimationFrame(tick); }

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels, rate = buffer.sampleRate, length = buffer.length, bytes = 3, dataSize = length * channels * bytes;
  const out = new ArrayBuffer(44 + dataSize), view = new DataView(out); let offset = 0;
  const text = s => { for (const c of s) view.setUint8(offset++, c.charCodeAt(0)); };
  text('RIFF'); view.setUint32(offset, 36 + dataSize, true); offset += 4; text('WAVEfmt '); view.setUint32(offset, 16, true); offset += 4; view.setUint16(offset, 1, true); offset += 2; view.setUint16(offset, channels, true); offset += 2; view.setUint32(offset, rate, true); offset += 4; view.setUint32(offset, rate * channels * bytes, true); offset += 4; view.setUint16(offset, channels * bytes, true); offset += 2; view.setUint16(offset, 24, true); offset += 2; text('data'); view.setUint32(offset, dataSize, true); offset += 4;
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) { let sample = Math.max(-1, Math.min(1, channelData[c][i])); sample = sample < 0 ? sample * 0x800000 : sample * 0x7fffff; const value = Math.round(sample); view.setUint8(offset++, value & 255); view.setUint8(offset++, (value >> 8) & 255); view.setUint8(offset++, (value >> 16) & 255); }
  return new Blob([out], { type: 'audio/wav' });
}

function downloadMaster() { const url = URL.createObjectURL(encodeWav(masteredBuffer)); const a = document.createElement('a'); a.href = url; a.download = `${$('#trackName').textContent.replace(/\.wav$/i, '')}_mastered.wav`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

controls.forEach(id => $(`#${id}`).addEventListener('input', e => { settings[id] = Number(e.target.value); markResultStale(); updateOutputs(); }));
$('#target').addEventListener('change', e => { settings.target = Number(e.target.value); markResultStale(); updateOutputs(); });
$$('#presets button').forEach(button => button.addEventListener('click', () => { $$('#presets button').forEach(b => b.classList.remove('active')); button.classList.add('active'); Object.assign(settings, presetValues[button.dataset.preset]); controls.forEach(id => { if ($(`#${id}`) && settings[id] !== undefined) $(`#${id}`).value = settings[id]; }); markResultStale(); updateOutputs(); }));
$('#resetButton').addEventListener('click', () => { Object.assign(settings, presetValues.balanced, { target: -14, ceiling: -1 }); controls.forEach(id => $(`#${id}`).value = settings[id]); $('#target').value = '-14'; markResultStale(); updateOutputs(); });
$('#fileButton').addEventListener('click', () => $('#fileInput').click()); $('#selectButton').addEventListener('click', () => $('#fileInput').click()); $('#fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
const drop = $('#dropZone'); ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add('drag'); })); ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove('drag'); })); drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
$('#playButton').addEventListener('click', playAudio); $('#restartButton').addEventListener('click', () => { stopAudio(); pausedAt = 0; $('#currentTime').textContent = '00:00'; drawWaveform(listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer); });
$$('.compare button').forEach(button => button.addEventListener('click', () => { if (button.disabled || button.dataset.mode === listenMode) return; if (playing) pausedAt = audioContext.currentTime - startedAt; stopAudio(); $$('.compare button').forEach(b => b.classList.remove('active')); button.classList.add('active'); listenMode = button.dataset.mode; drawWaveform(listenMode === 'mastered' ? masteredBuffer : originalBuffer, pausedAt / originalBuffer.duration); }));
$('#waveform').addEventListener('click', event => { if (!originalBuffer) return; const wasPlaying = playing; stopAudio(); pausedAt = originalBuffer.duration * event.offsetX / event.currentTarget.clientWidth; $('#currentTime').textContent = formatTime(pausedAt); drawWaveform(listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer, pausedAt / originalBuffer.duration); if (wasPlaying) playAudio(); });
$('#masterButton').addEventListener('click', () => masteredBuffer && $('#masterButton').dataset.ready ? downloadMaster() : startMastering());
window.addEventListener('resize', () => drawWaveform(listenMode === 'mastered' && masteredBuffer ? masteredBuffer : originalBuffer));
updateOutputs(); drawWaveform();
