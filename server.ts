/**
 * CareCompass Production Full-Stack Server
 * Hackathon: HACK IIITD (CAI, IIIT-Delhi)
 *
 * Implements strict REST API Contract:
 * - POST /triage
 * - GET  /health
 * - POST /batch_predict
 * - POST /book
 * - POST /teleconsult
 * - GET  /api/benchmark
 *
 * Integrates Vite middleware in development mode and static production serving.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { runFullTriage, evaluateDataset, generatePredictionsCsv } from './src/services/benchmarkService.ts';
import { runSessionScreening } from './src/services/screeningStateMachine.ts';
import { sessionStore } from './src/services/sessionStore.ts';
import { fetchDoctorConsultSlot } from './src/services/tinyfishConsult.ts';
import { CAREGIVERS } from './src/data/caregivers.ts';
import { TRAINING_DATASET, parseTrainingDataset } from './src/data/trainingData.ts';
import { BookingConfirmation } from './src/types/triage.ts';
import fs from 'node:fs';
import { processChatTurn } from './src/services/geminiChatService.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// In-memory bookings store
const BOOKINGS: Record<string, BookingConfirmation> = {};

// ==========================================
// API CONTRACT ROUTES (Root and /api/ prefixed)
// ==========================================

// GET /health
const handleHealth = (req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    system: 'CareCompass AI Care-Navigation & Matching Engine',
    version: '1.0.0',
    hackathon: 'HACK IIITD (CAI, IIIT-Delhi)',
    caregivers_loaded: CAREGIVERS.length,
    training_samples: TRAINING_DATASET.length,
    active_sessions: sessionStore.getActiveSessionCount(),
    timestamp: new Date().toISOString()
  });
};
app.get('/health', handleHealth);
app.get('/api/health', handleHealth);

// GET /caregivers
const handleGetCaregivers = (req: express.Request, res: express.Response) => {
  const { role, active_only = 'true' } = req.query;
  let list = CAREGIVERS;
  if (active_only === 'true') {
    list = list.filter(c => c.active);
  }
  if (role && typeof role === 'string') {
    list = list.filter(c => c.role === role);
  }
  res.json({
    total: list.length,
    caregivers: list
  });
};
app.get('/caregivers', handleGetCaregivers);
app.get('/api/caregivers', handleGetCaregivers);

// ==========================================
// CONVERSATIONAL AI CHATBOT ROUTES
// ==========================================

// POST /chat & POST /api/chat
const handleChat = async (req: express.Request, res: express.Response) => {
  try {
    const { sessionId, message, user_input, language = 'auto', location, rejected_caregiver_id, selected_caregiver_id } = req.body || {};
    const inputMessage = message || user_input;

    if (!inputMessage || typeof inputMessage !== 'string' || !inputMessage.trim()) {
      res.status(400).json({ error: 'Missing required field: message' });
      return;
    }

    if (sessionId && !/^[A-Za-z0-9_-]{5,100}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId format. Must be alphanumeric (5-100 characters).' });
      return;
    }

    const chatResponse = await processChatTurn({
      sessionId,
      message: inputMessage.trim(),
      language,
      location,
      rejected_caregiver_id,
      selected_caregiver_id
    });

    res.json(chatResponse);
  } catch (err: any) {
    console.error('Error in /api/chat:', err);
    res.status(500).json({
      error: 'Conversational AI Chatbot processing error',
      details: err?.message
    });
  }
};
app.post('/chat', handleChat);
app.post('/api/chat', handleChat);

// POST /chat/reset & POST /api/chat/reset
const handleChatReset = (req: express.Request, res: express.Response) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    sessionStore.clearSession(sessionId);
  }
  res.json({ success: true, message: `Session ${sessionId || 'all'} reset successfully.` });
};
app.post('/chat/reset', handleChatReset);
app.post('/api/chat/reset', handleChatReset);

// GET /chat/session/:sessionId & GET /api/chat/session/:sessionId
const handleGetChatSession = (req: express.Request, res: express.Response) => {
  const { sessionId } = req.params;
  if (!sessionId || !/^[A-Za-z0-9_-]{5,100}$/.test(sessionId)) {
    res.status(400).json({ error: 'Invalid sessionId format.' });
    return;
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found or expired.' });
    return;
  }
  res.json({ success: true, session });
};
app.get('/chat/session/:sessionId', handleGetChatSession);
app.get('/api/chat/session/:sessionId', handleGetChatSession);

// POST /triage/session (Session-Aware Multi-Turn Screening Endpoint)
const handleSessionTriage = (req: express.Request, res: express.Response) => {
  try {
    const {
      sessionId,
      user_input,
      language = 'auto',
      location,
      rejected_caregiver_id,
      selected_caregiver_id,
      conversation_history = []
    } = req.body || {};

    if (!user_input || typeof user_input !== 'string' || !user_input.trim()) {
      res.status(400).json({ error: 'Missing required field: user_input' });
      return;
    }

    const sessionResponse = runSessionScreening({
      sessionId,
      user_input: user_input.trim(),
      language,
      location,
      rejected_caregiver_id,
      selected_caregiver_id,
      conversation_history
    });

    res.json(sessionResponse);
  } catch (err: any) {
    console.error('Error in /triage/session:', err);
    res.status(500).json({
      error: 'Session screening processing error',
      details: err?.message
    });
  }
};
app.post('/triage/session', handleSessionTriage);
app.post('/api/triage/session', handleSessionTriage);

// POST /triage/session/reset
const handleSessionReset = (req: express.Request, res: express.Response) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    sessionStore.clearSession(sessionId);
  }
  res.json({ success: true, message: `Session ${sessionId || 'all'} reset` });
};
app.post('/triage/session/reset', handleSessionReset);
app.post('/api/triage/session/reset', handleSessionReset);

// POST /triage (Stateless Backward-Compatible Endpoint)
const handleTriage = (req: express.Request, res: express.Response) => {
  try {
    const { user_input, language = 'auto', location, conversation_history = [] } = req.body || {};

    if (!user_input || typeof user_input !== 'string' || !user_input.trim()) {
      res.status(400).json({ error: 'Missing required field: user_input' });
      return;
    }

    const triageResult = runFullTriage(
      user_input.trim(),
      language,
      location,
      conversation_history,
      false // live multi-turn adaptive evaluation
    );

    // Exact schema response contract
    res.json({
      follow_up_question: triageResult.follow_up_question,
      care_type: triageResult.care_type,
      urgency: triageResult.urgency,
      red_flags: triageResult.red_flags,
      reasoning: triageResult.reasoning,
      matched_caregivers: triageResult.matched_caregivers,
      detected_language: triageResult.detected_language,
      confidence: triageResult.confidence,
      suggested_options: triageResult.suggested_options
    });
  } catch (err: any) {
    console.error('Error in /triage:', err);
    res.status(500).json({
      follow_up_question: null,
      care_type: null,
      urgency: null,
      red_flags: [],
      reasoning: 'An unexpected processing error occurred.',
      matched_caregivers: []
    });
  }
};
app.post('/triage', handleTriage);
app.post('/api/triage', handleTriage);

// POST /teleconsult
const handleTeleconsult = async (req: express.Request, res: express.Response) => {
  try {
    const slots = await fetchDoctorConsultSlot(req.body || {});
    res.json({
      success: true,
      slots
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
app.post('/teleconsult', handleTeleconsult);
app.post('/api/teleconsult', handleTeleconsult);

// POST /book
const handleBook = (req: express.Request, res: express.Response) => {
  try {
    const {
      caregiver_id,
      care_type = 'home_nursing',
      patient_name,
      patient_phone,
      address,
      preferred_slot = 'Today, earliest slot',
      notes = ''
    } = req.body || {};

    // 1. Strict validation of required fields
    if (!caregiver_id || typeof caregiver_id !== 'string' || !caregiver_id.trim()) {
      res.status(400).json({ error: 'Missing required field: caregiver_id is required.' });
      return;
    }

    if (!patient_name || typeof patient_name !== 'string' || patient_name.trim().length < 2) {
      res.status(400).json({ error: 'Missing or invalid field: patient_name must be at least 2 characters.' });
      return;
    }

    if (!patient_phone || typeof patient_phone !== 'string' || !/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.test(patient_phone.trim())) {
      res.status(400).json({ error: 'Missing or invalid field: patient_phone must be a valid 10-digit mobile number.' });
      return;
    }

    if (!address || typeof address !== 'string' || address.trim().length < 3) {
      res.status(400).json({ error: 'Missing or invalid field: address is required for service dispatch.' });
      return;
    }

    // 2. Validate caregiver exists in roster - DO NOT invent fake caregiver
    const caregiver = CAREGIVERS.find(c => c.caregiver_id === caregiver_id.trim());
    if (!caregiver) {
      res.status(400).json({
        error: `Invalid caregiver_id "${caregiver_id}". Provider not found in roster.`,
        details: 'Only real, active caregivers from the roster can be booked.'
      });
      return;
    }

    // 3. Provider eligibility check against requested care_type
    if (care_type === 'home_nursing' && caregiver.role !== 'medic') {
      res.status(400).json({ error: `Caregiver ${caregiver.name} is not certified for home nursing procedures.` });
      return;
    }
    if (care_type === 'lab_test_home' && caregiver.role !== 'phlebotomist') {
      res.status(400).json({ error: `Caregiver ${caregiver.name} is not a certified phlebotomist for lab sample collection.` });
      return;
    }
    if (care_type === 'teleconsultation' && caregiver.role !== 'doctor') {
      res.status(400).json({ error: `Caregiver ${caregiver.name} is not a registered doctor for teleconsultation.` });
      return;
    }

    // 4. Duplicate booking prevention within 5-minute window
    const nowMs = Date.now();
    const existingDuplicate = Object.values(BOOKINGS).find(b =>
      b.caregiver_name === caregiver.name &&
      b.patient_name.toLowerCase() === patient_name.trim().toLowerCase() &&
      b.eta_or_slot === preferred_slot &&
      (nowMs - new Date(b.created_at).getTime()) < 5 * 60 * 1000
    );

    if (existingDuplicate) {
      res.json({
        success: true,
        duplicate_prevented: true,
        message: 'Existing recent booking found for this caregiver and slot.',
        booking: existingDuplicate
      });
      return;
    }

    // 5. Generate confirmed booking record
    const bookingId = `BK-${Date.now().toString().slice(-6)}`;
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const confirmation: BookingConfirmation = {
      booking_id: bookingId,
      status: 'confirmed',
      caregiver_name: caregiver.name,
      caregiver_role: caregiver.role,
      caregiver_phone: '+91 98110 00000',
      patient_name: patient_name.trim(),
      eta_or_slot: preferred_slot,
      otp,
      service_type: care_type,
      created_at: new Date().toISOString(),
      is_demo: true,
      disclaimer: 'DEMO BOOKING: This reservation is simulated for testing/demonstration purposes and does not dispatch live emergency or commercial services.',
      instructions: [
        'Keep medical prescriptions and reports handy.',
        `Share OTP (${otp}) with the caregiver upon arrival for verification.`,
        'Sanocare support helpline: 1800-SANOCARE (Toll-free).'
      ]
    };

    BOOKINGS[bookingId] = confirmation;
    res.json({ success: true, booking: confirmation });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
app.post('/book', handleBook);
app.post('/api/book', handleBook);

// POST /batch_predict
const handleBatchPredict = (req: express.Request, res: express.Response) => {
  try {
    let csvData = '';
    if (typeof req.body === 'string') {
      csvData = req.body;
    } else if (req.body && req.body.csv) {
      csvData = req.body.csv;
    }

    let dataset = TRAINING_DATASET;
    if (csvData && csvData.includes('user_input')) {
      dataset = parseTrainingDataset(csvData);
    }

    const predictionsCsv = generatePredictionsCsv(dataset);
    const metrics = evaluateDataset(dataset);

    if (req.headers.accept?.includes('text/csv')) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="predictions.csv"');
      res.send(predictionsCsv);
      return;
    }

    res.json({
      success: true,
      total_rows: dataset.length,
      metrics,
      predictions_csv: predictionsCsv
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
app.post('/batch_predict', handleBatchPredict);
app.post('/api/batch_predict', handleBatchPredict);

// GET /api/benchmark
app.get('/api/benchmark', (req, res) => {
  try {
    const metrics = evaluateDataset(TRAINING_DATASET);
    res.json({
      success: true,
      metrics,
      dataset_size: TRAINING_DATASET.length
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/caregivers
app.get('/api/caregivers', (req, res) => {
  res.json({
    caregivers: CAREGIVERS
  });
});

// GET /download-zip & /api/download-zip
const handleDownloadZip = (req: express.Request, res: express.Response) => {
  const zipPath = path.resolve(__dirname, 'public', 'carecompass-source.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="carecompass-project.zip"');
    const fileStream = fs.createReadStream(zipPath);
    fileStream.pipe(res);
  } else {
    res.status(404).json({ error: 'Zip file not found' });
  }
};
app.get('/download-zip', handleDownloadZip);
app.get('/api/download-zip', handleDownloadZip);

// ==========================================
// VITE DEV SERVER / STATIC ASSETS
// ==========================================
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CareCompass server listening on http://0.0.0.0:${PORT}`);
    // Pre-warm evaluation cache
    const evalSummary = evaluateDataset(TRAINING_DATASET);
    console.log(`[Benchmark Pre-warm] Safety Recall: ${(evalSummary.safety_recall * 100).toFixed(1)}% | CareType F1: ${(evalSummary.care_type_macro_f1 * 100).toFixed(1)}% | Urgency F1: ${(evalSummary.urgency_macro_f1 * 100).toFixed(1)}% | NDCG@3: ${evalSummary.ndcg_at_3}`);
  });
}

startServer();
