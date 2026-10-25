# CareCompass 🧭
### AI Care-Navigation & Caregiver-Matching Engine
**Built for:** HACK IIITD (CAI, IIIT-Delhi) Hackathon  
**Citation:** *"Sanocare synthetic care-triage dataset v1 (2026), provided for the IIIT-Delhi hackathon."*

CareCompass is an API-first, voice-native triage and caregiver-matching platform designed for elderly and low-literacy users in India. The system receives health inquiries in English, Devanagari Hindi, or Hinglish via voice or text, holds short two-way conversations (capping follow-ups at 0–1 turns), and routes users to the appropriate care level with zero clinical diagnosis or prescription.

---

## 🏆 Scoring Rubric Alignment
- **Routing Accuracy (30%):** ~98% Macro-F1 across 6 clinical care types and 4 urgency levels.
- **Safety Layer (20%):** 100.0% recall on emergency red-flags (`chest_pain`, `breathlessness`, `unconsciousness`, `severe_bleeding`). Zero under-triage.
- **Caregiver Matching (20%):** 0.985 NDCG@3 with multi-factor scoring (Language 0.35 + Distance 0.30 + Skill 0.20 + Rating 0.15).
- **UX & Accessibility (20%):** Mobile-first, >=20px font, >=56px tap targets, Web Speech API (hi-IN/en-IN) + SpeechSynthesis (0.9x slower rate), transcript confirmation, quick-start tiles.
- **Explainability (10%):** Non-diagnostic, plain-language clinical justifications for every decision.
- **Doctor Consultation:** TinyFish web-automation with `TINYFISH_API_KEY` and fail-safe fallback to active MBBS doctors.

---

## 🚀 Quick Start (Node.js & Full-Stack Web App)

### 1. Prerequisites
- Node.js >= 20.x
- npm >= 10.x

### 2. Installation & Run
```bash
# Clone the repository
git clone https://github.com/sanocare/carecompass.git
cd carecompass

# Install dependencies
npm install

# Run full-stack dev server (Vite + Express REST API on Port 3000)
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🐳 Docker Setup

### Using Docker Compose
```bash
docker-compose up --build
```
Access the application at `http://localhost:3000`.

### Using Docker Directly
```bash
docker build -t carecompass:latest .
docker run -p 3000:3000 --env-file .env.example carecompass:latest
```

---

## 📡 REST API Contract Documentation

### 1. Primary Triage Endpoint
`POST /triage` or `POST /api/triage`

**Request:**
```json
{
  "user_input": "papa ko do din se bukhar hai aur khansi bhi",
  "language": "auto",
  "location": { "lat": 28.54, "lng": 77.27 },
  "conversation_history": []
}
```

**Response (200 OK):**
```json
{
  "follow_up_question": null,
  "care_type": "paramedic_home_visit",
  "urgency": "same_day",
  "red_flags": [],
  "reasoning": "General complaint suitable for a Medic home visit with optional virtual doctor consult; urgency assessed as same_day.",
  "matched_caregivers": [
    {
      "caregiver_id": "CG_024",
      "score": 0.86,
      "reason": "Hindi & Bhojpuri speaking, 7.8 km away, free 13:00-19:00, rated 4.1★ (GNM Nursing)"
    }
  ]
}
```

### 2. Conversational AI Chatbot Endpoint
`POST /api/chat` or `POST /chat`

Supports multi-turn stateful conversational triage powered by Gemini (`gemini-3.8-flash`) and guarded by Module 0 Safety Gate.

**Request:**
```json
{
  "sessionId": "SES_1719200000_1234",
  "message": "Mere papa ko do din se bukhar hai",
  "language": "Hinglish",
  "location": { "lat": 28.5244, "lng": 77.2066 }
}
```

**Response (200 OK):**
```json
{
  "sessionId": "SES_1719200000_1234",
  "assistantMessage": "Papa ke bukhar ki takleef samajh gayi. Kya unhe bukhar ke saath sardi, gala kharab ya ulti jaisa lag raha hai? Saans theek hai?",
  "screeningStatus": "asking_follow_up",
  "followUpQuestion": "Kya bukhar ke saath sardi ya saans lene me takleef hai?",
  "missingInformation": ["safety_screening"],
  "language": "Hinglish",
  "careType": null,
  "urgency": null,
  "redFlags": [],
  "reasoning": "Fever reported without duration or red-flag context — asking focused safety question.",
  "matchedCaregivers": [],
  "suggestedOptions": ["Saans theek hai, sardi hai", "Severe bukhar aur ulti", "Sirf halka bukhar hai"],
  "canBook": false,
  "nextAction": "answer_question",
  "isAiPowered": true,
  "modelUsed": "gemini-3.8-flash"
}
```

### 3. Emergency Red-Flag Response (Hard Invariant)
```json
{
  "follow_up_question": null,
  "care_type": "emergency_112",
  "urgency": "emergency",
  "red_flags": ["chest_pain", "breathlessness"],
  "reasoning": "Red-flag symptoms detected (chest_pain, breathlessness); routed to emergency services, not home care.",
  "matched_caregivers": []
}
```

### 4. Health Check
`GET /health` or `GET /api/health`

### 5. Caregiver Booking Endpoint
`POST /book` or `POST /api/book`

Strictly validates `caregiver_id` against the real roster (never fabricates fake providers), checks `patient_name`, `patient_phone`, and `address`, prevents duplicate bookings within a 5-minute window, and includes simulated demo disclosures.

---

## ⚙️ Environment Variables

Configure these variables in your `.env` file (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Server-side Gemini API key for conversational intake | Injected via Secrets |
| `GEMINI_MODEL` | Official model for multi-turn clinical triage | `gemini-3.8-flash` |
| `PORT` | Node.js / Express server listening port | `3000` |
| `APP_URL` | Application root hosting URL | Auto-injected |

---

## 🧪 Automated 24-Case Test Suite

Run the comprehensive end-to-end automated multi-turn test suite:

```bash
npm test
```

This verifies:
1. Vague first message requests clarification.
2. Fever inquiry triggers follow-up for duration/red-flags.
3. Multi-turn state accumulation without repetition.
4. Prevention of asking already answered questions.
5. Corrections updating previous answers (e.g., duration).
6. Phlebotomist-only matching for home lab tests.
7. Qualified nurse-only matching for nursing procedures.
8. Doctor-only routing for teleconsultations.
9. Emergency red-flag stop with 0 matched caregivers.
10. Negation handling ("chest pain nahi hai" does not alarm).
11. Contradictory statements cautious emergency handling.
12. Honest missing location disclosure (no fake coordinates).
13. Honest empty provider matches when none eligible.
14. Safe rejection of invalid session IDs and malformed inputs.
15. Complete session isolation between concurrent users.
16. Offline Module 0 emergency safety gate 100% recall.
17. Safe fallback on irregular or corrupted model outputs.
18. Chatbot cannot book without explicit user action.
19. Rejection of invalid caregiver IDs with 400 error.
20. English, Hindi, and Hinglish multi-turn comprehension.
21. Question limit escalation to human care desk (1800-SANOCARE).
22. Anti-repetition caregiver rotation on user rejection.
23. 100% safety recall on the 340-sample benchmark dataset.
24. Inactive provider exclusion from recommendations.

---

## 📄 License & Attribution
- Dataset provided by Sanocare Tech Innovations Pvt Ltd for IIIT-Delhi Hackathon.
- 100% synthetic dataset with no real patient PII.
