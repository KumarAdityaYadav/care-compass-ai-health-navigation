/**
 * CareCompass Conversational AI Chatbot Types
 */

import type {
  CareType,
  Urgency,
  DetectedLanguage,
  ScreeningStatus,
  Location,
  MatchedCaregiverResult,
  ScreeningSessionState
} from './triage.ts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  suggestedOptions?: string[];
  redFlags?: string[];
  matchedCaregivers?: MatchedCaregiverResult[];
  canBook?: boolean;
  careType?: CareType;
  urgency?: Urgency;
  isEmergency?: boolean;
  reasoning?: string;
  isAiPowered?: boolean;
}

export interface ChatRequest {
  sessionId?: string;
  message: string;
  language?: 'auto' | 'English' | 'Hindi' | 'Hinglish';
  location?: Location;
  rejected_caregiver_id?: string;
  selected_caregiver_id?: string;
}

export interface ChatResponse {
  sessionId: string;
  assistantMessage: string;
  screeningStatus: ScreeningStatus;
  followUpQuestion: string | null;
  missingInformation: string[];
  language: DetectedLanguage;
  careType: CareType;
  urgency: Urgency;
  redFlags: string[];
  reasoning: string;
  matchedCaregivers: MatchedCaregiverResult[];
  suggestedOptions: string[];
  canBook: boolean;
  nextAction: 'answer_question' | 'confirm_booking' | 'call_112' | 'human_helpline' | 'provide_location';
  isAiPowered: boolean;
  modelUsed: string | null;
  sessionState?: Partial<ScreeningSessionState>;
}
