import { useEffect, useRef, useState } from "react";

export type DictationState =
  | { status: "idle" }
  | { status: "requesting-permission" }
  | { status: "recording"; startedAt: number; elapsedMs: number; audioLevel: number; audioLevels: number[] }
  | { status: "stopping"; elapsedMs: number }
  | { status: "sending"; elapsedMs: number }
  | { status: "error"; message: string };

export type VoiceRecording = {
  file: File;
  durationMs: number;
  mimeType: string;
};

type UseVoiceDictationOptions = {
  onRecordingComplete: (recording: VoiceRecording) => Promise<void> | void;
};

const MAX_RECORDING_MS = 120_000;
const MIN_RECORDING_MS = 400;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Length of the scrolling amplitude history. The strip is right-anchored and
// clipped by the pill, so this only needs to comfortably exceed the number of
// bars that fit across the composer at its widest.
export const DICTATION_WAVEFORM_BAR_COUNT = 72;
// How often a fresh amplitude sample is pushed onto the history. ~15 samples a
// second reads as a smooth leftward scroll without re-rendering on every frame.
const WAVEFORM_SAMPLE_INTERVAL_MS = 66;
const EMPTY_AUDIO_LEVELS = Array.from({ length: DICTATION_WAVEFORM_BAR_COUNT }, () => 0);

export function useVoiceDictation({
  onRecordingComplete,
}: UseVoiceDictationOptions) {
  const [state, setState] = useState<DictationState>({ status: "idle" });
  const stateRef = useRef<DictationState>(state);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformRef = useRef<number[]>(EMPTY_AUDIO_LEVELS.slice());
  const elapsedIntervalRef = useRef<number | null>(null);
  const maxTimeoutRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const discardOnStopRef = useRef(false);
  const requestTokenRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => cleanup, []);

  async function start() {
    if (isDictationActive(stateRef.current)) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState({ status: "error", message: "Voice input is not supported in this app window." });
      return;
    }
    discardOnStopRef.current = false;
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setState({ status: "requesting-permission" });
    try {
      const stream = await requestMicrophoneStream(30_000);
      if (requestTokenRef.current !== requestToken || discardOnStopRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = createRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stopTracks();
        stopAudioContext();
        clearElapsedTimers();
        setState({ status: "error", message: "Recorder failed to capture audio." });
      };
      recorder.onstop = () => {
        void finishRecording();
      };

      recorder.start(250);
      startAudioLevelMeter(stream);
      startElapsedTimer();
      setState({
        status: "recording",
        startedAt: startedAtRef.current,
        elapsedMs: 0,
        audioLevel: 0,
        audioLevels: EMPTY_AUDIO_LEVELS,
      });
    } catch (error) {
      if (requestTokenRef.current !== requestToken || discardOnStopRef.current) return;
      cleanup();
      setState({ status: "error", message: captureErrorMessage(error) });
    }
  }

  function stop() {
    const current = stateRef.current;
    if (current.status !== "recording") return;
    setState({ status: "stopping", elapsedMs: elapsedMs() });
    stopTracks();
    stopRecorder();
  }

  function cancel() {
    discardOnStopRef.current = true;
    requestTokenRef.current += 1;
    stopTracks();
    stopRecorder();
    cleanup();
    setState({ status: "idle" });
  }

  function dismissError() {
    if (stateRef.current.status === "error") setState({ status: "idle" });
  }

  async function finishRecording() {
    const durationMs = elapsedMs();
    const mimeType = recorderMimeType();
    clearElapsedTimers();
    stopTracks();
    stopAudioContext();
    recorderRef.current = null;

    if (discardOnStopRef.current) {
      chunksRef.current = [];
      setState({ status: "idle" });
      return;
    }

    const audio = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (durationMs < MIN_RECORDING_MS || audio.size <= 0) {
      setState({ status: "error", message: "No speech was detected." });
      return;
    }
    if (audio.size > MAX_UPLOAD_BYTES) {
      setState({ status: "error", message: "Dictation audio is too large." });
      return;
    }

    setState({ status: "sending", elapsedMs: durationMs });
    const recording = new File([audio], recordingFilename(mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
    if (discardOnStopRef.current) {
      setState({ status: "idle" });
      return;
    }
    try {
      await onRecordingComplete({ file: recording, durationMs, mimeType });
    } catch (error) {
      setState({ status: "error", message: voiceSendErrorMessage(error) });
      return;
    }
    if (discardOnStopRef.current) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "idle" });
  }

  function cleanup() {
    stopTracks();
    stopAudioContext();
    clearElapsedTimers();
    recorderRef.current = null;
    chunksRef.current = [];
  }

  function startElapsedTimer() {
    clearElapsedTimers();
    elapsedIntervalRef.current = window.setInterval(() => {
      setState((current) => current.status === "recording"
        ? { ...current, elapsedMs: elapsedMs() }
        : current);
    }, 250);
    maxTimeoutRef.current = window.setTimeout(() => {
      stop();
    }, MAX_RECORDING_MS);
  }

  function startAudioLevelMeter(stream: MediaStream) {
    const AudioContextConstructor = window.AudioContext || windowWithWebkitAudio().webkitAudioContext;
    if (!AudioContextConstructor) return;
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0.00001;
    source.connect(analyser);
    analyser.connect(silentGain);
    silentGain.connect(audioContext.destination);
    audioContextRef.current = audioContext;
    audioSourceRef.current = source;
    analyserRef.current = analyser;
    silentGainRef.current = silentGain;
    void audioContext.resume().catch(() => undefined);

    const timeData = new Uint8Array(analyser.fftSize);
    waveformRef.current = EMPTY_AUDIO_LEVELS.slice();
    let lastSampleAt = 0;
    let pendingPeak = 0;
    let smoothedLevel = 0;
    const tick = (now: number) => {
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
      analyser.getByteTimeDomainData(timeData);
      // Track the loudest reading between sample points so brief transients
      // (consonants, plosives) still register as a bar.
      pendingPeak = Math.max(pendingPeak, amplitudeFromTimeDomainData(timeData));
      if (now - lastSampleAt >= WAVEFORM_SAMPLE_INTERVAL_MS) {
        lastSampleAt = now;
        const sample = pendingPeak;
        pendingPeak = 0;
        // Drop the oldest sample and append the newest at the right; the bars
        // then scroll leftward as time passes, voice-memo style.
        const history = waveformRef.current.slice(1);
        history.push(sample);
        waveformRef.current = history;
        smoothedLevel = smoothedLevel * 0.55 + sample * 0.45;
        const audioLevel = smoothedLevel;
        setState((current) => (current.status === "recording"
          ? { ...current, audioLevel, audioLevels: history }
          : current));
      }
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };
    animationFrameRef.current = window.requestAnimationFrame(tick);
  }

  function clearElapsedTimers() {
    if (elapsedIntervalRef.current !== null) window.clearInterval(elapsedIntervalRef.current);
    if (maxTimeoutRef.current !== null) window.clearTimeout(maxTimeoutRef.current);
    elapsedIntervalRef.current = null;
    maxTimeoutRef.current = null;
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function stopRecorder() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  function stopAudioContext() {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    audioSourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    audioSourceRef.current = null;
    analyserRef.current = null;
    silentGainRef.current = null;
    void audioContext?.close();
  }

  function elapsedMs() {
    return Math.max(0, Date.now() - startedAtRef.current);
  }

  function recorderMimeType() {
    const recorderType = recorderRef.current?.mimeType;
    return recorderType || pickSupportedMimeType() || "audio/webm";
  }

  return {
    state,
    start,
    stop,
    cancel,
    dismissError,
    active: isDictationActive(state),
  };
}

