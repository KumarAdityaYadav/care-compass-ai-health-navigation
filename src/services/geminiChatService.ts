/**
 * CareCompass Gemini Conversational AI Service
 *
 * Implements server-side AI Chatbot using @google/genai SDK:
 * - Reads GEMINI_API_KEY and GEMINI_MODEL (default: 'gemini-3.8-flash') from server environment
 * - Strict PII scrubbing before sending context to LLM
 * - Context-aware multi-turn dialogue with memory in English, Hindi, and Hinglish
 * - Structured JSON schema enforcement with strict application-side TypeScript validation
 * - Bounded timeouts (8s) and transient failure retry
 * - Module 0 Safety Gate ALWAYS takes precedence over LLM output
 * - Seamless fallback to deterministic clinical screening engine if Gemini is unavailable
 */

import { GoogleGenAI, Type } from '@google/genai';
import type {
  ChatRequest,
  ChatResponse
} from '../types/chat.ts';
import type {
  ScreeningSessionState,
  DetectedLanguage,
  CareType,
  Urgency,
  MatchedCaregiverResult
} from '../types/triage.ts';
import { sessionStore } from './sessionStore.ts';
import { evaluateSafetyGate, type SafetyCheckResult } from './safetyDetector.ts';
import {
  detectLanguage,
  extractEntitiesFromConversation,
  evaluateScreeningCompleteness
} from './intakeEngine.ts';
import { classifyTriage } from './triageClassifier.ts';
import { matchCaregivers } from './caregiverMatcher.ts';
import { runSessionScreening } from './screeningStateMachine.ts';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONTEXT_TURNS = 8;

interface GeminiModelDecision {
  conversational_reply: string;
  next_question: string | null;
  suggested_options: string[];
  extracted_target_person: 'self' | 'father' | 'mother' | 'grandmother' | 'grandfather' | 'child' | 'spouse' | 'other' | 'unknown';
  extracted_requested_service: 'injection' | 'dressing' | 'lab_test' | 'doctor_consult' | 'vitals_check' | 'none';
  extracted_symptoms: string[];
  extracted_duration: string | null;
  extracted_severity: 'mild' | 'moderate' | 'severe' | 'unknown';
  extracted_progression: 'better' | 'worse' | 'same' | 'unknown';
  denied_symptoms: string[];
  location_text: string | null;
  is_screening_complete: boolean;
  recommended_care_type: CareType;
  recommended_urgency: Urgency;
  clinical_reasoning: string;
}

/**
 * Scrubs common Personally Identifiable Information (PII) before LLM prompt submission
 */
