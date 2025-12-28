"use client";

import { useState, useRef, useEffect } from "react";
import { Sun, Moon, Trash2, Mic, MicOff } from "lucide-react";

const VOICES = [
  { id: "Ara", label: "Ara", desc: "Friendly (F)" },
  { id: "Rex", label: "Rex", desc: "Business (M)" },
  { id: "Sal", label: "Sal", desc: "Neutral" },
  { id: "Eve", label: "Eve", desc: "Upbeat (F)" },
  { id: "Leo", label: "Leo", desc: "Command (M)" },
];

type Message = { id: string; role: "user" | "assistant"; text: string; timestamp: Date; };

export default function GrokSplitScreen() {
  // --- UI & Theme State ---
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    // Only run on client
    if (typeof window !== "undefined") {
      return (localStorage.getItem("theme") as "light" | "dark") || "dark";
    }
    return "dark";
  });

  const [status, setStatus] = useState("Disconnected");
  const [language, setLanguage] = useState("English");
  const [voice, setVoice] = useState("Ara");
  const [volume, setVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  // --- Timer State ---
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- Refs ---
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // --- Tailwind v4 Theme Toggle Logic ---
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [theme]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

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
      setStatus("Initializing...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      await audioContextRef.current.resume();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/realtime`);
      socketRef.current = ws;

      ws.onopen = () => {
        // Start Billing Timer
        setSecondsElapsed(0);
        timerIntervalRef.current = setInterval(() => setSecondsElapsed(s => s + 1), 1000);

        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            voice,
            instructions: `You are Grok. Real-time voice mode. Language: ${language}. Concise.`,
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

      ws.onmessage = (event) => {
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

      ws.onclose = () => { setStatus("Disconnected"); stopAudio(); };
    } catch (err) { setStatus("Error: Mic Denied"); }
  };

  const stopAudio = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    processorRef.current?.disconnect();
    socketRef.current?.close();
    setVolume(0); setIsSpeaking(false); setStatus("Disconnected");
  };

  return (
    <div className="flex h-screen w-screen bg-white dark:bg-black text-zinc-900 dark:text-zinc-100 transition-colors duration-300 font-sans overflow-hidden">
      
      {/* LEFT PANEL */}
      <div className="w-[320px] flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col bg-zinc-50 dark:bg-zinc-950">
        
        {/* Header */}
        <div className="p-5 border-b border-zinc-200 dark:border-zinc-900 flex justify-between items-center">
          <div>
            <h1 className="text-lg font-black tracking-tight uppercase">Grok Voice</h1>
            <p className={`text-[9px] font-bold uppercase tracking-widest ${status.includes("Ready") ? "text-green-600 dark:text-green-400" : "text-zinc-500"}`}>
              {status}
            </p>
          </div>
          <button 
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-2 rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:opacity-80 transition-all"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        {/* Status & Visualizer */}
        <div className="p-6 flex-1 space-y-8 overflow-y-auto">
          <div className="relative flex flex-col items-center justify-center p-8 bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
            {status !== "Disconnected" && (
              <div className="absolute top-4 text-base font-mono font-bold tracking-tighter text-zinc-400">
                ELAPSED: {formatTime(secondsElapsed)}
              </div>
            )}
            <div 
              className={`rounded-full transition-all duration-150 ${isSpeaking ? 'bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]' : 'bg-zinc-200 dark:bg-zinc-800'}`}
              style={{ width: `${Math.max(50, 50 + volume)}px`, height: `${Math.max(50, 50 + volume)}px` }}
            />
          </div>

          {/* Settings */}
          <div className="space-y-6">
            <div>
              <label className="text-base font-bold uppercase text-zinc-500 mb-3 block tracking-widest">Voice</label>
              <div className="grid grid-cols-2 gap-2">
                {VOICES.map((v) => (
                  <button key={v.id} onClick={() => setVoice(v.id)} disabled={status !== "Disconnected"}
                    className={`text-left px-3 py-2 rounded-xl border text-base transition-all ${voice === v.id ? "bg-zinc-900 text-white dark:bg-white dark:text-black border-transparent shadow-lg" : "bg-transparent border-zinc-200 dark:border-zinc-800 text-zinc-500"} disabled:opacity-50`}>
                    <div className="font-bold">{v.label}</div>
                    <div className="opacity-60">{v.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-base font-bold uppercase text-zinc-500 mb-3 block tracking-widest">Language</label>
              <div className="flex bg-zinc-200 dark:bg-zinc-900 p-1 rounded-xl">
                {["English", "Spanish"].map(l => (
                  <button key={l} onClick={() => setLanguage(l)} disabled={status !== "Disconnected"}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition ${language === l ? 'bg-white dark:bg-zinc-800 shadow-sm' : 'text-zinc-500'}`}>{l}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer Action */}
        <div className="p-5 border-t border-zinc-200 dark:border-zinc-900">
          <button 
            onClick={status === "Disconnected" ? startSession : stopAudio}
            className={`w-full py-4 rounded-2xl font-black flex items-center justify-center gap-2 transition-transform active:scale-95 ${status === "Disconnected" ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-red-500 text-white"}`}
          >
            {status === "Disconnected" ? <Mic size={18} /> : <MicOff size={18} />}
            {status === "Disconnected" ? "START SESSION" : "END SESSION"}
          </button>
          {status !== "Disconnected" && (
            <p className="text-[9px] text-center mt-3 text-zinc-500 font-bold tracking-widest animate-pulse">
              BILLING ACTIVE: {formatTime(secondsElapsed)}
            </p>
          )}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col bg-white dark:bg-black">
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center bg-white/80 dark:bg-black/80 backdrop-blur-md sticky top-0 z-20">
          <span className="text-base font-bold text-zinc-400 uppercase tracking-[0.2em]">Live Transcript</span>
          <button onClick={() => setMessages([])} className="p-2 hover:text-red-500 transition-colors text-zinc-400">
            <Trash2 size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-8 flex flex-col-reverse">
          <div className="h-1" /> {/* Spacer */}
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[80%] p-5 rounded-3xl text-[15px] leading-relaxed shadow-sm ${
                msg.role === 'user' 
                ? 'bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 rounded-tr-none border border-zinc-200 dark:border-zinc-800' 
                : 'bg-blue-500 text-white rounded-tl-none shadow-blue-500/20 shadow-lg'
              }`}>
                {msg.text || <span className="italic opacity-70 animate-pulse">Thinking...</span>}
              </div>
              <div className="mt-2 flex items-center gap-2 px-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                <span>{msg.role}</span>
                <span>•</span>
                <span>{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-zinc-300 dark:text-zinc-800 uppercase tracking-[0.3em] font-black text-xl">
              Waiting for Input
            </div>
          )}
        </div>
      </div>
    </div>
  );
}