export function formatDictationElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Collapse a window of time-domain PCM samples into a single 0..1 loudness
// level for one waveform bar. Blends RMS (perceived volume) with peak (so sharp
// transients still poke up), subtracts a small noise floor, and applies a gentle
// curve so quiet speech is visible while silence stays at the baseline.
export function amplitudeFromTimeDomainData(data: Uint8Array) {
  if (!data.length) return 0;
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < data.length; index += 1) {
    const sample = (data[index] - 128) / 128;
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  const voiced = Math.max(0, rms - 0.006) * 6.4 + Math.max(0, peak - 0.02) * 0.4;
  return Math.min(1, Math.pow(voiced, 0.82));
}

function createRecorder(stream: MediaStream) {
  const mimeType = pickSupportedMimeType();
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

function pickSupportedMimeType() {
  const candidates = [
    "audio/mp4",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value));
}

function recordingFilename(mimeType: string) {
  if (mimeType.includes("mp4")) return "dictation.mp4";
  if (mimeType.includes("aac")) return "dictation.aac";
  if (mimeType.includes("wav")) return "dictation.wav";
  return "dictation.webm";
}

function captureErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone access was denied.";
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "No microphone was found.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Recorder failed to start.";
}

function voiceSendErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Could not send that voice message.";
}

function isDictationActive(state: DictationState) {
  return state.status === "requesting-permission" ||
    state.status === "recording" ||
    state.status === "stopping" ||
    state.status === "sending";
}

function windowWithWebkitAudio() {
  return window as Window & typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
}

function requestMicrophoneStream(timeoutMs: number) {
  let settled = false;
  let timeoutId: number | null = null;
  return new Promise<MediaStream>((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      settled = true;
      reject(new Error("Microphone permission did not resolve."));
    }, timeoutMs);
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        if (settled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        resolve(stream);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}