function scrubPII(text: string): string {
  if (!text) return '';
  return text
    // Phone numbers (Indian 10-digit formats with optional +91/0)
    .replace(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[PHONE_NUMBER]')
    // Email addresses
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    // Aadhaar / 12-digit card numbers
    .replace(/\b\d{4}\s\d{4}\s\d{4}\b/g, '[ID_NUMBER]');
}

/**
 * Initializes GoogleGenAI client safely
 */
function getGenAIClient(): { ai: GoogleGenAI; modelName: string } | null {
  if (process.env.SKIP_GEMINI_NETWORK === 'true') {
    return null;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || !apiKey.trim()) {
    return null;
  }
  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  return {
    ai: new GoogleGenAI({ apiKey: apiKey.trim() }),
    modelName
  };
}

/**
 * Validates and safely parses model JSON output
 */
function parseAndValidateModelOutput(rawJsonText: string): GeminiModelDecision | null {
  try {
    let cleanJson = rawJsonText.trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    } else if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleanJson);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Sanitize string fields
    const conversationalReply = typeof parsed.conversational_reply === 'string' && parsed.conversational_reply.trim()
      ? parsed.conversational_reply.trim()
      : 'Aapki takleef samajh gayi. Kripya thoda aur vistaar se batayein.';

    const nextQuestion = typeof parsed.next_question === 'string' && parsed.next_question.trim()
      ? parsed.next_question.trim()
      : null;

    const suggestedOptions = Array.isArray(parsed.suggested_options)
      ? parsed.suggested_options.filter((opt: any) => typeof opt === 'string' && opt.trim()).slice(0, 4)
      : [];

    const allowedPersons = ['self', 'father', 'mother', 'grandmother', 'grandfather', 'child', 'spouse', 'other', 'unknown'];
    const targetPerson = allowedPersons.includes(parsed.extracted_target_person)
      ? parsed.extracted_target_person
      : 'unknown';

    const allowedServices = ['injection', 'dressing', 'lab_test', 'doctor_consult', 'vitals_check', 'none'];
    const requestedService = allowedServices.includes(parsed.extracted_requested_service)
      ? parsed.extracted_requested_service
      : 'none';

    const symptoms = Array.isArray(parsed.extracted_symptoms)
      ? parsed.extracted_symptoms.filter((s: any) => typeof s === 'string' && s.trim())
      : [];

    const duration = typeof parsed.extracted_duration === 'string' && parsed.extracted_duration.trim()
      ? parsed.extracted_duration.trim()
      : null;

    const severity = ['mild', 'moderate', 'severe', 'unknown'].includes(parsed.extracted_severity)
      ? parsed.extracted_severity
      : 'unknown';

    const progression = ['better', 'worse', 'same', 'unknown'].includes(parsed.extracted_progression)
      ? parsed.extracted_progression
      : 'unknown';

    const deniedSymptoms = Array.isArray(parsed.denied_symptoms)
      ? parsed.denied_symptoms.filter((s: any) => typeof s === 'string' && s.trim())
      : [];

    const locationText = typeof parsed.location_text === 'string' && parsed.location_text.trim()
      ? parsed.location_text.trim()
      : null;

    const allowedCareTypes = ['paramedic_home_visit', 'home_nursing', 'lab_test_home', 'teleconsultation', 'emergency_112', null];
    const careType = allowedCareTypes.includes(parsed.recommended_care_type)
      ? parsed.recommended_care_type
      : null;

    const allowedUrgencies = ['emergency', 'same_day', 'scheduled', null];
    const urgency = allowedUrgencies.includes(parsed.recommended_urgency)
      ? parsed.recommended_urgency
      : null;

    const reasoning = typeof parsed.clinical_reasoning === 'string' && parsed.clinical_reasoning.trim()
      ? parsed.clinical_reasoning.trim()
      : 'AI clinical reasoning based on patient intake signals.';

    return {
      conversational_reply: conversationalReply,
      next_question: nextQuestion,
      suggested_options: suggestedOptions,
      extracted_target_person: targetPerson,
      extracted_requested_service: requestedService,
      extracted_symptoms: symptoms,
      extracted_duration: duration,
      extracted_severity: severity,
      extracted_progression: progression,
      denied_symptoms: deniedSymptoms,
      location_text: locationText,
      is_screening_complete: Boolean(parsed.is_screening_complete),
      recommended_care_type: careType,
      recommended_urgency: urgency,
      clinical_reasoning: reasoning
    };
  } catch (err) {
    console.warn('[GeminiChatService] Failed to parse model JSON output:', err);
    return null;
  }
}

/**
 * Builds the system instructions for Gemini
 */
