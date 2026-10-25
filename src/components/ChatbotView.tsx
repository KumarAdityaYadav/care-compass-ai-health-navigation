/**
 * CareCompass AI Chatbot View
 *
 * Full-featured conversational AI healthcare navigation interface:
 * - Multi-turn conversational history with speech bubbles
 * - Quick start prompt tiles for common inquiries
 * - Module 0 Emergency Safety Alert presentation with direct 112 call
 * - Interactive quick-reply option pills
 * - Real Matched Caregiver Cards with booking confirmation triggers
 * - Caregiver rotation / anti-repetition action
 * - Web Speech voice input and text-to-speech aloud reading
 * - Explicit non-diagnostic clinical boundaries and disclaimers
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Mic,
  MicOff,
  Volume2,
  RotateCcw,
  Bot,
  User,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  PhoneCall,
  Calendar,
  Star,
  Clock,
  MapPin,
  HeartPulse,
  RefreshCw,
  Info
} from 'lucide-react';
import { AppLanguage, I18N } from '../i18n/translations.ts';
import { ChatMessage, ChatResponse } from '../types/chat.ts';
import { sendChatMessage, resetChatSession } from '../services/chatClient.ts';
import { CAREGIVERS } from '../data/caregivers.ts';
import { Caregiver } from '../types/triage.ts';
import { speakAloud } from './VoiceController.tsx';

interface ChatbotViewProps {
  language: AppLanguage;
  onLanguageChange: (lang: AppLanguage) => void;
  onBookCaregiver: (caregiverId: string, careType: string) => void;
  onTriggerEmergency: () => void;
}

const QUICK_PROMPTS = [
  {
    icon: '🤒',
    labelEn: 'Papa has fever for 2 days',
    labelHi: 'पापा को 2 दिन से बुखार है',
    labelHing: 'Papa ko 2 din se bukhar hai',
    prompt: 'Mere papa ko do din se bukhar hai, advice chahiye'
  },
  {
    icon: '💉',
    labelEn: 'Doctor prescribed injection, need nurse',
    labelHi: 'डॉक्टर ने इंजेक्शन लिखा है, नर्स चाहिए',
    labelHing: 'Doctor ne injection likha hai, nurse chahiye',
    prompt: 'Doctor ne injection prescribe kiya hai, ghar par qualified nurse chahiye Saket me'
  },
  {
    icon: '🩸',
    labelEn: 'Home sample collection for blood test',
    labelHi: 'ब्लड टेस्ट के लिए होम सैंपल कलेक्शन',
    labelHing: 'Blood test ke liye sample collection',
    prompt: 'Kal subah CBC blood test ke liye home sample collection chahiye Saket area me'
  },
  {
    icon: '👨‍⚕️',
    labelEn: 'Consult doctor for medical report review',
    labelHi: 'रिपोर्ट दिखाने के लिए डॉक्टर से सलाह',
    labelHing: 'Reports dikhane ke liye doctor consult',
    prompt: 'Mujhe apni blood test reports doctor ko online dikhani hain, mere liye'
  }
];

export const ChatbotView: React.FC<ChatbotViewProps> = ({
  language,
  onLanguageChange,
  onBookCaregiver,
  onTriggerEmergency
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sessionId, setSessionId] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [latestResponse, setLatestResponse] = useState<ChatResponse | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isProcessing]);

  // Handle sending a chat message
  const handleSend = async (textToSend?: string) => {
    const rawText = textToSend || inputText;
    if (!rawText || !rawText.trim() || isProcessing) return;

    const trimmed = rawText.trim();
    setInputText('');

    // Append user message immediately to the UI
    const userMsg: ChatMessage = {
      id: `usr_${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    setIsProcessing(true);
    setSpeechError(null);

    try {
      const response = await sendChatMessage({
        sessionId: sessionId || undefined,
        message: trimmed,
        language: language === 'Hinglish' ? 'Hinglish' : language,
        location: { lat: 28.5244, lng: 77.2066 } // Default Delhi NCR
      });

      if (response) {
        if (response.sessionId) {
          setSessionId(response.sessionId);
        }
        setLatestResponse(response);

        // Update language if detected differently
        if (response.language && response.language !== language) {
          onLanguageChange(response.language);
        }

        const assistantMsg: ChatMessage = {
          id: `ast_${Date.now()}`,
          role: 'assistant',
          content: response.assistantMessage,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          suggestedOptions: response.suggestedOptions || [],
          redFlags: response.redFlags || [],
          matchedCaregivers: response.matchedCaregivers || [],
          canBook: response.canBook,
          careType: response.careType,
          urgency: response.urgency,
          isEmergency: response.screeningStatus === 'emergency' || response.careType === 'emergency_112',
          reasoning: response.reasoning,
          isAiPowered: response.isAiPowered
        };

        setMessages(prev => [...prev, assistantMsg]);

        // Auto-speak emergency warning or follow-up question if enabled
        if (assistantMsg.isEmergency) {
          speakAloud(assistantMsg.content, language);
        }
      }
    } catch (err: any) {
      console.error('[ChatbotView] Send message error:', err);
      const errorMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        role: 'system',
        content: language === 'Hindi'
          ? "संदेश भेजने में त्रुटि हुई। कृपया पुनः प्रयास करें।"
          : "Network error processing your request. Please try again.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
    }
  };

  // Reject / rotate top caregiver (Anti-repetition)
  const handleRejectCaregiver = async (caregiverId: string) => {
    if (!sessionId || isProcessing) return;
    setIsProcessing(true);

    try {
      const response = await sendChatMessage({
        sessionId,
        message: 'Different caregiver requested',
        rejected_caregiver_id: caregiverId,
        language: language === 'Hinglish' ? 'Hinglish' : language
      });

      if (response && response.matchedCaregivers) {
        setLatestResponse(response);
        // Append update message
        const updateMsg: ChatMessage = {
          id: `ast_${Date.now()}`,
          role: 'assistant',
          content: language === 'Hindi'
            ? `हमने आपकी पसंद नोट कर ली है। दूसरे योग्य सेवा प्रदाता:`
            : language === 'Hinglish'
            ? `Aapki preference ke hisaab se alternative verified caregivers:`
            : `Showing alternative verified healthcare providers:`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          matchedCaregivers: response.matchedCaregivers,
          canBook: response.canBook,
          careType: response.careType
        };
        setMessages(prev => [...prev, updateMsg]);
      }
    } catch (err) {
      console.error('Failed to rotate caregiver:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset conversation
  const handleResetSession = async () => {
    if (sessionId) {
      await resetChatSession(sessionId);
    }
    setSessionId('');
    setMessages([]);
    setLatestResponse(null);
    setInputText('');
  };

  // Speech Recognition
  const toggleSpeechRecognition = () => {
    setSpeechError(null);
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSpeechError(
        language === 'Hindi'
          ? 'आपके ब्राउज़र में आवाज़ पहचान उपलब्ध नहीं है।'
          : 'Web Speech recognition not supported in this browser.'
      );
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = language === 'Hindi' || language === 'Hinglish' ? 'hi-IN' : 'en-IN';

      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript && transcript.trim()) {
          setInputText(transcript.trim());
          handleSend(transcript.trim());
        }
        setIsListening(false);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);

      recognition.start();
    } catch (err) {
      console.warn('Speech error:', err);
      setIsListening(false);
    }
  };

  // Keydown for enter to send
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] max-w-4xl mx-auto w-full bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Chat Top Banner */}
      <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-teal-500/20 border border-teal-400/40 flex items-center justify-center text-teal-300">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold tracking-tight text-white">
                CareCompass AI Chatbot
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live AI + Module 0 Safety
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              English · हिन्दी · Hinglish · Non-diagnostic Triage & Caregiver Dispatch
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {sessionId && (
            <span className="text-[10px] text-slate-400 font-mono hidden sm:inline bg-slate-800/80 px-2 py-1 rounded">
              Session: {sessionId.slice(0, 14)}...
            </span>
          )}
          <button
            onClick={handleResetSession}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer text-xs flex items-center gap-1 border border-slate-700"
            title="Start New Conversation"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-xs font-semibold">New Session</span>
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-50/50">
        {/* Welcome State when no messages */}
        {messages.length === 0 && (
          <div className="py-6 sm:py-8 space-y-6 max-w-2xl mx-auto text-center">
            <div className="space-y-2">
              <div className="inline-flex p-3 rounded-2xl bg-teal-50 border border-teal-100 text-teal-800 mb-2">
                <HeartPulse className="w-8 h-8 animate-pulse text-teal-700" />
              </div>
              <h3 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
                {language === 'Hindi'
                  ? "नमस्ते! केयरकम्पास एआई में आपका स्वागत है"
                  : language === 'Hinglish'
                  ? "Namaste! CareCompass AI assistant me aapka swagat hai"
                  : "Welcome to CareCompass AI Care Assistant"}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
                {language === 'Hindi'
                  ? "अपनी या परिवार के किसी सदस्य की स्वास्थ्य समस्या बताएं। हम तुरंत सुरक्षा जांच, उपयुक्त देखभाल और योग्य डॉक्टर/नर्स का सुझाव देंगे।"
                  : language === 'Hinglish'
                  ? "Apni ya parivaar ki health requirement batayein. Ham safety check karke sahi service aur verified caregiver match karenge."
                  : "Share your symptoms or care requirements. We screen for safety, clarify needs conversationally, and match verified caregivers across Delhi NCR."}
              </p>
            </div>

            {/* Quick Prompts */}
            <div className="space-y-2 text-left">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider text-center">
                {language === 'Hindi' ? "शुरुआती सुझाव चुनें:" : language === 'Hinglish' ? "Quick Start Prompts:" : "Select a common request to start:"}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {QUICK_PROMPTS.map((qp, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(qp.prompt)}
                    className="p-3 bg-white hover:bg-teal-50/60 rounded-2xl border border-slate-200 hover:border-teal-300 transition-all text-left group shadow-2xs hover:shadow-xs cursor-pointer flex items-start gap-2.5"
                  >
                    <span className="text-xl shrink-0 group-hover:scale-110 transition-transform">
                      {qp.icon}
                    </span>
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-slate-800 group-hover:text-teal-900 block truncate">
                        {language === 'Hindi' ? qp.labelHi : language === 'Hinglish' ? qp.labelHing : qp.labelEn}
                      </span>
                      <span className="text-[11px] text-slate-500 line-clamp-1">
                        "{qp.prompt}"
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Emergency Hotline Pill */}
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 flex items-center justify-between gap-3 text-left">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
                <span>
                  <strong>Emergency warning:</strong> For chest pain, sudden breathlessness, or collapse, call 112 directly.
                </span>
              </div>
              <button
                onClick={onTriggerEmergency}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold text-xs shrink-0 cursor-pointer"
              >
                Call 112
              </button>
            </div>
          </div>
        )}

        {/* Message Thread */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} space-y-2`}
          >
            <div
              className={`flex items-start gap-2.5 max-w-[88%] sm:max-w-[80%] ${
                msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
              }`}
            >
              {/* Avatar */}
              <div
                className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold ${
                  msg.role === 'user'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : msg.isEmergency
                    ? 'bg-rose-600 text-white'
                    : 'bg-teal-700 text-white shadow-2xs'
                }`}
              >
                {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              {/* Message Bubble */}
              <div
                className={`rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-slate-900 text-white rounded-tr-xs shadow-2xs'
                    : msg.isEmergency
                    ? 'bg-rose-50 border-2 border-rose-400 text-rose-950 rounded-tl-xs shadow-xs'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-tl-xs shadow-2xs'
                }`}
              >
                {/* Emergency Header if applicable */}
                {msg.isEmergency && (
                  <div className="flex items-center gap-2 font-bold text-rose-700 mb-2 pb-2 border-b border-rose-200">
                    <ShieldAlert className="w-4 h-4 animate-bounce" />
                    <span>EMERGENCY 112 DISPATCH REQUIRED</span>
                  </div>
                )}

                {/* Content */}
                <p className="whitespace-pre-wrap">{msg.content}</p>

                {/* Emergency Red Flags Listed */}
                {msg.redFlags && msg.redFlags.length > 0 && (
                  <div className="mt-2.5 pt-2 border-t border-rose-200/80 text-[11px] text-rose-800">
                    <span className="font-bold">Detected Red Flags: </span>
                    {msg.redFlags.join(', ')}
                  </div>
                )}

                {/* Emergency Action Button */}
                {msg.isEmergency && (
                  <div className="mt-3 pt-2 flex items-center gap-2">
                    <a
                      href="tel:112"
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-xs"
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      <span>Dial 112 Immediately</span>
                    </a>
                    <span className="text-[11px] text-rose-700 italic">
                      Do not wait for home visit.
                    </span>
                  </div>
                )}

                {/* Meta details & Audio button */}
                <div
                  className={`mt-2 flex items-center justify-between text-[10px] gap-2 pt-1 border-t ${
                    msg.role === 'user'
                      ? 'border-slate-800 text-slate-400'
                      : 'border-slate-100 text-slate-400'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span>{msg.timestamp}</span>
                    {msg.isAiPowered && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-teal-50 text-teal-700 font-semibold border border-teal-200">
                        Gemini AI
                      </span>
                    )}
                  </div>

                  {msg.role === 'assistant' && (
                    <button
                      onClick={() => speakAloud(msg.content, language)}
                      className="text-slate-400 hover:text-teal-700 flex items-center gap-1 cursor-pointer transition-colors"
                      title="Read aloud"
                    >
                      <Volume2 className="w-3 h-3" />
                      <span className="hidden sm:inline">Listen</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Suggested Quick Options Pills (if provided with follow-up) */}
            {msg.suggestedOptions && msg.suggestedOptions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-11 max-w-[85%]">
                {msg.suggestedOptions.map((option, optIdx) => (
                  <button
                    key={optIdx}
                    onClick={() => handleSend(option)}
                    disabled={isProcessing}
                    className="px-3 py-1.5 rounded-full bg-white hover:bg-teal-50 border border-slate-300 hover:border-teal-500 text-xs font-semibold text-slate-700 hover:text-teal-900 transition-all shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}

            {/* Matched Caregiver Cards (if ready for recommendation) */}
            {msg.matchedCaregivers && msg.matchedCaregivers.length > 0 && (
              <div className="w-full pl-0 sm:pl-11 pt-2 space-y-2.5 max-w-2xl">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Verified Matched Healthcare Providers
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {msg.matchedCaregivers.length} providers available
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-2.5">
                  {msg.matchedCaregivers.map((match) => {
                    const caregiver = CAREGIVERS.find(c => c.caregiver_id === match.caregiver_id);
                    if (!caregiver) return null;

                    return (
                      <div
                        key={caregiver.caregiver_id}
                        className="p-4 bg-white rounded-2xl border border-slate-200 hover:border-teal-400 shadow-2xs hover:shadow-xs transition-all space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="w-11 h-11 rounded-2xl bg-teal-50 text-teal-800 font-bold flex items-center justify-center text-sm border border-teal-200 shrink-0">
                              {caregiver.role === 'doctor' ? '👨‍⚕️' : caregiver.role === 'phlebotomist' ? '🩸' : '🩺'}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-bold text-slate-900">
                                  {caregiver.role === 'doctor' ? `Dr. ${caregiver.name}` : caregiver.name}
                                </h4>
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700">
                                  {caregiver.role}
                                </span>
                              </div>
                              <p className="text-xs text-slate-500 font-medium">
                                {caregiver.qualification} · {caregiver.experience_years} yrs exp
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 text-amber-500 text-xs font-bold bg-amber-50 px-2 py-1 rounded-lg border border-amber-200">
                            <Star className="w-3.5 h-3.5 fill-amber-400" />
                            <span>{caregiver.rating.toFixed(1)}</span>
                          </div>
                        </div>

                        {/* Location, match reason & details */}
                        <div className="text-xs text-slate-600 space-y-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                          <div className="flex items-center gap-2 text-slate-700">
                            <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>Base Area: <strong>{caregiver.base_area}</strong> (Radius: {caregiver.max_radius_km} km)</span>
                          </div>
                          {match.reason && (
                            <p className="text-[11px] text-teal-800 font-medium">
                              ✓ {match.reason}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-1 pt-1">
                            {caregiver.skills.slice(0, 3).map((sk, skIdx) => (
                              <span key={skIdx} className="px-1.5 py-0.5 rounded text-[9px] bg-white border border-slate-200 text-slate-600">
                                {sk.replace(/_/g, ' ')}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Booking actions */}
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
                          <button
                            onClick={() => handleRejectCaregiver(caregiver.caregiver_id)}
                            disabled={isProcessing}
                            className="text-xs text-slate-500 hover:text-slate-800 underline font-medium cursor-pointer"
                          >
                            Choose different caregiver
                          </button>

                          <button
                            onClick={() => onBookCaregiver(caregiver.caregiver_id, msg.careType || 'home_nursing')}
                            className="px-4 py-2 bg-slate-900 hover:bg-teal-800 text-white text-xs font-bold rounded-xl transition-colors cursor-pointer shadow-2xs flex items-center gap-1.5"
                          >
                            <Calendar className="w-3.5 h-3.5" />
                            <span>Confirm & Book</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {isProcessing && (
          <div className="flex items-center gap-2.5 pl-1">
            <div className="w-8 h-8 rounded-xl bg-teal-700 text-white flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 animate-spin" />
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl px-4 py-2.5 text-xs text-slate-500 shadow-2xs flex items-center gap-2">
              <span className="flex space-x-1">
                <span className="w-1.5 h-1.5 bg-teal-600 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 bg-teal-600 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 bg-teal-600 rounded-full animate-bounce" />
              </span>
              <span>CareCompass is analyzing clinical context...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Box Footer */}
      <div className="p-3 sm:p-4 bg-white border-t border-slate-200 shrink-0 space-y-2">
        {speechError && (
          <div className="text-xs text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{speechError}</span>
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Voice Input Button */}
          <button
            type="button"
            onClick={toggleSpeechRecognition}
            disabled={isProcessing}
            className={`p-2.5 rounded-2xl border transition-all cursor-pointer shrink-0 ${
              isListening
                ? 'bg-rose-500 text-white border-rose-600 animate-pulse shadow-xs'
                : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
            }`}
            title={isListening ? 'Listening... click to stop' : 'Click to speak in Hindi/English'}
          >
            {isListening ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>

          {/* Multiline Textarea */}
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                language === 'Hindi'
                  ? "अपनी समस्या लिखें (जैसे 'पापा को बुखार है')... (Enter भेजें)"
                  : language === 'Hinglish'
                  ? "Apni requirement likhein (jaise 'Mere papa ko bukhar hai')... (Enter to send)"
                  : "Type your health query or answer... (Enter to send, Shift+Enter for newline)"
              }
              disabled={isProcessing}
              className="w-full px-4 py-2.5 rounded-2xl border border-slate-300 bg-slate-50 focus:bg-white text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-teal-700 outline-none resize-none max-h-24 leading-normal"
            />
          </div>

          {/* Send Button */}
          <button
            type="button"
            onClick={() => handleSend()}
            disabled={isProcessing || !inputText.trim()}
            className="p-2.5 rounded-2xl bg-slate-900 hover:bg-teal-800 disabled:opacity-40 text-white transition-colors cursor-pointer shrink-0 shadow-2xs flex items-center justify-center"
            title="Send message"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>

        {/* Disclaimer Note */}
        <p className="text-[10px] text-center text-slate-400 leading-tight">
          Strict Non-Diagnostic Boundary: CareCompass AI assists with intake triage and caregiver dispatch. In acute emergencies, dial 112 immediately.
        </p>
      </div>
    </div>
  );
};
