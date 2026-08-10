import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatRequestError, transcribeDictation } from "../lib/api";

/** Shared voice-dictation control: captures the microphone with a live
 * waveform, encodes 16 kHz WAV, and transcribes through the platform's
 * dictation model (POST /api/chat/transcriptions). Used by the chat composer
 * and the Drafts instruction composer so dictation behaves identically. */

const DICTATION_MAX_SECONDS = 120;
const DICTATION_TARGET_SAMPLE_RATE = 16000;

/** Merge captured PCM chunks, downsample to 16 kHz mono, and wrap in a WAV header. */
function encodeWavPcm16(chunks: Float32Array[], sourceRate: number): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = Math.max(1, sourceRate / DICTATION_TARGET_SAMPLE_RATE);
  const length = Math.floor(merged.length / ratio);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeAscii = (position: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(position + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_TARGET_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i += 1) {
    // Average the source window instead of picking every Nth sample: naive
    // decimation aliases everything above 8 kHz into the speech band and the
    // transcription model hears garbled audio.
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += merged[j] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

type DictationSession = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  raf: number;
  startedAt: number;
};

export function DictationControl({
  userId,
  disabled,
  subjectLabel = "message",
  onTranscript,
  onError,
}: {
  userId: string;
  disabled?: boolean;
  /** What is being dictated — "message" in chat, "instruction" in Drafts. */
  subjectLabel?: string;
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);

  const teardown = () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    cancelAnimationFrame(session.raf);
    session.processor.disconnect();
    session.analyser.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    void session.context.close().catch(() => undefined);
  };

  // Stop tracks and release the microphone if the composer unmounts mid-recording.
  useEffect(() => teardown, []);

  const finishRecording = async (submit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    const { chunks, context } = session;
    const sourceRate = context.sampleRate;
    teardown();
    if (!submit) {
      setPhase("idle");
      return;
    }
    const audio = encodeWavPcm16(chunks, sourceRate);
    if (audio.size <= 44) {
      onError("No audio was captured. Check the selected microphone and try again.");
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const result = await transcribeDictation(userId, audio);
      if (result.text) {
        onTranscript(result.text);
        onError(null);
      } else {
        onError("The dictation model heard no speech in the recording.");
      }
    } catch (error) {
      onError(
        error instanceof ChatRequestError
          ? error.message
          : "The dictation could not be transcribed. Try again.",
      );
    } finally {
      setPhase("idle");
    }
  };

  const startRecording = async () => {
    onError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      onError("Microphone capture is not available in this browser.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      onError("Microphone access was denied. Allow microphone use for this site to dictate.");
      return;
    }
    // Capture at the transcription rate so the browser's resampler does the
    // downsampling; the WAV encoder then only has to convert sample formats.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: DICTATION_TARGET_SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(context.destination);

    const levels = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      const session = sessionRef.current;
      const canvas = canvasRef.current;
      if (!session) return;
      if ((performance.now() - session.startedAt) / 1000 >= DICTATION_MAX_SECONDS) {
        void finishRecording(true);
        return;
      }
      if (canvas) {
        const surface = canvas.getContext("2d");
        if (surface) {
          analyser.getByteFrequencyData(levels);
          surface.clearRect(0, 0, canvas.width, canvas.height);
          const bars = 14;
          const step = Math.floor(levels.length / bars);
          const barWidth = canvas.width / bars;
          surface.fillStyle = getComputedStyle(canvas).color;
          for (let i = 0; i < bars; i += 1) {
            const level = (levels[i * step] ?? 0) / 255;
            const barHeight = Math.max(2, level * canvas.height);
            surface.fillRect(
              i * barWidth + barWidth * 0.2,
              (canvas.height - barHeight) / 2,
              barWidth * 0.6,
              barHeight,
            );
          }
        }
      }
      session.raf = requestAnimationFrame(draw);
    };

    sessionRef.current = {
      context,
      stream,
      source,
      analyser,
      processor,
      chunks,
      raf: 0,
      startedAt: performance.now(),
    };
    setPhase("recording");
    sessionRef.current.raf = requestAnimationFrame(draw);
  };

  const recording = phase === "recording";
  return (
    <div className={`dictation-control ${recording ? "is-recording" : ""}`}>
      {recording && (
        <canvas
          ref={canvasRef}
          className="dictation-waveform"
          width={56}
          height={20}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        className={`dictation-button ${recording ? "is-recording" : ""} ${phase === "transcribing" ? "is-transcribing" : ""}`}
        aria-label={
          recording
            ? "Stop dictation and transcribe"
            : phase === "transcribing"
              ? "Transcribing dictation"
              : `Dictate ${subjectLabel === "message" ? "a message" : `your ${subjectLabel}`}`
        }
        data-tooltip={
          recording
            ? "Stop recording and insert the transcript"
            : phase === "transcribing"
              ? "Transcribing your dictation..."
              : `Dictate your ${subjectLabel} with the microphone`
        }
        aria-pressed={recording}
        disabled={disabled || phase === "transcribing"}
        onClick={() => (recording ? void finishRecording(true) : void startRecording())}
      >
        {recording ? <Square size={13} /> : <Mic size={16} />}
      </button>
    </div>
  );
}