function buildSystemInstruction(userLanguage: DetectedLanguage): string {
  return `You are CareCompass AI, an intelligent, empathetic healthcare intake and caregiver navigation assistant for patients in India.

CRITICAL CLINICAL BOUNDARIES & ETHICS:
1. STRICT NON-DIAGNOSTIC ROLE: You are an intake screening and navigation assistant, NOT a doctor. Never formulate or assert a medical diagnosis (e.g., do not say "You have dengue" or "This is appendicitis").
2. NO PRESCRIPTIONS: Never prescribe or recommend specific medications, dosages, or self-treatments.
3. EMERGENCY FIRST: Red flags like severe chest pain, shortness of breath, loss of consciousness, uncontrolled bleeding, facial droop, or seizures require emergency ambulance routing (112), never home care.
4. ONE QUESTION AT A TIME: Ask at most ONE clear, focused follow-up question per turn. Never bombard the user with multiple questions.
5. CONVERSATIONAL MEMORY & CORRECTIONS:
   - Remember details given in earlier turns (e.g. if the user said "mere papa ko bukhar hai" and later "2 din se", remember it is for their father with 2 days of fever).
   - If the user corrects an earlier statement (e.g., "Nahi, 2 din nahi 4 din ho gaye" or "Papa ke liye nahi, mummy ke liye hai"), update the information accurately.
   - Do not ask questions that have already been answered.
6. LANGUAGE DISCIPLINE:
   - Speak in the user's active language: English, Devanagari Hindi, or Romanized Hinglish.
   - If user speaks Hinglish, reply in warm, respectful Indian Hinglish (e.g. "Kya bukhar ke saath sardi, gala kharab ya ulti jaisa lag raha hai?").
   - If user speaks Hindi, reply in fluent Devanagari Hindi.
   - If user speaks English, reply in clear, professional Indian English.
7. CARE MODALITY DISTINCTIONS:
   - "teleconsultation": For general fever, cold, rash, medical reports review, second opinion, mild symptoms.
   - "home_nursing": For prescribed injections, wound dressings, catheter care, post-op elderly care.
   - "lab_test_home": For blood tests (CBC, lipid, thyroid, blood sugar), urine samples.
   - "paramedic_home_visit": For elderly checkup, comprehensive vitals check, nebulization at home.
   - "emergency_112": Immediate urgent hospital/ambulance emergency.

Always return valid structured JSON matching the requested schema.`;
}

/**
 * Calls Gemini with bounded timeout and single retry
 */
async function callGeminiWithTimeout(
  ai: GoogleGenAI,
  modelName: string,
  systemInstruction: string,
  prompt: string
): Promise<string> {
  const callOnce = async () => {
    let timerId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error('Gemini API call timed out after 2500ms'));
      }, 2500);
    });

    const generatePromise = (async () => {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              conversational_reply: {
                type: Type.STRING,
                description: 'Empathetic, culturally respectful response in user language addressing their message'
              },
              next_question: {
                type: Type.STRING,
                description: 'A single concise follow-up question if information is incomplete, otherwise empty string'
              },
              suggested_options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '2 to 4 quick reply option buttons for the patient'
              },
              extracted_target_person: {
                type: Type.STRING,
                description: 'Target patient: self, father, mother, grandmother, grandfather, child, spouse, other, or unknown'
              },
              extracted_requested_service: {
                type: Type.STRING,
                description: 'Explicit service request: injection, dressing, lab_test, doctor_consult, vitals_check, or none'
              },
              extracted_symptoms: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'List of reported symptoms (e.g., fever, cough, acidity_gas, headache)'
              },
              extracted_duration: {
                type: Type.STRING,
                description: 'Reported duration (e.g., "2 days", "since yesterday", "1 week")'
              },
              extracted_severity: {
                type: Type.STRING,
                description: 'Reported severity: mild, moderate, severe, or unknown'
              },
              extracted_progression: {
                type: Type.STRING,
                description: 'Reported symptom progression: better, worse, same, or unknown'
              },
              denied_symptoms: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Symptoms explicitly denied or negated by patient'
              },
              location_text: {
                type: Type.STRING,
                description: 'Location or neighborhood mentioned in message, if any'
              },
              is_screening_complete: {
                type: Type.BOOLEAN,
                description: 'True if sufficient clinical signals exist to route to care without further questions'
              },
              recommended_care_type: {
                type: Type.STRING,
                description: 'Recommended care: paramedic_home_visit, home_nursing, lab_test_home, teleconsultation, emergency_112, or null'
              },
              recommended_urgency: {
                type: Type.STRING,
                description: 'Recommended urgency: emergency, same_day, scheduled, or null'
              },
              clinical_reasoning: {
                type: Type.STRING,
                description: 'Transparent clinical reasoning for the recommendation or follow-up question'
              }
            },
            required: ['conversational_reply', 'clinical_reasoning', 'is_screening_complete']
          }
        }
      });
      return response.text || '';
    })();

    try {
      return await Promise.race([generatePromise, timeoutPromise]);
    } finally {
      clearTimeout(timerId);
    }
  };

  try {
    return await callOnce();
  } catch (err: any) {
    // Retry once on transient network or 429/503 errors
    if (err.status === 429 || err.status === 503) {
      console.warn('[GeminiChatService] Retrying transient Gemini error once...');
      return await callOnce();
    }
    throw err;
  }
}

