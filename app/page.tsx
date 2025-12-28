"use client";

import { useState, useRef, useEffect } from "react";

export default function GrokVoiceChat() {
  // --- UI State ---
  const [status, setStatus] = useState("Disconnected");
  const [language, setLanguage] = useState("English");
  const [transcript, setTranscript] = useState("");
  const [isGrokSpeaking, setIsGrokSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);

  // --- Refs for Audio & Logic ---
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // --- 1. Audio Playback (Grok -> User) ---
  const playAudioChunk = (base64: string) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    // Convert Base64 to Float32 for Web Audio API
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
    const pcm16 = new Int16Array(bytes);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Gapless scheduling: ensure chunks play exactly after each other
    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;
  };

  // --- 2. Mic Processing (User -> Grok) ---
  const setupMic = (stream: MediaStream) => {
    if (!audioContextRef.current) return;

    const source = audioContextRef.current.createMediaStreamSource(stream);
    // 4096 buffer size at 24kHz is ~170ms of audio per chunk
    processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

    source.connect(processorRef.current);
    processorRef.current.connect(audioContextRef.current.destination);

    processorRef.current.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Calculate volume for UI visualizer
      let sum = 0;
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s * 0x7FFF; // Convert to PCM16
        sum += s * s;
      }
      setVolume(Math.sqrt(sum / inputData.length) * 100);

      // Send to Relay -> xAI
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        socketRef.current.send(JSON.stringify({ 
          type: "input_audio_buffer.append", 
          audio: base64 
        }));
      }
    };
  };

  // --- 3. Session Control ---
  const startSession = async () => {
    try {
      setStatus("Initializing...");
      
      // Request mic first
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create/Resume AudioContext
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      await audioContextRef.current.resume();

      // Connect to the Local Relay
      const ws = new WebSocket(`ws://localhost:8080`);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus("Configuring...");
        
        // Initial Configuration
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            voice: "Ara",
            instructions: `You are Grok. You are having a real-time voice conversation. 
                           Please respond entirely in ${language}. Keep responses concise.`,
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcm", rate: 24000 } },
              output: { format: { type: "audio/pcm", rate: 24000 } }
            }
          }
        }));

        setupMic(stream);
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        
        // Debug logs in browser console
        if (data.type !== "ping") console.log("xAI Event:", data.type);

        switch (data.type) {
          case "session.updated":
            setStatus("Ready - Speak now");
            break;
          case "input_audio_buffer.speech_started":
            setStatus("Grok is listening...");
            setTranscript(""); 
            break;
          case "response.output_audio_transcript.delta":
            setTranscript(prev => prev + data.delta);
            break;
          case "response.output_audio.delta":
            setIsGrokSpeaking(true);
            playAudioChunk(data.delta);
            break;
          case "response.done":
            setIsGrokSpeaking(false);
            setStatus("Ready - Speak now");
            break;
        }
      };

      ws.onclose = () => {
        setStatus("Disconnected");
        stopAudio();
      };

    } catch (err) {
      console.error(err);
      setStatus("Error: Check Mic Permissions");
    }
  };

  const stopAudio = () => {
    processorRef.current?.disconnect();
    socketRef.current?.close();
    setVolume(0);
    setIsGrokSpeaking(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 font-sans">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 shadow-2xl">
        
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Grok Voice</h1>
          <p className={`text-sm font-medium ${status.includes("Ready") ? "text-green-500" : "text-zinc-500"}`}>
            {status}
          </p>
        </div>

        {/* Dynamic Visualizer Area */}
        <div className="relative flex items-center justify-center h-48 mb-8">
          {/* Outer Ring */}
          <div className={`absolute inset-0 rounded-full border-2 border-white/5 transition-all duration-700 ${isGrokSpeaking ? 'scale-110 opacity-20' : 'scale-100 opacity-10'}`} />
          
          {/* Main Visualizer Orb */}
          <div 
            className={`rounded-full transition-all duration-300 flex items-center justify-center ${
              isGrokSpeaking ? 'bg-blue-600 shadow-[0_0_50px_rgba(37,99,235,0.5)]' : 'bg-zinc-800'
            }`}
            style={{ 
              width: `${Math.max(80, 80 + volume * 1.5)}px`, 
              height: `${Math.max(80, 80 + volume * 1.5)}px` 
            }}
          >
            {isGrokSpeaking && (
              <div className="flex gap-1">
                <span className="w-1 h-4 bg-white rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1 h-4 bg-white rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1 h-4 bg-white rounded-full animate-bounce" />
              </div>
            )}
          </div>
        </div>

        {/* Language Selection */}
        <div className="bg-black/40 p-1 rounded-2xl flex mb-8">
          {["English", "Spanish"].map((lang) => (
            <button
              key={lang}
              onClick={() => setLanguage(lang)}
              disabled={status !== "Disconnected"}
              className={`flex-1 py-2 rounded-xl text-sm font-bold transition ${
                language === lang ? "bg-white text-black" : "text-zinc-500 hover:text-white"
              } disabled:opacity-50`}
            >
              {lang}
            </button>
          ))}
        </div>

        {/* Action Button */}
        <button
          onClick={status === "Disconnected" ? startSession : stopAudio}
          className={`w-full py-5 rounded-3xl font-black text-lg transition-all active:scale-95 ${
            status === "Disconnected" 
              ? "bg-white text-black hover:bg-zinc-200" 
              : "bg-zinc-800 text-red-500 border border-red-900/30 hover:bg-red-950/20"
          }`}
        >
          {status === "Disconnected" ? "START CHAT" : "END SESSION"}
        </button>

        {/* Live Transcript Area */}
        <div className="mt-8 p-6 bg-black/40 rounded-3xl min-h-[120px] max-h-[200px] overflow-y-auto border border-zinc-800/50">
          <p className="text-zinc-500 text-[10px] uppercase tracking-widest font-bold mb-3">Live Transcript</p>
          <p className="text-zinc-200 text-sm leading-relaxed italic">
            {transcript || (status.includes("Ready") ? "Go ahead, I'm listening..." : "Connect to start...")}
          </p>
        </div>
      </div>

      <p className="mt-8 text-zinc-600 text-[10px] uppercase tracking-[0.2em]">Powered by xAI Realtime</p>
    </div>
  );
}