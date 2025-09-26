import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:8001", { transports: ["websocket"] });

export default function VoiceBot() {
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [info, setInfo] = useState(null);
  const [liveCaption, setLiveCaption] = useState("");

  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);

  const bufferRef = useRef([]);
  const silenceStartRef = useRef(null);
  const speakingRef = useRef(false);
  const currentAudioRef = useRef(null);

  // Tunables
  const SILENCE_MS = 400; // speech ends faster
  const RMS_THRESHOLD = 0.008; // lower = more sensitive
  const FRAME_SIZE = 2048;
  const TARGET_SAMPLE_RATE = 16000;

  useEffect(() => {
    socket.on("server_info", (msg) => setInfo(msg));

    socket.on("bot_reply", (msg) => {
      setMessages((prev) => [...prev, { from: "bot", text: msg.bot_text }]);

    if (msg.bot_audio) {
      // If STT marked as valid → interrupt
      if (msg.interrupt) {
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current.currentTime = 0;
          currentAudioRef.current = null;
        }
      }

      const audio = new Audio("data:audio/wav;base64," + msg.bot_audio);
      currentAudioRef.current = audio;

      audio.play().catch(() => {
        console.warn("Autoplay prevented");
      });

      audio.onended = () => {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
        }
      };
    }
  });


    socket.on("partial_text", (msg) => {
      setLiveCaption(msg.text);
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

      const float16k = downsampleFloat(inBuf, audioContextRef.current.sampleRate, TARGET_SAMPLE_RATE);
      const pcm16 = floatToPCM16(float16k);

      if (rms > RMS_THRESHOLD) {
        speakingRef.current = true;
        silenceStartRef.current = null;
        bufferRef.current.push(pcm16);

        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current = null;
        }
      } else if (speakingRef.current) {
        if (!silenceStartRef.current) silenceStartRef.current = Date.now();
        else if (Date.now() - silenceStartRef.current > SILENCE_MS) {
          const combined = mergeInt16(bufferRef.current);
          socket.emit("voice_chunk", new Uint8Array(combined.buffer));
          socket.emit("end_voice");

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
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      audioContextRef.current?.close();
      sourceRef.current?.mediaStream?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    bufferRef.current = [];
    silenceStartRef.current = null;
    speakingRef.current = false;
    setIsRecording(false);
  };

  // Helpers
  function computeRMS(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function downsampleFloat(buffer, srcRate, outRate) {
    if (outRate === srcRate) return buffer.slice(0);
    const ratio = srcRate / outRate;
    const outLength = Math.floor(buffer.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let sum = 0;
      for (let j = start; j < end && j < buffer.length; j++) sum += buffer[j];
      out[i] = sum / (end - start || 1);
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
      <h2>🎙️ Voice Bot (Fast)</h2>
      <div style={{ fontSize: 12, color: "#666" }}>
        {info ? "✅ Connected" : "Connecting..."}
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
          marginTop: 12,
        }}
      >
        {isRecording ? "⏹ Stop" : "🎤 Start"}
      </button>

      {liveCaption && (
        <div style={{ marginTop: 10, fontStyle: "italic", color: "#555" }}>
          {liveCaption}
        </div>
      )}

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
