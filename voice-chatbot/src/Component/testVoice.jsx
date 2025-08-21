import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

const socket = io("http://localhost:8001", {
  transports: ["websocket"],
});

export default function VoiceBot() {
  const [recording, setRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [info, setInfo] = useState("");

  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const bufferRef = useRef([]);

  useEffect(() => {
    // ✅ Setup socket listeners
    socket.on("info", (msg) => {
      setInfo(msg.msg);
    });

    socket.on("stt_text", (msg) => {
      setMessages((prev) => [
        ...prev,
        { from: "user", text: msg.user_text },
      ]);
    });

    socket.on("bot_text", (msg) => {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: msg.bot_text },
      ]);
    });

    socket.on("tts_audio", (msg) => {
      if (msg.audio) {
        const audio = new Audio("data:audio/wav;base64," + msg.audio);
        audio.play().catch(() => {
          console.warn("Autoplay blocked, requires user gesture");
        });
      }
    });

    return () => {
      socket.off("info");
      socket.off("stt_text");
      socket.off("bot_text");
      socket.off("tts_audio");
    };
  }, []);

  // 🎤 Start recording
  const startRecording = async () => {
    audioContextRef.current = new (window.AudioContext ||
      window.webkitAudioContext)();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sourceRef.current =
      audioContextRef.current.createMediaStreamSource(stream);

    processorRef.current = audioContextRef.current.createScriptProcessor(
      4096,
      1,
      1
    );

    sourceRef.current.connect(processorRef.current);
    processorRef.current.connect(audioContextRef.current.destination);

    let silenceStart = Date.now();
    const silenceThreshold = 0.01; // adjust if too sensitive
    const silenceDuration = 1000; // ms

    processorRef.current.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const rms = Math.sqrt(
        input.reduce((sum, val) => sum + val * val, 0) / input.length
      );

      if (rms > silenceThreshold) {
        // voice detected
        silenceStart = Date.now();
        bufferRef.current.push(new Float32Array(input));
      } else {
        // silence
        if (Date.now() - silenceStart > silenceDuration) {
          if (bufferRef.current.length) {
            const combined = mergeInt16(bufferRef.current);
            const b64 = arrayBufferToBase64(combined.buffer);

            // ✅ send base64 to backend
            socket.emit("audio_chunk", b64);

            bufferRef.current = [];
          }
        }
      }
    };

    setRecording(true);
  };

  // 🛑 Stop recording
  const stopRecording = () => {
    if (processorRef.current) processorRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();

    setRecording(false);
  };

  return (
    <div className="p-4">
      <h2>🎙 Voice Bot</h2>
      <p>{info}</p>
      <button
        onClick={recording ? stopRecording : startRecording}
        style={{
          padding: "10px 20px",
          background: recording ? "red" : "green",
          color: "white",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        {recording ? "Stop Recording" : "Start Recording"}
      </button>

      <div style={{ marginTop: "20px" }}>
        <h3>Chat</h3>
        <ul>
          {messages.map((m, i) => (
            <li key={i} style={{ color: m.from === "user" ? "blue" : "black" }}>
              <strong>{m.from}: </strong>
              {m.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// 🔧 Helpers
function mergeInt16(chunks) {
  let totalLength = chunks.reduce((sum, arr) => sum + arr.length, 0);
  let result = new Int16Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    let int16 = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      int16[i] = Math.max(-1, Math.min(1, chunk[i])) * 0x7fff;
    }
    result.set(int16, offset);
    offset += int16.length;
  });

  return result;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
