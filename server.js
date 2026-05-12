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

  return `Tu es un trader institutionnel Order Flow expert. Tu analyses des charts NinjaTrader avec la précision d'un prop trader professionnel.
Retourne UNIQUEMENT du JSON valide. Aucun texte avant ou après.
RÈGLE ABSOLUE : analyse UNIQUEMENT ce que tu vois sur cette image. Chaque analyse est indépendante.

HEURE UTC : ${utcHour}h — ${days[utcDay]} ${now.toUTCString()}
SESSION : ${session.label}

════════════════════════════════════════════════════════
ÉTAPE 1 — LECTURE BRUTE DU CHART
════════════════════════════════════════════════════════

PRIX ACTUEL : rectangle surbrillant sur l'axe DROIT → lis-le EXACTEMENT (ex: 4710.6)
INSTRUMENT  : nom exact en haut à gauche (ex: GC JUN26)
TYPE DE CHART :
  TYPE A = valeurs Δ écrites sur chaque bougie (Belkhayate OrderFlow)
  TYPE B = tableau Delta/Cum.Delta/Volume en BAS du chart (Order Flows Trader)

ORDRE CHRONOLOGIQUE — RÈGLE ABSOLUE :
  GAUCHE = plus ancien, DROITE = plus récent.
  La séquence se lit TOUJOURS de gauche à droite.
  Le DERNIER chiffre de la séquence = bougie la plus à droite (la plus récente).
  JAMAIS mettre un delta ancien après un delta récent.

TYPE B — STRUCTURE EXACTE DU TABLEAU (ordre confirmé par l'utilisateur, de bas en haut) :
  ┌──────────────────────────────────────────────────────────────────────┐
  │ LIGNE 7 (haut+) : Ask        = volume ask                           │
  │ LIGNE 6         : Bid        = volume bid                           │
  │ LIGNE 5         : Delta      = delta net par bougie (ex: 23)        │
  │ LIGNE 4         : Volume     = volume total par bougie (ex: 69)     │
  │ LIGNE 3         : Cum. Delta = delta CUMULÉ session (ex: -306)      │ ← PRIORITAIRE
  │ LIGNE 2         : Max. Delta = delta maximum de la bougie (ex: 25)  │
  │ LIGNE 1 (bas)   : Min. Delta = delta minimum de la bougie (ex: -3)  │
  └──────────────────────────────────────────────────────────────────────┘

  LECTURE DU CUM.DELTA — RÈGLE ABSOLUE :
  → C'est la 3ème ligne depuis le BAS (au-dessus de Max.Delta et Min.Delta)
  → Valeurs typiquement grandes : -306, -1070, +726, -950...
  → Lis la colonne la plus à DROITE = bougie la plus récente = valeur de session actuelle
  → NE PAS confondre avec Delta (ligne 5) ni Volume (ligne 4)

  LECTURE DELTA/BOUGIE :
  → Ligne 5 (haut, Delta) : lis les 10 dernières valeurs de gauche à droite

  Flèches vertes ↑ = BUY | Flèches rouges ↓ = SELL
  Flèches bleues/cyan ↑ = BUY institutionnel | Flèches bleues/cyan ↓ = SELL institutionnel

  ══ RÈGLE ABSOLUE — COULEUR = SIGNE (priorité sur tout) ══
  CELLULE VERTE = valeur POSITIVE  →  "306" vert  = +306
  CELLULE ROUGE = valeur NÉGATIVE  →  "306" rouge = -306
  Le tiret "-" peut être illisible → la COULEUR prime TOUJOURS sur le signe visible.
  Rouge = négatif. Sans aucune exception.

════════════════════════════════════════════════════════
ÉTAPE 2 — LES 4 FILTRES INSTITUTIONNELS (dans cet ordre de priorité)
════════════════════════════════════════════════════════

▶ FILTRE 1 — CUM DELTA : LA TENDANCE MAÎTRE DE LA SESSION
  Le Cum.Delta = pression nette TOTALE depuis l'ouverture de la session.
  C'est le filtre le plus important. Il définit le CONTEXTE.
  RAPPEL SIGNE : cellule rouge = valeur négative. Lis "cellule rouge 726" → Cum.Delta = -726 (NÉGATIF).

  Cum.Delta fortement négatif (ex: -792, -1000...) = la session EST vendeuse.
    → Les acheteurs agressifs ont été dominés toute la session.
    → Toute séquence positive courte (5-10 bougies) = REBOND TECHNIQUE, pas un retournement.
    → NE PAS donner un signal BUY dans un Cum.Delta fortement négatif sauf exception rare.
    → Signal correct = SELL sur rebond, ou ATTENDRE confirmation de retournement.

  Cum.Delta fortement positif (ex: +500, +800...) = la session EST acheteuse.
    → Toute séquence négative courte = correction technique, pas retournement.
    → NE PAS donner un signal SELL sauf divergence majeure.

  Cum.Delta proche de 0 ou mixte = session neutre → regarder tendance récente uniquement.

  RÈGLE ANTI-PIÈGE : si les derniers deltas sont positifs MAIS Cum.Delta est négatif :
    → C'est un rebond dans une tendance baissière = TRAP HAUSSIER.
    → Signal = ATTENDRE ou SELL, jamais BUY.

▶ FILTRE 2 — VALUE AREA / POC (bandes horizontales colorées sur le chart)
  Les bandes horizontales grises/vertes/rouges = zones de forte activité institutionnelle.
  Ces bandes montrent OÙ le volume s'est concentré = où les institutionnels ont agi.

  POSITION DE LA BANDE PAR RAPPORT AU PRIX ACTUEL :
  Bande au SOMMET de la structure récente (prix dessous ou au niveau) :
    → Distribution institutionnelle en haut = résistance forte.
    → Les institutionnels ont vendu massivement là.
    → Signal = SELL ou ATTENDRE (le prix va revenir vers la bande puis rebondir à la baisse).

  Bande en BAS de la structure récente (prix dessus) :
    → Accumulation institutionnelle en bas = support fort.
    → Signal = BUY sur pullback vers cette zone.

  RÈGLE : si la bande s'est déplacée vers le HAUT récemment + Cum.Delta négatif :
    → Distribution massive confirmée = SELL fort.

▶ FILTRE 3 — DIVERGENCE DELTA/PRIX (le signal de retournement)
  Prix monte + Cum.Delta baisse = divergence bearish → retournement baissier imminent.
  Prix baisse + Cum.Delta monte = divergence bullish → retournement haussier imminent.
  Prix monte + gros deltas négatifs qui persistent = distribution active → SELL.
  Prix baisse + gros deltas positifs qui persistent = accumulation active → BUY.

  VOLUME AVEC PRIX QUI N'AVANCE PAS :
  Gros volume (ex: 236 contracts) + prix stagne ou baisse = absorption/distribution.
  Signification : les vendeurs absorbent tous les acheteurs → continuation baissière.

▶ FILTRE 4 — SIGNAUX DIRECTIONNELS (confirmation uniquement)
  Ce filtre confirme ou infirme, il ne suffit PAS seul à donner un signal.
  Flèche bleue ↑ = signal institutionnel fort MAIS à valider avec les 3 filtres précédents.
  Si flèche bleue + Cum.Delta négatif + bande en haut → le signal bleu est un piège.
  Plusieurs flèches vertes consécutives + Cum.Delta positif + bande en bas = BUY confirmé.

════════════════════════════════════════════════════════
ÉTAPE 3 — NIVEAUX (lus sur l'image)
════════════════════════════════════════════════════════

Prix actuel   = axe droit (exact)
Résistance    = bande haute OU dernière zone de forte activité vendeuse au-dessus
Support       = bande basse OU dernière zone de forte activité acheteuse en-dessous
POC session   = niveau de plus fort volume visible

BUY  : Entry juste au-dessus support, Stop sous support, TP1=résistance proche, TP2=suivante
SELL : Entry juste sous résistance, Stop au-dessus résistance, TP1=support proche, TP2=suivant

════════════════════════════════════════════════════════
ÉTAPE 4 — DÉCISION FINALE
════════════════════════════════════════════════════════

MATRICE DE DÉCISION :
  Cum.Delta négatif + Bande en haut + Prix en dessous bande   → SELL (fort)
  Cum.Delta négatif + Deltas positifs courts                  → ATTENDRE (rebond, pas retournement)
  Cum.Delta positif + Bande en bas + Prix au-dessus bande     → BUY (fort)
  Cum.Delta positif + Deltas négatifs courts                  → ATTENDRE (correction, pas retournement)
  Divergence confirmée + Cum.Delta retourne                   → signal dans sens divergence
  Signaux mixtes OU Cum.Delta neutre                          → ATTENDRE

Session :
  Overlap Londres/NY → +10 confiance (cap 95)
  Asie seule → -15 confiance, ATTENDRE si < 50
  Weekend → forcer ATTENDRE

FORMAT JSON OBLIGATOIRE (retourne exactement ceci, rien d'autre) :
{
  "signal": "BUY" | "SELL" | "ATTENDRE",
  "asset": "symbole exact détecté sur le chart",
  "timeframe": "gamme ou timeframe détecté",
  "current_price": prix actuel LU SUR L'AXE DROIT (number, obligatoire, jamais null),
  "confidence": 0-100,

  "cum_delta": valeur du Cum.Delta LUE sur l'image (number, ex: -792),
  "cum_delta_context": "FORTEMENT_NÉGATIF" | "NÉGATIF" | "NEUTRE" | "POSITIF" | "FORTEMENT_POSITIF",
  "cum_delta_trap": true | false,
  "cum_delta_trap_explanation": "si trap=true : pourquoi les deltas positifs récents sont un piège dans ce contexte",

  "value_area_position": "HAUT" | "BAS" | "MILIEU" | "NON_VISIBLE",
  "value_area_explanation": "ce que dit la position de la bande grise/colorée sur la structure",
  "value_area_signal": "DISTRIBUTION_RÉSISTANCE" | "ACCUMULATION_SUPPORT" | "NEUTRE" | "NON_VISIBLE",

  "delta_bias": "HAUSSIER" | "BAISSIER" | "NEUTRE",
  "delta_last": "valeur exacte du dernier Δ (ex: '-7')",
  "delta_sequence": "10 derniers deltas de gauche à droite (ex: '10, 33, 38, 44, -7, -22, -9, 28, 16, -7')",
  "delta_divergence": true | false,
  "delta_divergence_type": "BULLISH" | "BEARISH" | null,
  "delta_divergence_explanation": "description précise de la divergence si présente",

  "buy_signals": nombre entier de flèches BUY visibles,
  "sell_signals": nombre entier de flèches SELL visibles,
  "institutional_signals": nombre de flèches bleues (BUY institutionnel),

  "confluence_score": 0-4,
  "confluence_elements": ["éléments convergents"],
  "anti_confluence": ["éléments qui contredisent le signal — IMPORTANT à lister"]

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
    "filtre1_cum_delta": "Cum.Delta = X → contexte de session = HAUSSIER/BAISSIER/NEUTRE. Les derniers deltas positifs/négatifs sont-ils une tendance ou un piège dans ce contexte ?",
    "filtre2_value_area": "La bande horizontale est en HAUT/BAS/MILIEU de la structure. Ce que ça signifie : distribution ou accumulation institutionnelle. Impact sur le signal.",
    "filtre3_divergence": "Y a-t-il une divergence prix/delta ? Prix monte mais Cum.Delta baisse = distribution. Volume élevé sans progression de prix = absorption. Explication détaillée.",
    "filtre4_signaux": "Flèches BUY/SELL/Institutionnelles visibles. Sont-elles confirmées par les 3 filtres précédents ou contredites ?",
    "pourquoi_signal": "Conclusion en 2-3 phrases : synthèse des 4 filtres → POURQUOI ce signal est valide ou pourquoi ATTENDRE. Mention explicite si c'est un piège."
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
