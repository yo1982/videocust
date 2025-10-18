
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, Blob } from '@google/genai';
import { SessionStatus, TranscriptEntry } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';

// --- Constants ---
const FRAME_RATE = 1; // Send 1 frame per second
const JPEG_QUALITY = 0.7;

// --- SVG Icon Components (defined outside App to prevent re-creation) ---
const AgentIcon: React.FC<{ speaking: boolean }> = ({ speaking }) => (
    <div className="relative w-full h-full flex items-center justify-center bg-gray-700 rounded-lg overflow-hidden">
        <svg className="w-24 h-24 text-gray-500" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z" clipRule="evenodd"></path></svg>
        {speaking && (
            <div className="absolute inset-0 border-4 border-blue-500 rounded-lg animate-pulse"></div>
        )}
    </div>
);

const PhoneIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"></path></svg>
);

const HangUpIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.62.72v3.1c0 .34-.02.67-.06.99l1.72 1.72c.1-.03.2-.05.29-.08.28-.08.56-.14.85-.14.55 0 1 .45 1 1v2.53c1.18-.23 2.29-.62 3.32-1.12.8-.39 1.54-.87 2.2-1.4.3-.23.48-.58.48-.96v-3.5c0-.55-.45-1-1-1-1.24 0-2.45-.2-3.57-.57-.35-.11-.74-.03-1.02.24l-2.2 2.2c-2.83-1.44-5.15-3.75-6.59-6.59l2.2-2.21c.28-.26.36-.65.25-1C8.7 6.45 8.5 5.25 8.5 4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.5c0-.55-.45-1-1-1-1.25 0-2.45-.2-3.57-.57-.35-.12-.75-.03-1.02.24l-2.2 2.2c-.5-.66-1-1.28-1.57-1.9-.11-.12-.23-.24-.34-.35-.61-.57-1.23-1.09-1.9-1.57-.11-.1-.23-.22-.35-.34z"></path></svg>
);


