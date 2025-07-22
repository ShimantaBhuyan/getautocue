"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Play,
  Pause,
  RotateCcw,
  Settings,
  FlipHorizontal,
  FlipVertical,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Maximize,
  X,
  Mic,
  MicOff,
} from "lucide-react";
import { FuseTextMatcher } from "@/lib/fuse_matching";

type ScrollMode = "auto" | "voice" | "manual";

interface TeleprompterSettings {
  scrollMode: ScrollMode;
  autoSpeed: number;
  backgroundColor: string;
  textColor: string;
  fontSize: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

interface VoiceState {
  isListening: boolean;
  isConnected: boolean;
  currentTranscript: string;
  spokenWords: Set<number>;
  currentWordIndex: number;
  nextWordIndex: number;
  socket: WebSocket | null;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  scriptProcessor: ScriptProcessorNode | null;
}

export default function TeleprompterApp() {
  const [script, setScript] =
    useState(`In the rapidly evolving landscape of voice-enabled applications and AI agents, the demand for fast, accurate, and reliable speech-to-text transcription is paramount. AssemblyAI stands at the forefront of this innovation with its cutting-edge "Streaming Speech-to-Text" product, powered by their advanced Universal-Streaming model. Designed to empower developers and businesses to create highly intuitive and responsive real-time voice experiences, this offering boasts a compelling suite of features that set it apart.
At its core, AssemblyAI's Streaming Speech-to-Text delivers ultra-fast and ultra-accurate transcription. This isn't just a claim; the product boasts an impressive 300 ms word emission P50 latency, meaning that half of all words are transcribed and made available to downstream services within a mere 300 milliseconds. This near-instantaneous processing is crucial for maintaining natural conversation flow in applications like voice agents and contact centers, preventing awkward pauses and ensuring a seamless user experience. Furthermore, the Universal-Streaming model achieves a remarkable >91% word accuracy rate, consistently outperforming competitors like Deepgram Nova-3 in critical areas such as alphanumeric and proper noun recognition. This superior accuracy directly translates to fewer "silent transcription errors," ensuring that underlying LLM logic remains on track and precise.
One of the standout features is Intelligent Turn Detection. Unlike traditional silence-based detection, AssemblyAI's approach combines acoustic and semantic features, leading to faster and more accurate end-of-turn detection. This intelligent endpointing allows conversations to flow more naturally, reducing interruptions and enabling voice agents to respond with precise timing. Developers gain granular control with configurable silence thresholds and confidence parameters, allowing them to fine-tune the experience to their specific use case.
Beyond speed and accuracy, AssemblyAI emphasizes scalability and transparent pricing. The Streaming Speech-to-Text solution offers unlimited concurrency, meaning businesses can handle thousands of simultaneous connections without worrying about hard caps, over-stream surcharges, or complex capacity planning. This robust scalability ensures consistent performance whether you're managing 5 or 50,000+ streams, all while maintaining a highly competitive pricing model starting at just $0.15/hr. This transparent, per-session duration pricing avoids the pitfalls of pre-purchased capacity, offering a cost-effective solution that scales with actual usage.`);

  const [isPlaying, setIsPlaying] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [mouseAtBottom, setMouseAtBottom] = useState(false);
  const [isAtEnd, setIsAtEnd] = useState(false);
  const [manualScrollDirection, setManualScrollDirection] = useState<
    "up" | "down" | null
  >(null);

  const [settings, setSettings] = useState<TeleprompterSettings>({
    scrollMode: "auto",
    autoSpeed: 3,
    backgroundColor: "#000000",
    textColor: "#ffffff",
    fontSize: 48,
    flipHorizontal: false,
    flipVertical: false,
  });

  const [voiceState, setVoiceState] = useState<VoiceState>({
    isListening: false,
    isConnected: false,
    currentTranscript: "",
    spokenWords: new Set(),
    currentWordIndex: -1,
    nextWordIndex: -1,
    socket: null,
    audioContext: null,
    mediaStream: null,
    scriptProcessor: null,
  });

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const keysPressed = useRef<Set<string>>(new Set());
  const scriptWordsRef = useRef<string[]>([]);
  const fuseMatcherRef = useRef<FuseTextMatcher | null>(null);
  const lastTranscriptRef = useRef<string>("");
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const smoothScrollRef = useRef<{
    startPosition: number;
    targetPosition: number;
    startTime: number;
    duration: number;
    isAnimating: boolean;
  } | null>(null);

  // Use refs to store current settings values to avoid closure issues
  const currentSettingsRef = useRef(settings);
  const currentVoiceStateRef = useRef(voiceState);

  // Update the ref whenever settings change
  useEffect(() => {
    currentSettingsRef.current = settings;
  }, [settings]);

  // Update the ref whenever voice state changes
  useEffect(() => {
    currentVoiceStateRef.current = voiceState;
  }, [voiceState]);

  // Process script into words and create Fuse matcher when script changes
  useEffect(() => {
    const words = script.split(/\s+/).filter((word) => word.trim().length > 0);
    scriptWordsRef.current = words;

    // Create new Fuse matcher
    fuseMatcherRef.current = new FuseTextMatcher(script);
  }, [script]);

  // Check if at end of script
  const checkIfAtEnd = useCallback(() => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const isAtBottom =
        container.scrollTop >=
        container.scrollHeight - container.clientHeight - 10;
      setIsAtEnd(isAtBottom);
    }
  }, []);

  // Get AssemblyAI token
  const getAssemblyAIToken = async () => {
    try {
      const response = await fetch("/api/assemblyai/token");
      const data = await response.json();

      if (!data.token) {
        throw new Error("Failed to get token");
      }

      return data.token;
    } catch (error) {
      console.error("Error getting AssemblyAI token:", error);
      throw error;
    }
  };

  // Start voice listening
  const startVoiceListening = async () => {
    try {
      const token = await getAssemblyAIToken();

      // Request microphone permission
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Create WebSocket connection
      const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true&token=${token}`;
      const socket = new WebSocket(wsUrl);

      // Create audio context
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(mediaStream);
      const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

      // Handle audio processing
      scriptProcessor.onaudioprocess = (event) => {
        if (socket.readyState === WebSocket.OPEN) {
          const input = event.inputBuffer.getChannelData(0);
          const buffer = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            buffer[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
          }
          socket.send(buffer.buffer);
        }
      };

      // Handle WebSocket events
      socket.onopen = () => {
        console.log("Voice WebSocket connected");
        setVoiceState((prev) => ({ ...prev, isConnected: true }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "Turn") {
          handleTranscriptionUpdate(message.transcript, message.end_of_turn);
        }
      };

      socket.onerror = (error) => {
        console.error("Voice WebSocket error:", error);
        stopVoiceListening();
      };

      socket.onclose = () => {
        console.log("Voice WebSocket closed");
        setVoiceState((prev) => ({ ...prev, isConnected: false }));
      };

      // Update voice state
      setVoiceState((prev) => ({
        ...prev,
        isListening: true,
        socket,
        audioContext,
        mediaStream,
        scriptProcessor,
      }));
    } catch (error) {
      console.error("Error starting voice listening:", error);
    }
  };

  // Stop voice listening
  const stopVoiceListening = () => {
    // Clear any pending debounced updates
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    // Stop smooth scroll animation
    if (smoothScrollRef.current) {
      smoothScrollRef.current.isAnimating = false;
      smoothScrollRef.current = null;
    }

    setVoiceState((prev) => {
      // Cleanup audio resources
      if (prev.scriptProcessor) {
        prev.scriptProcessor.disconnect();
      }
      if (prev.audioContext) {
        prev.audioContext.close();
      }
      if (prev.mediaStream) {
        prev.mediaStream.getTracks().forEach((track) => track.stop());
      }
      if (prev.socket) {
        prev.socket.send(JSON.stringify({ type: "Terminate" }));
        prev.socket.close();
      }

      return {
        ...prev,
        isListening: false,
        isConnected: false,
        socket: null,
        audioContext: null,
        mediaStream: null,
        scriptProcessor: null,
      };
    });
  };

  // Handle transcription updates
  const handleTranscriptionUpdate = (
    transcript: string,
    endOfTurn: boolean
  ) => {
    setVoiceState((prev) => ({ ...prev, currentTranscript: transcript }));

    // Only process if transcript has changed significantly
    if (transcript.trim() && transcript !== lastTranscriptRef.current) {
      lastTranscriptRef.current = transcript;

      // Clear previous debounce timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Debounce the matching to prevent too frequent updates
      debounceTimeoutRef.current = setTimeout(() => {
        const matchResult = findBestMatch(transcript);
        if (matchResult) {
          updateScrollPosition(matchResult.index);
          setVoiceState((prev) => ({
            ...prev,
            currentWordIndex: matchResult.index,
            nextWordIndex: matchResult.nextWordIndex,
            spokenWords: new Set(matchResult.spokenWordIndices),
          }));
        }
      }, 150); // 150ms debounce delay
    }

    // Handle pause/resume based on end of turn
    if (endOfTurn) {
      setIsPlaying(false);
      // Clear any pending debounced updates
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
    } else if (!isPlaying && settings.scrollMode === "voice") {
      setIsPlaying(true);
    }
  }; // Find best match using Fuse.js-based fuzzy matching
  const findBestMatch = (transcript: string) => {
    if (!fuseMatcherRef.current) return null;

    const currentPosition = voiceState.currentWordIndex;
    const matchResult = fuseMatcherRef.current.findBestMatch(
      transcript,
      currentPosition
    );

    return matchResult;
  };

  // Update scroll position based on matched text with smooth animation
  const updateScrollPosition = (wordIndex: number) => {
    if (!scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const words = scriptWordsRef.current;

    // Calculate approximate position based on word index
    const progress = wordIndex / words.length;
    const targetPosition =
      progress * (container.scrollHeight - container.clientHeight);

    // Only scroll if the target position is significantly different from current position
    const currentPosition = container.scrollTop;
    const scrollThreshold = 30; // Lower threshold for smoother tracking

    if (Math.abs(targetPosition - currentPosition) > scrollThreshold) {
      // Initialize smooth scroll animation
      smoothScrollRef.current = {
        startPosition: currentPosition,
        targetPosition,
        startTime: Date.now(),
        duration: 800, // 800ms smooth scroll
        isAnimating: true,
      };

      // Start smooth scroll animation
      animateSmoothScroll();
    }
  };

  // Smooth scroll animation function
  const animateSmoothScroll = () => {
    if (!smoothScrollRef.current || !scrollContainerRef.current) return;

    const { startPosition, targetPosition, startTime, duration } =
      smoothScrollRef.current;
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Easing function for smooth animation
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const easedProgress = easeOutCubic(progress);

    const currentPosition =
      startPosition + (targetPosition - startPosition) * easedProgress;
    scrollContainerRef.current.scrollTop = currentPosition;

    if (progress < 1) {
      requestAnimationFrame(animateSmoothScroll);
    } else {
      smoothScrollRef.current.isAnimating = false;
    }
  }; // Cleanup voice resources on component unmount
  useEffect(() => {
    return () => {
      // Clear any pending debounced updates
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Stop smooth scroll animation
      if (smoothScrollRef.current) {
        smoothScrollRef.current.isAnimating = false;
      }

      if (voiceState.socket) {
        voiceState.socket.close();
      }
      if (voiceState.scriptProcessor) {
        voiceState.scriptProcessor.disconnect();
      }
      if (voiceState.audioContext) {
        voiceState.audioContext.close();
      }
      if (voiceState.mediaStream) {
        voiceState.mediaStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Cleanup voice resources when switching scroll modes
  useEffect(() => {
    if (settings.scrollMode !== "voice" && voiceState.isListening) {
      stopVoiceListening();
    }
  }, [settings.scrollMode]);
  useEffect(() => {
    if (isPlaying && settings.scrollMode === "auto") {
      const animate = (currentTime: number) => {
        if (lastTimeRef.current === 0) {
          lastTimeRef.current = currentTime;
        }

        const deltaTime = currentTime - lastTimeRef.current;
        lastTimeRef.current = currentTime;

        if (scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          // Use current settings values from ref instead of captured ones
          const currentSettings = currentSettingsRef.current;
          const scrollSpeed = (currentSettings.autoSpeed * 30) / 1000; // pixels per millisecond for smooth scrolling
          const scrollAmount =
            scrollSpeed * deltaTime * (currentSettings.flipVertical ? -1 : 1); // Reverse direction when flipped vertically

          const newPosition = container.scrollTop + scrollAmount;

          // Check bounds based on current flip direction
          if (currentSettings.flipVertical) {
            if (newPosition <= 0) {
              setIsPlaying(false);
              setIsAtEnd(true);
              return;
            }
          } else {
            if (
              newPosition >=
              container.scrollHeight - container.clientHeight
            ) {
              setIsPlaying(false);
              setIsAtEnd(true);
              return;
            }
          }

          container.scrollTop = newPosition;
          checkIfAtEnd();
        }

        if (isPlaying) {
          animationFrameRef.current = requestAnimationFrame(animate);
        }
      };

      // Only start animation if not already running
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    } else {
      // Only cleanup when actually stopping, not when parameters change
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      // Only reset time reference when actually stopping playback
      if (!isPlaying) {
        lastTimeRef.current = 0;
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying, settings.scrollMode, checkIfAtEnd]); // Removed autoSpeed and flipVertical from dependencies to prevent restart

  // Smooth manual scroll functionality - Fixed to respond to parameter changes during scrolling
  useEffect(() => {
    if (settings.scrollMode === "manual" && manualScrollDirection) {
      const animate = (currentTime: number) => {
        if (lastTimeRef.current === 0) {
          lastTimeRef.current = currentTime;
        }

        const deltaTime = currentTime - lastTimeRef.current;
        lastTimeRef.current = currentTime;

        if (scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          // Use current settings values from ref instead of captured ones
          const currentSettings = currentSettingsRef.current;
          const scrollSpeed = (currentSettings.autoSpeed * 30) / 1000; // Use same speed as auto mode

          // Determine direction based on key pressed and current vertical flip setting
          let direction = manualScrollDirection === "up" ? -1 : 1;
          if (currentSettings.flipVertical) {
            direction *= -1; // Reverse direction when flipped vertically
          }

          const scrollAmount = scrollSpeed * deltaTime * direction;

          const newPosition = Math.max(0, container.scrollTop + scrollAmount);

          // Don't scroll past the end
          if (newPosition >= container.scrollHeight - container.clientHeight) {
            container.scrollTop =
              container.scrollHeight - container.clientHeight;
            setManualScrollDirection(null);
            checkIfAtEnd();
            return;
          }

          container.scrollTop = newPosition;
          checkIfAtEnd();
        }

        if (manualScrollDirection) {
          animationFrameRef.current = requestAnimationFrame(animate);
        }
      };

      // Only start animation if not already running
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (!manualScrollDirection) {
        lastTimeRef.current = 0;
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [settings.scrollMode, manualScrollDirection, checkIfAtEnd]); // Removed autoSpeed and flipVertical from dependencies to prevent restart

  // Control functions
  const handleStart = async () => {
    if (!isAtEnd) {
      if (settings.scrollMode === "voice") {
        await startVoiceListening();
      }
      setIsPlaying(true);
    }
  };

  const handlePause = () => {
    setIsPlaying(false);
    if (settings.scrollMode === "voice") {
      stopVoiceListening();
    }
  };

  const handleStop = () => {
    setIsPlaying(false);
    if (settings.scrollMode === "voice") {
      stopVoiceListening();
    }
    if (scrollContainerRef.current) {
      // Reset to appropriate position based on current flip state
      const currentSettings = currentSettingsRef.current;
      if (currentSettings.flipVertical) {
        scrollContainerRef.current.scrollTop =
          scrollContainerRef.current.scrollHeight -
          scrollContainerRef.current.clientHeight;
      } else {
        scrollContainerRef.current.scrollTop = 0;
      }
    }
    setIsAtEnd(false);
    setVoiceState((prev) => ({
      ...prev,
      currentTranscript: "",
      spokenWords: new Set(),
      currentWordIndex: -1,
      nextWordIndex: -1,
    }));

    // Reset transcript reference
    lastTranscriptRef.current = "";
  };

  const handleRestart = () => {
    handleStop();
    setTimeout(() => setIsPlaying(true), 100);
  };

  const adjustSpeed = (direction: "up" | "down") => {
    setSettings((prev) => ({
      ...prev,
      autoSpeed: Math.max(
        1,
        Math.min(10, prev.autoSpeed + (direction === "up" ? 1 : -1))
      ),
    }));
  };

  const adjustFontSize = (direction: "up" | "down") => {
    setSettings((prev) => ({
      ...prev,
      fontSize: Math.max(
        24,
        Math.min(120, prev.fontSize + (direction === "up" ? 10 : -10))
      ),
    }));
  };

  // Mouse tracking for bottom panel
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const threshold = window.innerHeight - 100;
      setMouseAtBottom(e.clientY > threshold);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Panel visibility logic
  const shouldShowPanel = !isPlaying || mouseAtBottom;

  // Render script with highlighting for voice mode
  const renderScriptWithHighlighting = () => {
    if (settings.scrollMode !== "voice") {
      return script;
    }

    const words = scriptWordsRef.current;
    if (!words.length) return script;

    const highlightedWords = words.map((word, index) => {
      const isSpoken = voiceState.spokenWords.has(index);
      const isNextWord = index === voiceState.nextWordIndex;

      // Calculate colors based on text color
      const textColor = settings.textColor;
      const darkerTextColor = adjustColorBrightness(textColor, -0.4); // Darker for spoken words
      const highlightColor = "#FFD700"; // Gold color for next word

      return (
        <span
          key={index}
          style={{
            color: isSpoken
              ? darkerTextColor
              : isNextWord
              ? highlightColor
              : textColor,
            // fontWeight: isNextWord ? "bold" : "normal",
            transition: "color 0.2s ease-in-out, font-weight 0.3s ease-in-out",
          }}
        >
          {word}
        </span>
      );
    });

    return (
      <span>
        {highlightedWords.map((wordElement, index) => (
          <span key={index}>
            {wordElement}
            {index < highlightedWords.length - 1 && " "}
          </span>
        ))}
      </span>
    );
  };

  // Helper function to adjust color brightness
  const adjustColorBrightness = (color: string, factor: number) => {
    try {
      // Handle different color formats
      let hex = color;
      if (color.startsWith("#")) {
        hex = color.substring(1);
      } else if (color.startsWith("rgb")) {
        // Convert rgb to hex if needed
        const rgbMatch = color.match(/\d+/g);
        if (rgbMatch && rgbMatch.length >= 3) {
          const r = parseInt(rgbMatch[0]);
          const g = parseInt(rgbMatch[1]);
          const b = parseInt(rgbMatch[2]);
          hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
        }
      }

      // Ensure hex is 6 characters
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }

      if (hex.length !== 6) {
        return color; // Return original if parsing fails
      }

      const r = parseInt(hex.substr(0, 2), 16);
      const g = parseInt(hex.substr(2, 2), 16);
      const b = parseInt(hex.substr(4, 2), 16);

      // Apply brightness factor (negative makes darker, positive makes lighter)
      const newR = Math.max(0, Math.min(255, r * (1 + factor)));
      const newG = Math.max(0, Math.min(255, g * (1 + factor)));
      const newB = Math.max(0, Math.min(255, b * (1 + factor)));

      // Convert back to hex
      const toHex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
      return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
    } catch (error) {
      console.warn("Color adjustment failed:", error);
      return color; // Return original color if adjustment fails
    }
  };

  // Keyboard shortcuts with smooth manual scrolling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      keysPressed.current.add(e.key.toLowerCase());

      // Handle manual scrolling with smooth animation - ONLY in manual mode
      if (settings.scrollMode === "manual") {
        if (e.key === "ArrowUp" && !manualScrollDirection) {
          e.preventDefault();
          setManualScrollDirection("up");
        } else if (e.key === "ArrowDown" && !manualScrollDirection) {
          e.preventDefault();
          setManualScrollDirection("down");
        }
      }

      // Other shortcuts (only trigger once)
      if (e.repeat) return;

      switch (e.key.toLowerCase()) {
        case " ":
        case "p":
          e.preventDefault();
          isPlaying ? handlePause() : handleStart();
          break;
        case "s":
          e.preventDefault();
          handleStop();
          break;
        case "r":
          e.preventDefault();
          handleRestart();
          break;
        case "arrowleft":
          adjustSpeed("down");
          break;
        case "arrowright":
          adjustSpeed("up");
          break;
        case "h":
          e.preventDefault();
          setSettings((prev) => ({
            ...prev,
            flipHorizontal: !prev.flipHorizontal,
          }));
          break;
        case "v":
          e.preventDefault();
          setSettings((prev) => ({
            ...prev,
            flipVertical: !prev.flipVertical,
          }));
          break;
        case "e":
          e.preventDefault();
          setShowEditor(!showEditor);
          break;
        case "escape":
          e.preventDefault();
          setShowEditor(false);
          setShowSettings(false);
          break;
        case "+":
        case "=":
          e.preventDefault();
          adjustFontSize("up");
          break;
        case "-":
        case "_":
          e.preventDefault();
          adjustFontSize("down");
          break;
        case "?":
          e.preventDefault();
          setShowSettings(!showSettings);
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      keysPressed.current.delete(e.key.toLowerCase());

      // Stop manual scrolling when key is released - ONLY in manual mode
      if (settings.scrollMode === "manual") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          setManualScrollDirection(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    isPlaying,
    showEditor,
    showSettings,
    settings.scrollMode,
    manualScrollDirection,
  ]);

  // Handle manual scroll on container (mouse/touch)
  const handleContainerScroll = () => {
    checkIfAtEnd();
  };

  const textTransform = `
    ${settings.flipHorizontal ? "scaleX(-1)" : ""} 
    ${settings.flipVertical ? "scaleY(-1)" : ""}
  `.trim();

  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{ backgroundColor: settings.backgroundColor }}
    >
      {/* Script Editor Overlay */}
      {showEditor && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-xl font-semibold">Script Editor</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEditor(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-4">
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="Enter your script here..."
                className="min-h-[400px] font-mono text-base resize-none border-0 focus-visible:ring-0"
              />
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-xl font-semibold">Keyboard Shortcuts</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSettings(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="font-medium">Space</span>
                    <span className="text-muted-foreground">Start/Pause</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">R</span>
                    <span className="text-muted-foreground">Restart</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">←/→</span>
                    <span className="text-muted-foreground">Adjust speed</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">↑/↓</span>
                    <span className="text-muted-foreground">Manual scroll</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">+/-</span>
                    <span className="text-muted-foreground">Font size</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="font-medium">H</span>
                    <span className="text-muted-foreground">
                      Flip horizontal
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">V</span>
                    <span className="text-muted-foreground">Flip vertical</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">E</span>
                    <span className="text-muted-foreground">Edit script</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">Esc</span>
                    <span className="text-muted-foreground">
                      Close overlays
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium">?</span>
                    <span className="text-muted-foreground">
                      Show shortcuts
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Teleprompter Display */}
      <div
        ref={scrollContainerRef}
        className="h-screen overflow-y-auto scrollbar-hide"
        style={{ color: settings.textColor }}
        onScroll={handleContainerScroll}
      >
        <div
          className="p-8 leading-relaxed whitespace-pre-wrap min-h-screen flex items-center justify-center pb-32"
          style={{
            fontSize: `${settings.fontSize}px`,
            transform: textTransform,
          }}
        >
          <div className="max-w-5xl text-center">
            {renderScriptWithHighlighting()}
          </div>
        </div>
      </div>

      {/* Bottom Control Panel */}
      <div
        className={`fixed bottom-0 left-0 right-0 transition-all duration-300 ease-in-out ${
          shouldShowPanel ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="bg-black/40 backdrop-blur-md border-t border-white/10 px-6 py-4">
          <div className="flex items-center justify-between max-w-7xl mx-auto">
            {/* Left Controls */}
            <div className="flex items-center gap-3">
              <Button
                onClick={isPlaying ? handlePause : handleStart}
                disabled={isAtEnd && !isPlaying}
                className={`${
                  isPlaying
                    ? "bg-red-500 hover:bg-red-600 text-white"
                    : "bg-pink-500 hover:bg-pink-600 text-white"
                } px-6 py-2 rounded-full font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {settings.scrollMode === "voice" ? (
                  isPlaying ? (
                    <>
                      <MicOff className="w-4 h-4 mr-2" />
                      Stop Listening
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4 mr-2" />
                      Start Listening
                    </>
                  )
                ) : isPlaying ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Start
                  </>
                )}
              </Button>

              <Button
                onClick={handleRestart}
                variant="outline"
                className="bg-white/10 border-white/20 hover:text-white text-white hover:bg-white/20 px-4 py-2 rounded-full"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Restart
              </Button>
            </div>

            {/* Center Controls */}
            <div className="flex items-center gap-4">
              <Select
                value={settings.scrollMode}
                onValueChange={(value: ScrollMode) =>
                  setSettings((prev) => ({ ...prev, scrollMode: value }))
                }
              >
                <SelectTrigger className="bg-white/10 border-white/20 text-white w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="voice">Voice</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => adjustSpeed("down")}
                  className="text-white hover:text-white hover:bg-white/20 p-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-white font-mono text-lg w-8 text-center">
                  {settings.autoSpeed}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => adjustSpeed("up")}
                  className="text-white hover:text-white hover:bg-white/20 p-2"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>

              {/* Voice Mode Status */}
              {settings.scrollMode === "voice" && (
                <div className="flex items-center gap-2 border-l border-white/20 pl-4">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        voiceState.isConnected ? "bg-green-400" : "bg-red-400"
                      } ${voiceState.isListening ? "animate-pulse" : ""}`}
                    />
                    <span className="text-white text-sm">
                      {voiceState.isConnected ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                  {voiceState.currentTranscript && (
                    <div className="flex items-center gap-2 ml-2">
                      <span className="text-white/70 text-xs">Heard:</span>
                      <span className="text-white/70 text-xs max-w-40 truncate">
                        "{voiceState.currentTranscript}"
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 border-l border-white/20 pl-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => adjustFontSize("down")}
                  className="text-white hover:text-white hover:bg-white/20 p-2"
                  title="Decrease Font Size"
                >
                  <span className="text-sm font-bold">A-</span>
                </Button>
                <span className="text-white text-sm w-8 text-center">
                  {settings.fontSize}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => adjustFontSize("up")}
                  className="text-white hover:text-white hover:bg-white/20 p-2"
                  title="Increase Font Size"
                >
                  <span className="text-sm font-bold">A+</span>
                </Button>
              </div>

              <div className="flex items-center gap-2 border-l border-white/20 pl-4">
                <div className="relative group">
                  <input
                    type="color"
                    value={settings.backgroundColor}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        backgroundColor: e.target.value,
                      }))
                    }
                    className="w-8 h-8 rounded-full border-2 border-white/20 cursor-pointer opacity-0 absolute inset-0"
                  />
                  <div
                    className="w-8 h-8 rounded-full border-2 border-white/20 cursor-pointer"
                    style={{ backgroundColor: settings.backgroundColor }}
                  />
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-black text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    Background Color
                  </div>
                </div>

                <div className="relative group">
                  <input
                    type="color"
                    value={settings.textColor}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        textColor: e.target.value,
                      }))
                    }
                    className="w-8 h-8 rounded-full border-2 border-white/20 cursor-pointer opacity-0 absolute inset-0"
                  />
                  <div
                    className="w-8 h-8 rounded-full border-2 border-white/20 cursor-pointer flex items-center justify-center text-sm font-bold"
                    style={{
                      backgroundColor: settings.backgroundColor,
                      color: settings.textColor,
                    }}
                  >
                    A
                  </div>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-black text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    Text Color
                  </div>
                </div>
              </div>
            </div>

            {/* Right Controls */}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEditor(true)}
                className="text-white hover:text-white hover:bg-white/20 p-2"
                title="Edit Script"
              >
                <Edit3 className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    flipHorizontal: !prev.flipHorizontal,
                  }))
                }
                className={`text-white hover:text-white hover:bg-white/20 p-2 ${
                  settings.flipHorizontal ? "bg-white/20" : ""
                }`}
                title="Flip Horizontal"
              >
                <FlipHorizontal className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    flipVertical: !prev.flipVertical,
                  }))
                }
                className={`text-white hover:text-white hover:bg-white/20 p-2 ${
                  settings.flipVertical ? "bg-white/20" : ""
                }`}
                title="Flip Vertical"
              >
                <FlipVertical className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:text-white hover:bg-white/20 p-2"
                title="Fullscreen"
              >
                <Maximize className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSettings(true)}
                className="text-white hover:text-white hover:bg-white/20 p-2"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
