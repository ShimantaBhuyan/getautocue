import { useState, useEffect, useRef, useCallback } from 'react';
import Fuse from 'fuse.js';

// Tunable parameters
const FUSE_THRESHOLD = 0.4;
const SEARCH_WINDOW_SIZE = 8;

interface ScriptWord {
    id: number;
    word: string;
    rawWord: string;
    isSpoken: boolean;
    isCurrent: boolean;
}

export const useVoiceMode = (initialScript: string) => {
    const [scriptWords, setScriptWords] = useState<ScriptWord[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isListening, setIsListening] = useState(false);

    const socketRef = useRef<WebSocket | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const lastMatchedWordIndex = useRef(-1);

    // Pre-process the script whenever it changes
    useEffect(() => {
        const processedScript = initialScript
            .trim()
            .split(/\s+/)
            .map((word, index) => ({
                id: index,
                word: word,
                rawWord: word.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ""),
                isSpoken: false,
                isCurrent: false,
            }));
        console.log("Processed script:", processedScript);
        setScriptWords(processedScript);
        lastMatchedWordIndex.current = -1; // Reset progress
    }, [initialScript]);

    const handleFinalTranscript = useCallback((text: string) => {
        if (!text) return;

        const transcribedWords = text.toLowerCase().split(' ').filter(Boolean);
        let localLastMatchIndex = lastMatchedWordIndex.current;

        for (const transcribedWord of transcribedWords) {
            const searchStart = localLastMatchIndex + 1;
            const searchEnd = searchStart + SEARCH_WINDOW_SIZE;
            const searchSlice = scriptWords.slice(searchStart, searchEnd);

            if (searchSlice.length === 0) continue;

            const fuse = new Fuse(searchSlice, {
                keys: ['rawWord'],
                includeScore: true,
                threshold: FUSE_THRESHOLD,
            });
            const results = fuse.search(transcribedWord);
            console.log({ results })

            if (results.length > 0) {
                const bestMatch = results[0];
                const matchedIndexInScript = bestMatch.item.id;

                setScriptWords(currentWords => {
                    const newWords = [...currentWords];
                    for (let i = 0; i <= matchedIndexInScript; i++) {
                        if (i < newWords.length) {
                            newWords[i].isSpoken = true;
                            newWords[i].isCurrent = false;
                        }
                    }
                    return newWords;
                });

                localLastMatchIndex = matchedIndexInScript;
            }
        }
        lastMatchedWordIndex.current = localLastMatchIndex;
    }, [scriptWords]);

    const handlePartialTranscript = useCallback((text: string) => {
        if (!text) return;

        const partialWords = text.toLowerCase().split(' ');
        const lastPartialWord = partialWords[partialWords.length - 1];

        if (!lastPartialWord) return;

        const searchStart = lastMatchedWordIndex.current + 1;
        const searchEnd = searchStart + SEARCH_WINDOW_SIZE;
        const searchSlice = scriptWords.slice(searchStart, searchEnd);

        if (searchSlice.length === 0) return;

        const fuse = new Fuse(searchSlice, {
            keys: ['rawWord'],
            includeScore: true,
            threshold: FUSE_THRESHOLD + 0.1, // Be a bit more lenient for partials
        });
        const results = fuse.search(lastPartialWord);
        console.log("FULL SEARCH RESULTS:", results);

        if (results.length > 0) {
            const bestMatch = results[0];
            const currentIndexInScript = bestMatch.item.id;

            setScriptWords(currentWords =>
                currentWords.map((word) => ({
                    ...word,
                    isCurrent: word.id === currentIndexInScript,
                }))
            );
        }
    }, [scriptWords]);

    const startListening = async () => {
        if (isListening) return;

        try {
            const response = await fetch('/api/assemblyai/token');
            const data = await response.json();
            if (!data.token) throw new Error('Failed to get AssemblyAI token');

            const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=${data.token}`;
            socketRef.current = new WebSocket(wsUrl);

            socketRef.current.onopen = () => {
                setIsConnected(true);
                console.log('Voice WebSocket connected');
            };

            socketRef.current.onmessage = (event) => {
                const message = JSON.parse(event.data);
                console.log('WebSocket message:', message); // Debug log

                // Handle different message types from AssemblyAI v3 API
                if (message.message_type === 'PartialTranscript') {
                    handlePartialTranscript(message.text);
                } else if (message.message_type === 'FinalTranscript') {
                    handleFinalTranscript(message.text);
                } else if (message.transcript) {
                    // Handle Turn events with transcript data
                    if (message.end_of_turn) {
                        handleFinalTranscript(message.transcript);
                    } else {
                        handlePartialTranscript(message.transcript);
                    }
                }
            };

            socketRef.current.onerror = (error) => {
                console.error('Voice WebSocket error:', error);
                stopListening();
            };

            socketRef.current.onclose = (event) => {
                setIsConnected(false);
                console.log('Voice WebSocket closed', event.code, event.reason);
            };

            // Set up audio processing for PCM data
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            // Create audio context for processing
            const audioContext = new AudioContext({ sampleRate: 16000 });
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (event) => {
                if (socketRef.current?.readyState === WebSocket.OPEN) {
                    const inputData = event.inputBuffer.getChannelData(0);

                    // Convert float32 audio data to int16 PCM
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        // Clamp the value to [-1, 1] and convert to 16-bit integer
                        const sample = Math.max(-1, Math.min(1, inputData[i]));
                        pcmData[i] = sample * 0x7FFF;
                    }

                    socketRef.current.send(pcmData.buffer);
                }
            };

            source.connect(processor);
            processor.connect(audioContext.destination);

            // Store references for cleanup
            mediaRecorderRef.current = {
                stream,
                audioContext,
                processor
            } as any;

            setIsListening(true);

        } catch (error) {
            console.error('Error starting voice listening:', error);
        }
    };

    const stopListening = () => {
        if (!isListening) return;

        // Cleanup audio resources
        if (mediaRecorderRef.current) {
            const { stream, audioContext, processor } = mediaRecorderRef.current as any;

            if (processor) {
                processor.disconnect();
            }
            if (audioContext) {
                audioContext.close();
            }
            if (stream) {
                stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
            }
            mediaRecorderRef.current = null;
        }

        // Cleanup WebSocket
        if (socketRef.current) {
            if (socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ terminate_session: true }));
            }
            socketRef.current.close();
            socketRef.current = null;
        }

        setIsListening(false);
        setIsConnected(false);
    };

    const resetVoiceMode = () => {
        stopListening();
        setScriptWords(currentWords =>
            currentWords.map(word => ({ ...word, isSpoken: false, isCurrent: false }))
        );
        lastMatchedWordIndex.current = -1;
    };

    useEffect(() => {
        // Cleanup on unmount
        return () => {
            stopListening();
        };
    }, []);

    return {
        scriptWords,
        isListening,
        isConnected,
        startListening,
        stopListening,
        resetVoiceMode,
    };
};