// --- Main App Component ---
export default function App() {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);

  // --- Refs for managing media and session state without re-renders ---
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const nextAudioStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  // --- Scroll transcript to bottom ---
  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcript]);

  // --- Cleanup function ---
  const stopChat = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    sessionPromiseRef.current?.then(session => session.close()).catch(() => {});
    sessionPromiseRef.current = null;
    
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;

    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;

    inputAudioContextRef.current?.close();
    inputAudioContextRef.current = null;
    outputAudioContextRef.current?.close();
    outputAudioContextRef.current = null;

    audioSourcesRef.current.forEach(source => source.stop());
    audioSourcesRef.current.clear();
    
    setStatus(SessionStatus.IDLE);
    setIsAgentSpeaking(false);
  }, []);
  
  // --- Effect to run cleanup on unmount ---
  useEffect(() => {
    return () => {
      stopChat();
    };
  }, [stopChat]);

  // --- Main function to start the chat session ---
  const startChat = useCallback(async () => {
    if (status !== SessionStatus.IDLE) return;

    setStatus(SessionStatus.CONNECTING);
    setTranscript([]);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      
      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'You are a friendly and helpful customer support agent for a premium tech company. Keep your answers concise and clear.',
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            
            // --- Audio Input Streaming ---
            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            
            scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(new Int16Array(inputData.map(x => x * 32768)).buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromiseRef.current?.then((session) => {
                 session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);

            // --- Video Input Streaming ---
            frameIntervalRef.current = window.setInterval(() => {
              if (localVideoRef.current && canvasRef.current) {
                  const ctx = canvasRef.current.getContext('2d');
                  if(!ctx) return;
                  canvasRef.current.width = localVideoRef.current.videoWidth;
                  canvasRef.current.height = localVideoRef.current.videoHeight;
                  ctx.drawImage(localVideoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                  canvasRef.current.toBlob(async (blob) => {
                      if (blob) {
                           const reader = new FileReader();
                           reader.onload = () => {
                               const base64Data = (reader.result as string).split(',')[1];
                               sessionPromiseRef.current?.then((session) => {
                                   session.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } });
                               });
                           };
                           reader.readAsDataURL(blob);
                      }
                  }, 'image/jpeg', JPEG_QUALITY);
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              if (!outputAudioContextRef.current) {
                outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
              }
              setIsAgentSpeaking(true);
              const ctx = outputAudioContextRef.current;
              nextAudioStartTimeRef.current = Math.max(nextAudioStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) {
                  setIsAgentSpeaking(false);
                }
              });
              source.start(nextAudioStartTimeRef.current);
              nextAudioStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
                const userText = currentInputTranscriptionRef.current.trim();
                const agentText = currentOutputTranscriptionRef.current.trim();

                setTranscript(prev => {
                    const newTranscript = [...prev];
                    if (userText) newTranscript.push({ author: 'user', text: userText });
                    if (agentText) newTranscript.push({ author: 'agent', text: agentText });
                    return newTranscript;
                });

                currentInputTranscriptionRef.current = '';
                currentOutputTranscriptionRef.current = '';
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            setStatus(SessionStatus.ERROR);
            stopChat();
          },
          onclose: () => {
            setStatus(SessionStatus.DISCONNECTED);
            stopChat();
          },
        }
      });
    } catch (error) {
      console.error('Failed to start chat:', error);
      setStatus(SessionStatus.ERROR);
    }
  }, [status, stopChat]);
  

  const isChatActive = status === SessionStatus.CONNECTED || status === SessionStatus.CONNECTING;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col p-4 md:p-6 lg:p-8 font-sans">
      <header className="flex justify-between items-center mb-4">
        <h1 className="text-2xl md:text-3xl font-bold text-blue-400">AI Customer Support</h1>
        <div className="flex items-center space-x-2">
            <div className={`w-3 h-3 rounded-full ${isChatActive ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}></div>
            <span className="text-gray-400">{status}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row gap-4 overflow-hidden">
        {/* --- Video Panels --- */}
        <div className="flex-1 md:flex-[2] flex flex-col gap-4">
            <div className="flex-1 bg-gray-800 rounded-lg p-2 shadow-lg">
                <AgentIcon speaking={isAgentSpeaking} />
            </div>
            <div className="h-1/3 md:h-1/4 bg-gray-800 rounded-lg p-2 shadow-lg">
                <video ref={localVideoRef} autoPlay muted className="w-full h-full object-cover rounded-md transform scale-x-[-1]"></video>
                <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>
            </div>
        </div>

        {/* --- Transcript & Controls --- */}
        <div className="flex-1 md:flex-[1] flex flex-col bg-gray-800 rounded-lg shadow-lg overflow-hidden">
            <div ref={transcriptContainerRef} className="flex-1 p-4 space-y-4 overflow-y-auto">
                {transcript.map((entry, index) => (
                    <div key={index} className={`flex ${entry.author === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${entry.author === 'user' ? 'bg-blue-600 rounded-br-none' : 'bg-gray-600 rounded-bl-none'}`}>
                            <p className="text-sm">{entry.text}</p>
                        </div>
                    </div>
                ))}
                 {transcript.length === 0 && !isChatActive && (
                    <div className="text-center text-gray-400 h-full flex items-center justify-center">
                        <p>Click "Start Chat" to begin your conversation with our AI agent.</p>
                    </div>
                )}
            </div>
            <div className="p-4 border-t border-gray-700">
                <button
                    onClick={isChatActive ? stopChat : startChat}
                    disabled={status === SessionStatus.CONNECTING}
                    className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800
                        ${isChatActive ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'}
                        ${status === SessionStatus.CONNECTING ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    {isChatActive ? <HangUpIcon className="w-6 h-6"/> : <PhoneIcon className="w-6 h-6"/>}
                    {status === SessionStatus.CONNECTING ? 'Starting...' : isChatActive ? 'End Chat' : 'Start Chat'}
                </button>
            </div>
        </div>
      </main>
    </div>
  );
}
