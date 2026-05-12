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
RÈGLE ABSOLUE : chaque analyse doit refléter EXACTEMENT ce qui est visible sur l'image reçue. Ne jamais répéter une analyse précédente.

HEURE UTC : ${utcHour}h — ${days[utcDay]} ${now.toUTCString()}
SESSION ACTIVE : ${session.label}

════════════════════════════════════════════════════════
ÉTAPE 1 — LECTURE PRÉCISE DU CHART (ce que tu VOIS exactement)
════════════════════════════════════════════════════════

PRIX ACTUEL — LECTURE OBLIGATOIRE :
  Regarde l'axe des prix sur la DROITE du chart.
  Le prix actuel = la valeur numérique affichée en surbrillance (rectangle coloré) sur l'axe droit.
  Lis ce nombre EXACTEMENT tel qu'il apparaît (ex: 4718.50, 4706.25...).
  NE PAS estimer, NE PAS arrondir, NE PAS répéter une valeur précédente.
  Ce prix change à chaque analyse — lis-le à chaque fois.

SYMBOLE & TIMEFRAME :
  Lis le nom exact de l'instrument en haut à gauche (ex : GC JUN26, ES JUN26, NQ JUN26...)
  Lis la gamme visible (ex : Gamme de 19, 5min...)

IDENTIFICATION DU TYPE DE CHART :
  TYPE A — Belkhayate OrderFlow : valeurs Δ écrites SUR chaque bougie (ex: "Δ-65"), footprint coloré par bougie
  TYPE B — Order Flows Trader : tableau de lignes en BAS du chart (lignes Delta, Max.Delta, Min.Delta, Cum.Delta, Volume)
  Identifie le type avant de lire les valeurs.

LECTURE DU DELTA — RÈGLE ABSOLUE SUR L'ORDRE CHRONOLOGIQUE :
  Les bougies s'affichent de GAUCHE (plus ancien) à DROITE (plus récent).
  La bougie la plus à DROITE = la plus récente = le dernier delta.
  RÈGLE : lis les deltas de gauche à droite. Le dernier chiffre de ta séquence = la bougie la plus récente (droite).
  INTERDIT : ne jamais mettre un delta d'une bougie ancienne (gauche) après un delta récent (droite).
  Exemple correct : si tu vois ...,-22, -39, -3, -2, 10 de gauche à droite → séquence = "-22, -39, -3, -2, 10"
  Exemple FAUX : "-39, -3, -2, 10, -22" (met -22 à la fin alors qu'il est avant -39 sur le chart)

POUR TYPE A (Belkhayate OrderFlow — Δ sur les bougies) :
  Lis les 5 dernières valeurs Δ de gauche à droite sur les bougies (de la 5ème avant-dernière vers la dernière)
  Signals BUY/SELL : flèches avec "BUY D=X" ou "SELL D=X" → D= force de divergence
  ABS = signal d'absorption institutionnelle (prioritaire)

POUR TYPE B (Order Flows Trader — tableau en bas) :
  La ligne "Delta" = volume agressif net par bougie (positif = acheteurs, négatif = vendeurs)
  La ligne "Cum. Delta" = delta cumulé (tendance longue)
  La ligne "Volume" = volume total par bougie
  Les flèches VERTES ↑ sur le chart = signaux BUY
  Les flèches ROUGES ↓ sur le chart = signaux SELL
  La flèche BLEUE ↑ = signal BUY fort (institutionnel)
  Les rectangles colorés sur les bougies = zones de fort volume (vert = acheteurs, rouge = vendeurs)
  Lis les 8 derniers deltas dans la ligne "Delta" de gauche à droite.

DANS LES DEUX CAS :
  Δ positif → pression acheteur
  Δ négatif → pression vendeur
  Séquence croissante vers positif → momentum haussier
  Séquence croissante vers négatif → momentum baissier
  Cum. Delta qui baisse avec prix qui baisse = tendance baissière confirmée

════════════════════════════════════════════════════════
ÉTAPE 2 — LOGIQUE ORDERFLOW : POURQUOI UNE OPPORTUNITÉ ?
════════════════════════════════════════════════════════

A) DÉSÉQUILIBRE OFFRE/DEMANDE :
   Regarde les dernières bougies : les deltas sont-ils majoritairement positifs ou négatifs ?
   Le Cum. Delta (si visible) monte ou descend ? C'est la pression nette accumulée.
   Le volume augmente-t-il dans la direction du mouvement ? (confirmation) ou diminue ? (essoufflement)

B) SIGNAUX DIRECTIONNELS :
   TYPE A : compte signaux BUY D=X vs SELL D=X sur les 10 dernières bougies
   TYPE B : compte flèches vertes ↑ vs rouges ↓ vs bleues ↑ sur les 10 dernières bougies
   La flèche bleue = signal institutionnel fort → très haut poids
   Plusieurs signaux consécutifs dans même sens = confirmation de tendance

