"use client";

import { useState, useRef } from "react";

const VOICES = [
  { id: "Ara", label: "Ara", desc: "Friendly (F)" },
  { id: "Rex", label: "Rex", desc: "Business (M)" },
  { id: "Sal", label: "Sal", desc: "Neutral" },
  { id: "Eve", label: "Eve", desc: "Upbeat (F)" },
  { id: "Leo", label: "Leo", desc: "Command (M)" },
];

type Message = { id: string; role: "user" | "assistant"; text: string; timestamp: Date; };

export default function GrokCompactSplit() {
  const [status, setStatus] = useState("Disconnected");
  const [language, setLanguage] = useState("English");
  const [voice, setVoice] = useState("Ara");
  const [volume, setVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const updateTranscript = (role: "user" | "assistant", textDelta: string, isNew: boolean = false) => {
    setMessages((prev) => {
      const newMessages = [...prev];
      if (isNew || newMessages.length === 0 || newMessages[0].role !== role) {
        return [{ id: Math.random().toString(), role, text: textDelta, timestamp: new Date() }, ...prev];
      } else {
        newMessages[0] = { ...newMessages[0], text: newMessages[0].text + textDelta };
        return newMessages;
      }
    });
  };

  const playAudioChunk = (base64: string) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
    const pcm16 = new Int16Array(bytes);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) nextStartTimeRef.current = currentTime;
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;
  };

  const startSession = async () => {
    try {
      setStatus("Init...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      await audioContextRef.current.resume();

      const ws = new WebSocket(`ws://localhost:8080`);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus("Config...");
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            voice,
            instructions: `You are Grok. Voice mode. Language: ${language}. Concise.`,
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcm", rate: 24000 } },
              output: { format: { type: "audio/pcm", rate: 24000 } }
            }
          }
        }));

        const source = audioContextRef.current!.createMediaStreamSource(stream);
        processorRef.current = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
        source.connect(processorRef.current);
        processorRef.current.connect(audioContextRef.current!.destination);
        processorRef.current.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          let sum = 0;
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s * 0x7FFF;
            sum += s * s;
          }
          setVolume(Math.sqrt(sum / inputData.length) * 100);
          if (ws.readyState === WebSocket.OPEN) {
            const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
            ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
          }
        };
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "session.updated": setStatus("Ready"); break;
          case "input_audio_buffer.speech_started": updateTranscript("user", "", true); setStatus("Listening..."); break;
          case "conversation.item.input_audio_transcription.completed":
            setMessages(prev => {
              const updated = [...prev];
              if (updated[0].role === "user") updated[0].text = data.transcript;
              return updated;
            });
            break;
          case "response.output_audio_transcript.delta": updateTranscript("assistant", data.delta, false); break;
          case "response.output_audio.delta": setIsSpeaking(true); playAudioChunk(data.delta); break;
          case "response.done": setIsSpeaking(false); setStatus("Ready"); break;
        }
      };
    } catch (err) { setStatus("Error"); }
  };

  const stopAudio = () => {
    processorRef.current?.disconnect();
    socketRef.current?.close();
    setVolume(0); setIsSpeaking(false); setStatus("Disconnected");
  };

  return (
    <div className="flex h-screen w-screen bg-black text-white overflow-hidden font-sans">
      
      {/* LEFT PANEL: CONTROLS (Scrollable if height is small) */}
      <div className="w-[320px] flex-shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-y-auto scrollbar-hide">
        <div className="p-5 border-b border-zinc-900 bg-zinc-950 sticky top-0 z-10">
          <h1 className="text-lg font-black tracking-tight">GROK VOICE</h1>
          <p className={`text-[9px] uppercase tracking-[0.2em] font-bold ${status.includes("Ready") ? "text-green-500" : "text-zinc-500"}`}>
            {status}
          </p>
        </div>

        <div className="p-5 flex-1 space-y-6">
          {/* Compact Visualizer */}
          <div className="flex items-center justify-center h-24 bg-zinc-900/40 rounded-2xl border border-zinc-800/50">
            <div 
              className={`rounded-full transition-all duration-200 ${isSpeaking ? 'bg-blue-600' : 'bg-zinc-800'}`}
              style={{ width: `${Math.max(40, 40 + volume)}px`, height: `${Math.max(40, 40 + volume)}px` }}
            />
          </div>

          {/* Voice Selection (2-Column Grid to save space) */}
          <div>
            <label className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold mb-2 block">Voice</label>
            <div className="grid grid-cols-2 gap-2">
              {VOICES.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setVoice(v.id)}
                  disabled={status !== "Disconnected"}
                  className={`text-left px-3 py-2 rounded-xl border text-[10px] transition-all ${
                    voice === v.id ? "bg-white text-black border-white" : "bg-transparent border-zinc-800 text-zinc-400"
                  } disabled:opacity-50`}
                >
                  <div className="font-bold">{v.label}</div>
                  <div className="opacity-60 leading-tight">{v.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Language Selection */}
          <div>
            <label className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold mb-2 block">Language</label>
            <div className="flex gap-2 p-1 bg-black rounded-xl border border-zinc-800">
              {["English", "Spanish"].map(l => (
                <button key={l} onClick={() => setLanguage(l)} disabled={status !== "Disconnected"}
                  className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition ${language === l ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Action Button (Fixed at bottom of panel) */}
        <div className="p-5 border-t border-zinc-900 bg-zinc-950 sticky bottom-0">
          <button
            onClick={status === "Disconnected" ? startSession : stopAudio}
            className={`w-full py-3 rounded-xl font-black text-base transition-all active:scale-95 ${
              status === "Disconnected" ? "bg-white text-black hover:bg-zinc-200" : "bg-red-600 text-white"
            }`}
          >
            {status === "Disconnected" ? "START SESSION" : "END SESSION"}
          </button>
        </div>
      </div>

      {/* RIGHT PANEL: TRANSCRIPT (Newest at top) */}
      <div className="flex-1 flex flex-col bg-black">
        <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-950/50 backdrop-blur">
          <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Conversation Log</h2>
          <button onClick={() => setMessages([])} className="text-[9px] text-zinc-600 hover:text-red-400 font-bold uppercase">Clear</button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-zinc-800 italic text-base">
              No messages yet...
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[75%] p-4 rounded-2xl text-base leading-relaxed ${
                msg.role === 'user' 
                  ? 'bg-zinc-800 text-zinc-200 rounded-tr-none' 
                  : 'bg-blue-600/10 text-blue-100 border border-blue-900/20 rounded-tl-none'
              }`}>
                {msg.text || <span className="animate-pulse">...</span>}
              </div>
              <span className="text-[8px] text-zinc-600 mt-1.5 font-mono uppercase">
                {msg.role} • {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}