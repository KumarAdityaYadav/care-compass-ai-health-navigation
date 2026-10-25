/**
 * CareCompass Frontend Chat Client
 *
 * Communicates with the Express backend conversational endpoint /api/chat.
 * Resilient to offline or static hosting environments with seamless browser-native fallback.
 */

import { ChatRequest, ChatResponse } from '../types/chat.ts';
import { runSessionScreening } from './screeningStateMachine.ts';
import { sessionStore } from './sessionStore.ts';

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  const isStaticHost =
    typeof window !== 'undefined' &&
    (window.location.hostname.includes('github.io') ||
      window.location.protocol === 'file:');

  // Static host fallback
  if (isStaticHost) {
    const localResult = runSessionScreening({
      sessionId: request.sessionId,
      user_input: request.message,
      language: request.language as any,
      location: request.location,
      rejected_caregiver_id: request.rejected_caregiver_id,
      selected_caregiver_id: request.selected_caregiver_id
    });

    return {
      sessionId: localResult.sessionId,
      assistantMessage: localResult.assistantMessage,
      screeningStatus: localResult.screeningStatus,
      followUpQuestion: localResult.follow_up_question,
      missingInformation: localResult.missingInformation,
      language: localResult.sessionState?.language || 'Hinglish',
      careType: localResult.care_type,
      urgency: localResult.urgency,
      redFlags: localResult.red_flags,
      reasoning: localResult.reasoning,
      matchedCaregivers: localResult.matched_caregivers,
      suggestedOptions: localResult.suggested_options,
      canBook: localResult.canBook,
      nextAction: localResult.nextAction,
      isAiPowered: false,
      modelUsed: null,
      sessionState: localResult.sessionState
    };
  }

  // Attempt backend /api/chat
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      return await res.json();
    } else {
      console.warn(`[chatClient] Server returned status ${res.status}. Falling back to browser-native engine.`);
    }
  } catch (err: any) {
    console.warn('[chatClient] Network or timeout error reaching /api/chat. Falling back to local state machine:', err?.message || err);
  }

  // Fallback to local deterministic execution
  const localResult = runSessionScreening({
    sessionId: request.sessionId,
    user_input: request.message,
    language: request.language as any,
    location: request.location,
    rejected_caregiver_id: request.rejected_caregiver_id,
    selected_caregiver_id: request.selected_caregiver_id
  });

  return {
    sessionId: localResult.sessionId,
    assistantMessage: localResult.assistantMessage,
    screeningStatus: localResult.screeningStatus,
    followUpQuestion: localResult.follow_up_question,
    missingInformation: localResult.missingInformation,
    language: localResult.sessionState?.language || 'Hinglish',
    careType: localResult.care_type,
    urgency: localResult.urgency,
    redFlags: localResult.red_flags,
    reasoning: localResult.reasoning,
    matchedCaregivers: localResult.matched_caregivers,
    suggestedOptions: localResult.suggested_options,
    canBook: localResult.canBook,
    nextAction: localResult.nextAction,
    isAiPowered: false,
    modelUsed: null,
    sessionState: localResult.sessionState
  };
}

export async function resetChatSession(sessionId?: string): Promise<void> {
  try {
    await fetch('/api/chat/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
  } catch {
    // Expected on static hosting; ignore
  }

  if (sessionId) {
    sessionStore.clearSession(sessionId);
  }
}
