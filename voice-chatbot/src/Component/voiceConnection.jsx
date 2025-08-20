import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// Force websocket so binary arrives as bytes
const socket = io("http://localhost:8001", {
  transports: ["websocket"],
});

export default function VoiceBot() {
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [info, setInfo] = useState(null);

  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);

  const bufferRef = useRef([]);         // Int16 chunks (downsampled 16k)
  const silenceStartRef = useRef(null);
  const speakingRef = useRef(false);

  // Tunables
  const SILENCE_MS = 800;               // consider speech ended after 800ms silence
  const RMS_THRESHOLD = 0.01;           // tweak for your mic/room
  const FRAME_SIZE = 4096;              // script processor buffer size
  const TARGET_SAMPLE_RATE = 16000;

  useEffect(() => {
    socket.on("server_info", (msg) => setInfo(msg));
    socket.on("bot_reply", (msg) => {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: msg.bot_text },
      ]);

      if (msg.bot_audio) {
        const audio = new Audio("data:audio/wav;base64," + msg.bot_audio);
        audio.play().catch(() => {
          // Autoplay policy: will play after first user interaction
          console.warn("Autoplay prevented; will play on next user gesture.");
        });
      }
    });

    socket.on("partial_text", (msg) => {
      // You can display live captions if you like. Currently sent empty by backend.
      // console.log("partial:", msg.text);
    });

    return () => {
      socket.off("server_info");
      socket.off("bot_reply");
      socket.off("partial_text");
    };
  }, []);

  const startRecording = async () => {
    if (isRecording) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    audioContextRef.current = new AC();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);

    const processor = audioContextRef.current.createScriptProcessor(FRAME_SIZE, 1, 1);
    processor.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer.getChannelData(0);
      const rms = computeRMS(inBuf);

      // Resample browser rate (often 44.1/48k) -> 16k Float32
      const float16k = downsampleFloat(
        inBuf,
        audioContextRef.current.sampleRate,
        TARGET_SAMPLE_RATE
      );
      // Convert to PCM16
      const pcm16 = floatToPCM16(float16k);

      if (rms > RMS_THRESHOLD) {
        // Voice detected
        speakingRef.current = true;
        silenceStartRef.current = null;
        bufferRef.current.push(pcm16);
      } else if (speakingRef.current) {
        // Silence during a speech segment
        if (!silenceStartRef.current) {
          silenceStartRef.current = Date.now();
        } else if (Date.now() - silenceStartRef.current > SILENCE_MS) {
          // End of utterance -> send one merged buffer
          const combined = mergeInt16(bufferRef.current);
          socket.emit("voice_chunk", combined.buffer); // send raw ArrayBuffer
          // reset
          bufferRef.current = [];
          silenceStartRef.current = null;
          speakingRef.current = false;
        }
      }
    };

    sourceRef.current.connect(processor);
    processor.connect(audioContextRef.current.destination);
    processorRef.current = processor;
    setIsRecording(true);
  };

  const stopRecording = () => {
    if (!isRecording) return;
    try {
      processorRef.current && processorRef.current.disconnect();
      sourceRef.current && sourceRef.current.disconnect();
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
      const tracks = sourceRef.current?.mediaStream?.getTracks?.() || [];
      tracks.forEach((t) => t.stop());
    } catch {}
    bufferRef.current = [];
    silenceStartRef.current = null;
    speakingRef.current = false;
    setIsRecording(false);
  };

  // --- helpers ---

  function computeRMS(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  // Downsample Float32 from srcRate -> 16k (simple linear decimator)
  function downsampleFloat(buffer, srcRate, outRate) {
    if (outRate === srcRate) return buffer.slice(0);

    const ratio = srcRate / outRate;
    const outLength = Math.floor(buffer.length / ratio);
    const out = new Float32Array(outLength);

    let pos = 0;
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      // Average to cheap low-pass the decimation
      let sum = 0;
      let count = 0;
      for (let j = start; j < end && j < buffer.length; j++) {
        sum += buffer[j];
        count++;
      }
      out[i] = count > 0 ? sum / count : buffer[start] || 0;
      pos += ratio;
    }
    return out;
  }

  function floatToPCM16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function mergeInt16(chunks) {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>🎙️ Vosk Socket.IO Voice Bot</h2>
      <div style={{ marginBottom: 12, fontSize: 12, color: "#666" }}>
        {info ? `Connected · server 16kHz` : "Connecting..."}
      </div>

      <button
        onClick={isRecording ? stopRecording : startRecording}
        style={{
          padding: "8px 14px",
          background: isRecording ? "#ef4444" : "#3b82f6",
          color: "white",
          borderRadius: 8,
          border: "none",
          cursor: "pointer",
        }}
      >
        {isRecording ? "⏹ Stop" : "🎤 Start"}
      </button>

      <div
        style={{
          marginTop: 16,
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          height: 280,
          overflowY: "auto",
          fontFamily: "monospace",
        }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ color: m.from === "bot" ? "#16a34a" : "#111827" }}>
            <b>{m.from}:</b> {m.text}
          </div>
        ))}
      </div>
    </div>
  );
}
