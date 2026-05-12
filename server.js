import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/live' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Historique en mémoire (50 dernières analyses)
const history = [];
const MAX_HISTORY = 50;

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function getSession(utcHour, utcDay) {
  if (utcDay === 0 || utcDay === 6) return { label: 'WEEKEND — MARCHÉS FERMÉS', quality: 'closed' };
  if (utcHour >= 22 || utcHour < 7)  return { label: 'SESSION ASIE (liquidité faible)', quality: 'low' };
  if (utcHour >= 7  && utcHour < 8)  return { label: 'TOKYO → LONDRES (transition)', quality: 'medium' };
  if (utcHour >= 8  && utcHour < 12) return { label: 'SESSION LONDRES (forte liquidité)', quality: 'high' };
  if (utcHour >= 12 && utcHour < 17) return { label: 'OVERLAP LONDRES / NEW YORK ★ LIQUIDITÉ MAX', quality: 'max' };
  if (utcHour >= 17 && utcHour < 21) return { label: 'SESSION NEW YORK (clôture US)', quality: 'high' };
  return { label: 'TRANSITION INTER-SESSION', quality: 'medium' };
}

function buildPrompt() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay  = now.getUTCDay();
  const session = getSession(utcHour, utcDay);
  const days    = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];

  return `Tu es un moteur d'analyse Order Flow institutionnel spécialisé NinjaTrader + Belkhayate OrderFlow.
Retourne UNIQUEMENT du JSON valide. Aucun texte avant ou après. Jamais.

HEURE UTC : ${utcHour}h — ${days[utcDay]} ${now.toUTCString()}
SESSION ACTIVE : ${session.label}

════════════════════════════════════════════════════════
ÉTAPE 1 — LECTURE DU BELKHAYATE ORDERFLOW CHART
════════════════════════════════════════════════════════

Tu analyses un chart NinjaTrader avec l'indicateur "Belkhayate OrderFlow".
Identifie dans l'ordre :

SYMBOLE & TIMEFRAME :
  Lis le nom de l'instrument en haut (ex : GC JUN26, ES JUN26, NQ JUN26...)
  Lis la gamme / timeframe indiquée (ex : Gamme de 19, 5min, 1min...)

FOOTPRINT CANDLES (boîtes vert/rouge sur chaque bougie) :
  Chaque bougie = volume BUY (haut de boîte) vs SELL (bas de boîte)
  Boîte verte dominante → acheteurs gagnent ce tick
  Boîte rouge dominante → vendeurs gagnent ce tick
  Repère les 5 dernières bougies pour voir la tendance récente

DELTA (Δ affiché sur chaque bougie) :
  Δ positif (ex Δ+43) → plus d'agressifs acheteurs que vendeurs → pression haussière
  Δ négatif (ex Δ-65) → plus d'agressifs vendeurs → pression baissière
  Tendance des Δ sur les 5 dernières bougies = biais directionnel principal
  Valeur absolue élevée (>50) = signal fort

SIGNAUX BUY / SELL (flèches + label "BUY D=X" ou "SELL D=X") :
  D=X = force de la divergence delta (D>10 = signal fort, D>20 = signal très fort)
  Plusieurs signaux consécutifs dans même sens = confirmation
  Compte le nombre de signaux BUY et SELL visibles sur les 10 dernières bougies

SIGNAUX ABS (Absorption) :
  ABS = un acteur institutionnel absorbe massivement les ordres adverses
  ABS vert sur support → accumulation → haussier
  ABS rouge sur résistance → distribution → baissier
  ABS = signal fort, prioritaire sur les autres

TABLEAU FOOTPRINT EN BAS DU CHART :
  Lignes vertes intenses = fort volume acheteur à ce niveau = support
  Lignes rouges intenses = fort volume vendeur à ce niveau = résistance
  La ligne la plus intense = POC (Point of Control) = niveau clé

════════════════════════════════════════════════════════
ÉTAPE 2 — BIAIS DIRECTIONNEL & SCORE ORDERFLOW
════════════════════════════════════════════════════════

Calcule un score OrderFlow sur 100 basé sur :
  Delta trend (5 dernières bougies)  : 0-30 pts
  Signaux BUY/SELL (force D=X)       : 0-25 pts
  Signaux ABS et position            : 0-25 pts
  Structure footprint (qui domine)   : 0-20 pts

Score ≥ 65 ET haussier → BUY
Score ≥ 65 ET baissier → SELL
Score < 65 OU mixte    → ATTENDRE

════════════════════════════════════════════════════════
ÉTAPE 3 — NIVEAUX CLÉS (lus directement sur le chart)
════════════════════════════════════════════════════════

Lis les prix visibles sur l'axe vertical droit et dans le tableau footprint :
  Prix actuel de la dernière bougie
  Résistance la plus proche au-dessus (zone rouge / vendeurs)
  Support le plus proche en-dessous (zone verte / acheteurs)
  POC (niveau de plus fort volume dans le footprint)

Si signal BUY :
  Entry   = prix actuel ou légèrement au-dessus du support
  Stop    = sous le support (1-2 ticks)
  TP1     = résistance proche
  TP2     = résistance suivante ou extension

Si signal SELL :
  Entry   = prix actuel ou légèrement sous la résistance
  Stop    = au-dessus de la résistance (1-2 ticks)
  TP1     = support proche
  TP2     = support suivant ou extension

════════════════════════════════════════════════════════
ÉTAPE 4 — SIGNAL FINAL (avec ajustement session)
════════════════════════════════════════════════════════

Règles de session :
  OVERLAP LONDRES/NY → confidence +10 (cap 95), signaux très fiables
  SESSION ASIE       → confidence -15, forcer ATTENDRE si confidence < 50
  WEEKEND            → forcer signal ATTENDRE systématiquement

FORMAT JSON OBLIGATOIRE (retourne exactement ceci, rien d'autre) :
{
  "signal": "BUY" | "SELL" | "ATTENDRE",
  "asset": "symbole exact détecté",
  "timeframe": "gamme ou timeframe détecté",
  "confidence": 0-100,
  "delta_bias": "HAUSSIER" | "BAISSIER" | "NEUTRE",
  "delta_last": "valeur du dernier Δ visible (ex: -65)",
  "delta_trend": "description de la tendance des 5 derniers Δ",
  "abs_detected": true | false,
  "abs_type": "HAUSSIER" | "BAISSIER" | null,
  "buy_signals": nombre de signaux BUY visibles (entier),
  "sell_signals": nombre de signaux SELL visibles (entier),
  "strongest_signal_d": "valeur D= la plus élevée visible (ex: D=18)",
  "entry": prix d'entrée suggéré (number ou null),
  "stop_loss": niveau SL (number ou null),
  "tp1": premier objectif (number ou null),
  "tp2": deuxième objectif (number ou null),
  "key_support": niveau support clé (number ou null),
  "key_resistance": niveau résistance clé (number ou null),
  "poc": niveau POC footprint (number ou null),
  "session": "${session.label}",
  "session_quality": "${session.quality}",
  "orderflow_score": score 0-100,
  "synthesis": "1-2 phrases résumant la situation et le signal",
  "warnings": ["alertes ou contradictions"]
}`;
}