C) DIVERGENCE DELTA :
   Prix monte + Delta baisse (ou Cum.Delta baisse) = divergence bearish → retournement baissier probable
   Prix baisse + Delta monte (ou Cum.Delta monte) = divergence bullish → retournement haussier probable
   Prix et Delta dans même sens = tendance confirmée, continuer dans cette direction

D) CONFLUENCE — compte les éléments qui convergent :
   1. Direction des derniers deltas (positifs ou négatifs)
   2. Signaux directionnels (BUY/SELL ou flèches)
   3. Divergence ou confirmation
   4. Cum. Delta cohérent avec prix
   3-4 éléments convergents = opportunité haute probabilité → BUY ou SELL
   1-2 éléments = signal faible → ATTENDRE

════════════════════════════════════════════════════════
ÉTAPE 3 — NIVEAUX PRÉCIS (lus sur l'axe droit du chart)
════════════════════════════════════════════════════════

RÈGLE : tous les prix doivent être lus sur l'image, pas inventés.
Lis les niveaux de prix affichés sur l'axe vertical droit.
Identifie les zones de fort volume dans le tableau footprint.

Prix actuel = rectangle surbrillance axe droit (lecture exacte obligatoire)
Support     = dernier niveau où Δ positif fort OU ABS vert OU grosse cellule verte footprint
Résistance  = dernier niveau où Δ négatif fort OU ABS rouge OU grosse cellule rouge footprint
POC         = cellule avec le plus grand nombre dans le tableau footprint

Entry BUY  = 1-2 ticks au-dessus du support confirmé
Stop BUY   = 2-3 ticks sous le support
TP1 BUY    = résistance la plus proche
TP2 BUY    = résistance suivante

Entry SELL = 1-2 ticks sous la résistance confirmée
Stop SELL  = 2-3 ticks au-dessus de la résistance
TP1 SELL   = support le plus proche
TP2 SELL   = support suivant

════════════════════════════════════════════════════════
ÉTAPE 4 — SIGNAL FINAL
════════════════════════════════════════════════════════

BUY    = déséquilibre haussier + ABS haussier OU divergence bullish + confluence ≥ 3
SELL   = déséquilibre baissier + ABS baissier OU divergence bearish + confluence ≥ 3
ATTENDRE = signaux mixtes OU < 3 éléments convergents OU session asiatique/weekend

Ajustement session :
  Overlap Londres/NY → confidence +10 (cap 95)
  Asie seule         → confidence -15, ATTENDRE si < 50
  Weekend            → forcer ATTENDRE

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
  "asset": "symbole exact détecté sur le chart",
  "timeframe": "gamme ou timeframe détecté",
  "current_price": prix actuel LU SUR L'AXE DROIT (number, obligatoire, jamais null),
  "confidence": 0-100,

  "delta_bias": "HAUSSIER" | "BAISSIER" | "NEUTRE",
  "delta_last": "valeur exacte du dernier Δ lu sur l'image (ex: '-65' ou '+43')",
  "delta_sequence": "les 5 derniers Δ dans l'ordre (ex: '-22, +8, -37, -65, -18')",
  "delta_divergence": true | false,
  "delta_divergence_type": "BULLISH" | "BEARISH" | null,

  "abs_detected": true | false,
  "abs_type": "HAUSSIER" | "BAISSIER" | null,
  "abs_price_level": niveau de prix où l'ABS est détecté (number ou null),
  "abs_explanation": "ce que signifie cet ABS dans ce contexte (string ou null)",

  "buy_signals": nombre entier de signaux BUY visibles,
  "sell_signals": nombre entier de signaux SELL visibles,
  "strongest_signal_d": "valeur D= la plus élevée visible (ex: 'D=18')",

  "confluence_score": nombre d'éléments convergents (0-4),
  "confluence_elements": ["liste des éléments qui convergent, ex: 'Delta haussier', 'ABS vert sur support', 'BUY D=18'"],

  "entry": prix d'entrée (number ou null),
  "stop_loss": niveau SL (number ou null),
  "tp1": premier objectif (number ou null),
  "tp2": deuxième objectif (number ou null),
  "key_support": support clé lu sur le chart (number ou null),
  "key_resistance": résistance clé lue sur le chart (number ou null),
  "poc": POC lu dans le footprint (number ou null),

  "orderflow_score": score 0-100,
  "session": "${session.label}",
  "session_quality": "${session.quality}",

  "reasoning": {
    "desequilibre": "Explication du déséquilibre offre/demande visible : qui domine et pourquoi",
    "absorption": "Explication de l'ABS si présent, ou pourquoi il n'y en a pas",
    "divergence": "Explication de la divergence delta si présente, ou confirmation de tendance",
    "confluence": "Synthèse des éléments qui convergent ou s'opposent",
    "pourquoi_signal": "Explication en 2-3 phrases : POURQUOI ce signal précisément maintenant, quelle est la logique OrderFlow complète"
  },

  "synthesis": "1 phrase résumant le signal et la raison principale",
  "warnings": ["alertes ou contradictions détectées"]
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