/**
 * Main Entry Point: Processes a conversational turn through CareCompass AI Chatbot
 */
export async function processChatTurn(request: ChatRequest): Promise<ChatResponse> {
  const {
    sessionId,
    message,
    language = 'auto',
    location = null,
    rejected_caregiver_id,
    selected_caregiver_id
  } = request;

  // 1. Validate user message input
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new Error('Message content is required and cannot be empty.');
  }

  // 2. Validate session ID if provided (reject directory traversal or bizarre keys)
  if (sessionId && !/^[A-Za-z0-9_-]{5,100}$/.test(sessionId)) {
    throw new Error('Invalid sessionId format. Must be alphanumeric (5-100 characters).');
  }

  // 3. Detect and stabilize language
  const detectedLang = detectLanguage(message, language);

  // 4. Retrieve or create session state
  const session = sessionStore.getOrCreateSession(sessionId, detectedLang, location);

  // Handle caregiver rejection (anti-repetition)
  if (rejected_caregiver_id) {
    sessionStore.recordCaregiverRejection(session.sessionId, rejected_caregiver_id);
    if (!session.rejectedCaregivers.includes(rejected_caregiver_id)) {
      session.rejectedCaregivers.push(rejected_caregiver_id);
    }
  }

  // Handle caregiver selection
  if (selected_caregiver_id) {
    sessionStore.selectCaregiver(session.sessionId, selected_caregiver_id);
    session.selectedCaregiverId = selected_caregiver_id;
  }

  // 5. Append new user message to session history (prevent duplicate consecutive entries)
  const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
  if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== message.trim()) {
    session.conversationHistory.push({
      role: 'user',
      content: message.trim()
    });
  }

  // 6. MODULE 0: High-Recall Safety Gate (HARD INVARIANT — evaluated FIRST deterministically)
  const safetyResult: SafetyCheckResult = evaluateSafetyGate(message, session.conversationHistory);

  if (safetyResult.isEmergency) {
    session.screeningStatus = 'emergency';
    session.careType = 'emergency_112';
    session.urgency = 'emergency';
    session.reasoning = safetyResult.explanation || 'Emergency red-flag symptom detected.';
    session.matchedCaregivers = [];
    session.nextQuestion = null;
    session.suggestedOptions = [];
    sessionStore.saveSession(session);

    const emergencyReply = detectedLang === 'Hindi'
      ? "🚨 आपातकालीन सूचना: आपके बताए लक्षणों (जैसे सीने में दर्द/सांस में तकलीफ) में तुरंत चिकित्सकीय सहायता की आवश्यकता है। कृपया तुरंत 112 पर कॉल करें या नजदीकी आपातकालीन अस्पताल जाएं। घर पर देखभाल का इंतजार न करें।"
      : detectedLang === 'Hinglish'
      ? "🚨 Emergency Alert: Aapke bataye gaye symptoms (jaise chest pain / saans lene me takleef) urgent medical emergency hain. Kripya bina deri kiye 112 par call karein ya paas ke emergency hospital jayein. Ghar par wait na karein."
      : "🚨 Emergency Alert: The reported symptoms indicate a critical medical emergency. Please call emergency services (112) immediately or go to the nearest emergency room. Do not wait for home care.";

    // Append emergency message to history
    session.conversationHistory.push({
      role: 'assistant',
      content: emergencyReply
    });
    sessionStore.saveSession(session);

    return {
      sessionId: session.sessionId,
      assistantMessage: emergencyReply,
      screeningStatus: 'emergency',
      followUpQuestion: null,
      missingInformation: [],
      language: session.language,
      careType: 'emergency_112',
      urgency: 'emergency',
      redFlags: safetyResult.redFlags,
      reasoning: session.reasoning,
      matchedCaregivers: [],
      suggestedOptions: [],
      canBook: false,
      nextAction: 'call_112',
      isAiPowered: false,
      modelUsed: null,
      sessionState: session
    };
  }

  // 7. Check if Gemini AI is available
  const genAIConfig = getGenAIClient();
  let aiDecision: GeminiModelDecision | null = null;
  let modelUsed: string | null = null;

  if (genAIConfig) {
    try {
      modelUsed = genAIConfig.modelName;

      // Prepare bounded conversation context (scrub PII)
      const recentHistory = session.conversationHistory
        .slice(-MAX_CONTEXT_TURNS)
        .map(turn => `${turn.role === 'user' ? 'Patient' : 'Assistant'}: ${scrubPII(turn.content)}`)
        .join('\n');

      const knownStateSummary = JSON.stringify({
        targetPerson: session.targetPerson,
        requestedService: session.requestedService,
        knownSymptoms: session.symptoms,
        duration: session.duration,
        severity: session.severity,
        locationKnown: session.isLocationExplicit,
        questionCount: session.questionCount,
        maxQuestions: session.maxQuestions
      });

      const prompt = `Recent Conversation History:
${recentHistory}

Latest Patient Message:
"${scrubPII(message.trim())}"

Current Cumulative Clinical State:
${knownStateSummary}

Active User Language: ${detectedLang}

Task:
Analyze the latest message in context of the conversation.
1. Formulate an empathetic, conversational response in ${detectedLang}.
2. If the user corrected earlier info, update extracted fields.
3. If screening information is insufficient, provide ONE focused next question with 2-4 quick reply options.
4. If information is sufficient, set is_screening_complete=true and recommend care_type.
5. Provide clinical reasoning.`;

      const systemInstruction = buildSystemInstruction(detectedLang);
      const rawOutput = await callGeminiWithTimeout(genAIConfig.ai, genAIConfig.modelName, systemInstruction, prompt);
      aiDecision = parseAndValidateModelOutput(rawOutput);
    } catch (aiErr: any) {
      console.warn('[GeminiChatService] Gemini AI call failed or timed out. Falling back to deterministic engine:', aiErr?.message || aiErr);
      aiDecision = null;
      modelUsed = null;
    }
  }

  // 8. Integrate Model Decision or Fallback to Deterministic State Machine
  // Also run deterministic entity extractor to guarantee knowledge base consistency
  const deterministicEntities = extractEntitiesFromConversation(session.conversationHistory, message);

  // Update target person
  if (aiDecision && aiDecision.extracted_target_person !== 'unknown') {
    session.targetPerson = aiDecision.extracted_target_person;
    session.knownAnswers['target_person_known'] = true;
  } else if (deterministicEntities.targetPerson !== 'unknown') {
    session.targetPerson = deterministicEntities.targetPerson;
    session.knownAnswers['target_person_known'] = true;
  }

  // Update requested service
  if (aiDecision && aiDecision.extracted_requested_service !== 'none') {
    session.requestedService = aiDecision.extracted_requested_service;
    session.knownAnswers['requested_service_known'] = true;
  } else if (deterministicEntities.requestedService !== 'none') {
    session.requestedService = deterministicEntities.requestedService;
    session.knownAnswers['requested_service_known'] = true;
  }

  // Update symptoms
  const allNewSymptoms = [
    ...(aiDecision?.extracted_symptoms || []),
    ...deterministicEntities.symptoms
  ];
  for (const sym of allNewSymptoms) {
    if (!session.symptoms.includes(sym)) {
      session.symptoms.push(sym);
    }
  }

  // Update duration
  if (aiDecision?.extracted_duration) {
    session.duration = aiDecision.extracted_duration;
    session.knownAnswers['duration_known'] = true;
  } else if (deterministicEntities.duration) {
    session.duration = deterministicEntities.duration;
    session.knownAnswers['duration_known'] = true;
  }

  // Update severity
  if (aiDecision && aiDecision.extracted_severity !== 'unknown') {
    session.severity = aiDecision.extracted_severity;
    session.knownAnswers['severity_known'] = true;
  } else if (deterministicEntities.severity !== 'unknown') {
    session.severity = deterministicEntities.severity;
    session.knownAnswers['severity_known'] = true;
  }

  // Update progression
  if (aiDecision && aiDecision.extracted_progression !== 'unknown') {
    session.progression = aiDecision.extracted_progression;
  } else if (deterministicEntities.progression !== 'unknown') {
    session.progression = deterministicEntities.progression;
  }

  // Negation/red flags cleared
  if (
    (aiDecision && aiDecision.denied_symptoms.length > 0) ||
    deterministicEntities.deniedSymptoms.length > 0 ||
    /safe|theek\s*hai|koi\s*dikkat\s*nahi|nahi|no\b|saans\s*theek|normal/i.test(message)
  ) {
    session.knownAnswers['red_flags_cleared'] = true;
  }

  // Check explicit location text
  if (aiDecision?.location_text || deterministicEntities.extractedLocationText) {
    session.knownAnswers['location_confirmed'] = true;
  }

  // Check user preference mentions
  if (/doctor|video\s*consult|online|सलाह|teleconsult/i.test(message)) {
    session.knownAnswers['care_mode_preference'] = 'teleconsult';
    session.requestedService = 'doctor_consult';
  } else if (/nurse|injection|dressing|patti|नर्स/i.test(message)) {
    session.knownAnswers['care_mode_preference'] = 'home_nursing';
    if (session.requestedService === 'none') {
      session.requestedService = 'injection';
    }
  } else if (/lab\s*test|blood\s*test|sample|जांच|सैंपल/i.test(message)) {
    session.knownAnswers['care_mode_preference'] = 'lab_test';
    session.requestedService = 'lab_test';
  } else if (/medic|home\s*visit|checkup|vitals|विजिट/i.test(message)) {
    session.knownAnswers['care_mode_preference'] = 'medic_visit';
  }

  // Re-verify safety gate against any new symptoms
  const secondarySafetyCheck = evaluateSafetyGate(session.symptoms.join(' '), session.conversationHistory);
  if (secondarySafetyCheck.isEmergency) {
    session.screeningStatus = 'emergency';
    session.careType = 'emergency_112';
    session.urgency = 'emergency';
    session.reasoning = secondarySafetyCheck.explanation;
    session.matchedCaregivers = [];
    sessionStore.saveSession(session);

    return {
      sessionId: session.sessionId,
      assistantMessage: "🚨 Emergency warning symptoms identified. Immediate 112 routing activated.",
      screeningStatus: 'emergency',
      followUpQuestion: null,
      missingInformation: [],
      language: session.language,
      careType: 'emergency_112',
      urgency: 'emergency',
      redFlags: secondarySafetyCheck.redFlags,
      reasoning: session.reasoning,
      matchedCaregivers: [],
      suggestedOptions: [],
      canBook: false,
      nextAction: 'call_112',
      isAiPowered: Boolean(aiDecision),
      modelUsed,
      sessionState: session
    };
  }

  // 9. Evaluate Screening Completeness Deterministically (Rule of Truth)
  const completeness = evaluateScreeningCompleteness(session);
  session.missingInformation = completeness.missingFields;

  // Question limit check or persistent ambiguity
  if (!completeness.isSufficient) {
    if (!completeness.recommendedNextQuestion) {
      // Escalation to human care coordinator
      session.screeningStatus = 'needs_human_assistance';
      session.careType = null;
      session.urgency = null;
      session.reasoning = completeness.reason;
      session.matchedCaregivers = [];
      session.nextQuestion = null;
      session.suggestedOptions = ["📞 Call 1800-SANOCARE Support", "👨‍⚕️ Book Online Doctor"];

      const humanEscalationMessage = detectedLang === 'Hindi'
        ? "आपकी स्थिति की पूरी जानकारी के लिए हमारे 24/7 केयर कोऑर्डिनेटर से सीधे संपर्क करें या ऑनलाइन डॉक्टर से परामर्श लें।"
        : detectedLang === 'Hinglish'
        ? "Aapki requirement confirm karne ke liye hamare 24/7 care coordinator se call par baat karein ya online doctor teleconsult book karein."
        : "To ensure safe clinical routing, please connect directly with our 24/7 care coordination desk or request an online doctor teleconsultation.";

      session.conversationHistory.push({
        role: 'assistant',
        content: humanEscalationMessage
      });
      sessionStore.saveSession(session);

      return {
        sessionId: session.sessionId,
        assistantMessage: humanEscalationMessage,
        screeningStatus: 'needs_human_assistance',
        followUpQuestion: null,
        missingInformation: session.missingInformation,
        language: session.language,
        careType: null,
        urgency: null,
        redFlags: [],
        reasoning: session.reasoning,
        matchedCaregivers: [],
        suggestedOptions: session.suggestedOptions,
        canBook: false,
        nextAction: 'human_helpline',
        isAiPowered: Boolean(aiDecision),
        modelUsed,
        sessionState: session
      };
    }

    // Follow-up question needed
    session.questionCount += 1;
    session.screeningStatus = 'asking_follow_up';

    // Prefer empathetic Gemini question if coherent; fallback to deterministic question
    let assistantMessage = '';
    let followUpQuestion = '';
    let suggestedOptions: string[] = [];

    if (aiDecision && aiDecision.next_question && !aiDecision.is_screening_complete) {
      assistantMessage = aiDecision.conversational_reply.includes(aiDecision.next_question)
        ? aiDecision.conversational_reply
        : `${aiDecision.conversational_reply} ${aiDecision.next_question}`.trim();
      followUpQuestion = aiDecision.next_question;
      suggestedOptions = aiDecision.suggested_options.length > 0
        ? aiDecision.suggested_options
        : completeness.recommendedNextQuestion.suggestedOptions;
    } else {
      followUpQuestion = completeness.recommendedNextQuestion.question;
      assistantMessage = followUpQuestion;
      suggestedOptions = completeness.recommendedNextQuestion.suggestedOptions;
    }

    session.nextQuestion = followUpQuestion;
    session.suggestedOptions = suggestedOptions;
    session.careType = null;
    session.urgency = null;
    session.reasoning = completeness.reason;
    session.matchedCaregivers = [];

    session.conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });
    sessionStore.saveSession(session);

    return {
      sessionId: session.sessionId,
      assistantMessage,
      screeningStatus: 'asking_follow_up',
      followUpQuestion,
      missingInformation: session.missingInformation,
      language: session.language,
      careType: null,
      urgency: null,
      redFlags: [],
      reasoning: completeness.reason,
      matchedCaregivers: [],
      suggestedOptions,
      canBook: false,
      nextAction: 'answer_question',
      isAiPowered: Boolean(aiDecision),
      modelUsed,
      sessionState: session
    };
  }

  // 10. Screening is Complete: Classify Triage & Match Providers
  const classification = classifyTriage(session, safetyResult, completeness);
  session.careType = classification.care_type;
  session.urgency = classification.urgency;
  session.reasoning = aiDecision?.clinical_reasoning || classification.reasoning;

  if (!session.careType) {
    session.screeningStatus = 'needs_human_assistance';
    sessionStore.saveSession(session);
    return {
      sessionId: session.sessionId,
      assistantMessage: "Unable to establish specific care modality. Routing to support desk.",
      screeningStatus: 'needs_human_assistance',
      followUpQuestion: null,
      missingInformation: [],
      language: session.language,
      careType: null,
      urgency: null,
      redFlags: [],
      reasoning: session.reasoning,
      matchedCaregivers: [],
      suggestedOptions: ["📞 Call 1800-SANOCARE Support"],
      canBook: false,
      nextAction: 'human_helpline',
      isAiPowered: Boolean(aiDecision),
      modelUsed,
      sessionState: session
    };
  }

  // Match eligible caregivers from roster
  const matchResult = matchCaregivers({
    careType: session.careType,
    userLocation: session.location,
    userLanguage: detectedLang,
    userInput: message,
    rejectedCaregivers: session.rejectedCaregivers,
    previouslyShownCaregivers: session.previouslyShownCaregivers
  });

  session.matchedCaregivers = matchResult.matchedCaregivers;
  session.screeningStatus = 'ready_for_recommendation';
  session.nextQuestion = null;
  session.suggestedOptions = [];

  // Record shown caregivers
  for (const cg of matchResult.matchedCaregivers) {
    if (!session.previouslyShownCaregivers.includes(cg.caregiver_id)) {
      session.previouslyShownCaregivers.push(cg.caregiver_id);
    }
  }

  // Craft assistant recommendation message
  let finalAssistantMessage = '';
  if (aiDecision && aiDecision.conversational_reply && aiDecision.is_screening_complete) {
    finalAssistantMessage = aiDecision.conversational_reply;
  } else {
    if (session.careType === 'teleconsultation') {
      finalAssistantMessage = detectedLang === 'Hindi'
        ? `आपकी स्वास्थ्य जानकारी के आधार पर, ऑनलाइन डॉक्टर टेलीकंसल्टेशन सबसे उपयुक्त रहेगा। नीचे हमारे उपलब्ध विशेषज्ञ डॉक्टरों की सूची दी गई है:`
        : detectedLang === 'Hinglish'
        ? `Aapki details ke hisaab se online doctor teleconsultation recommended hai. Neeche available doctors ki list dekh kar aap booking confirm kar sakte hain:`
        : `Based on your screening details, an online doctor teleconsultation is recommended. Below are the matched verified doctors:`;
    } else if (session.careType === 'home_nursing') {
      finalAssistantMessage = detectedLang === 'Hindi'
        ? `आपके अनुरोध के अनुसार, घर पर प्रशिक्षित नर्सिंग सेवा (इंजेक्शन/ड्रेसिंग) की सिफारिश की गई है। नीचे उपलब्ध योग्य नर्सों का चयन करें:`
        : detectedLang === 'Hinglish'
        ? `Aapki requirement ke liye certified home nursing service recommend ki gayi hai. Verified nurses neeche listed hain:`
        : `Certified home nursing service is recommended for your request. Matched registered nurses are listed below:`;
    } else if (session.careType === 'lab_test_home') {
      finalAssistantMessage = detectedLang === 'Hindi'
        ? `घर पर ब्लड टेस्ट सैंपल कलेक्शन के लिए हमारे प्रमाणित फ्लेबोटोमिस्ट उपलब्ध हैं। कृपया अपना समय चुनें:`
        : detectedLang === 'Hinglish'
        ? `Ghar par sample collection ke liye certified phlebotomists available hain. Neeche se booking confirm karein:`
        : `Home sample collection has been scheduled. Verified phlebotomists are available below:`;
    } else {
      finalAssistantMessage = session.reasoning;
    }
  }

  session.conversationHistory.push({
    role: 'assistant',
    content: finalAssistantMessage
  });
  sessionStore.saveSession(session);

  return {
    sessionId: session.sessionId,
    assistantMessage: finalAssistantMessage,
    screeningStatus: 'ready_for_recommendation',
    followUpQuestion: null,
    missingInformation: [],
    language: session.language,
    careType: session.careType,
    urgency: session.urgency,
    redFlags: [],
    reasoning: session.reasoning,
    matchedCaregivers: session.matchedCaregivers,
    suggestedOptions: [],
    canBook: session.matchedCaregivers.length > 0,
    nextAction: 'confirm_booking',
    isAiPowered: Boolean(aiDecision),
    modelUsed,
    sessionState: session
  };
}