// ─── Routes Express ───────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, 'public')));

app.get('/api/history', (_req, res) => {
  res.json(history.slice().reverse());
});

app.get('/api/session', (_req, res) => {
  const now = new Date();
  res.json(getSession(now.getUTCHours(), now.getUTCDay()));
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── WebSocket Live Analysis ──────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] Client connecté');
  send(ws, { type: 'connected' });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', message: 'JSON invalide' }); }

    if (msg.type !== 'frame' || !msg.data) return;

    send(ws, { type: 'analyzing' });

    // Keep-alive pendant l'analyse (Claude peut prendre 10-20s)
    const keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send(ws, { type: 'keepalive' });
    }, 12000);

    try {
      // Extraire base64 + media_type depuis data URI
      let imgBase64 = msg.data;
      let mediaType = 'image/jpeg';
      if (msg.data.startsWith('data:')) {
        const [header, data] = msg.data.split(',');
        imgBase64 = data;
        if (header.includes('png')) mediaType = 'image/png';
        else if (header.includes('webp')) mediaType = 'image/webp';
      }

      const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-5',
        max_tokens: 2048,
        system: buildPrompt(),
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imgBase64 }
            },
            {
              type: 'text',
              text: 'Analyse ce chart Belkhayate OrderFlow NinjaTrader. Exécute les 4 étapes et retourne UNIQUEMENT le JSON.'
            }
          ]
        }]
      });

      clearInterval(keepAlive);

      const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '';

      let parsed;
      try {
        const match = rawText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : rawText);
      } catch {
        return send(ws, { type: 'error', message: 'Erreur parsing réponse Claude', raw: rawText.slice(0, 500) });
      }

      const entry = { ...parsed, timestamp: Date.now() };
      history.push(entry);
      if (history.length > MAX_HISTORY) history.shift();

      send(ws, { type: 'signal', payload: entry, timestamp: Date.now() });
      console.log(`[SIGNAL] ${parsed.asset} — ${parsed.signal} — conf:${parsed.confidence}%`);

    } catch (err) {
      clearInterval(keepAlive);
      const msg2 = err instanceof Error ? err.message : 'Erreur inconnue';
      console.error('[ERR]', msg2);
      send(ws, { type: 'error', message: msg2 });
    }
  });

  ws.on('close', () => console.log('[WS] Client déconnecté'));
  ws.on('error', (e) => console.error('[WS Error]', e.message));
});

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`✅ OrderFlow Live Analysis — http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY non défini — analyses désactivées');
  }
});
