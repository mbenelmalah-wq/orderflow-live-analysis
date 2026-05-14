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

const history = [];
const MAX_HISTORY = 50;

function getSession(utcHour, utcDay) {
  if (utcDay === 0 || utcDay === 6) return { label: 'WEEKEND - MARCHES FERMES', quality: 'closed' };
  if (utcHour >= 22 || utcHour < 7)  return { label: 'SESSION ASIE (liquidite faible)', quality: 'low' };
  if (utcHour >= 7  && utcHour < 8)  return { label: 'TOKYO -> LONDRES (transition)', quality: 'medium' };
  if (utcHour >= 8  && utcHour < 12) return { label: 'SESSION LONDRES (forte liquidite)', quality: 'high' };
  if (utcHour >= 12 && utcHour < 17) return { label: 'OVERLAP LONDRES / NEW YORK - LIQUIDITE MAX', quality: 'max' };
  if (utcHour >= 17 && utcHour < 21) return { label: 'SESSION NEW YORK (cloture US)', quality: 'high' };
  return { label: 'TRANSITION INTER-SESSION', quality: 'medium' };
}

function buildPrompt() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay  = now.getUTCDay();
  const session = getSession(utcHour, utcDay);
  const days    = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];

  return `Tu es un expert Order Flow base sur la methode de Trader Dale (livre "Order Flow Trading Setups").
Tu analyses des charts NinjaTrader avec le logiciel TD Order Flow.
Retourne UNIQUEMENT du JSON valide. Aucun texte avant ou apres.
Chaque analyse est INDEPENDANTE - analyse uniquement ce que tu vois sur cette image.

HEURE UTC : ${utcHour}h - ${days[utcDay]} ${now.toUTCString()}
SESSION : ${session.label}

==============================================================
ETAPE 1 - LECTURE BRUTE (faits, pas d'interpretation)
==============================================================

PRIX ACTUEL : rectangle surbrillant sur l'axe DROIT (ex: 4701.2)
INSTRUMENT  : nom en haut a gauche (ex: GC JUN26, 6E DEC25)
CHRONOLOGIE : GAUCHE = plus ancien | DROITE = plus recent

REGLE ABSOLUE - COULEUR = SIGNE (prime sur le texte) :
  CELLULE ROUGE = valeur NEGATIVE  ("306" en rouge -> -306)
  CELLULE VERTE = valeur POSITIVE  ("306" en vert  -> +306)

STRUCTURE TABLEAU (bas -> haut, ordre confirme) :
  LIGNE 1 (bas) : Min.Delta   - petites valeurs negatives
  LIGNE 2       : Max.Delta   - petites valeurs positives
  LIGNE 3       : Cum.Delta   - GRANDES valeurs (+/-200 a +/-3000) <- LECTURE PRIORITAIRE
  LIGNE 4       : Volume      - grandes valeurs positives
  LIGNE 5       : Delta       - petites valeurs mixtes
  LIGNE 6       : Bid         - volumes Bid par prix
  LIGNE 7 (haut): Ask         - volumes Ask par prix

CUM.DELTA (ligne 3 depuis le bas) :
  - Cellule la plus a DROITE = valeur courante de session
  - Rouge = negatif / Vert = positif
  - Si |valeur| < 100 : mauvaise ligne identifiee, recommence
  - Renseigne cum_delta_cell_color: "RED" ou "GREEN"

TENDANCE PRIX (15 dernieres bougies) :
  - Sommets ET creux de plus en plus HAUTS = UPTREND
  - Sommets ET creux de plus en plus BAS = DOWNTREND
  - Sans direction claire = RANGE

DELTA PAR BOUGIE (ligne 5) : lis les 10 dernieres valeurs gauche -> droite
  - delta_acceleration : compare |3 derniers| vs |3 precedents|
    Plus grand = ACCELERE | Plus petit = DECELERE | Similaire = STABLE

==============================================================
LECTURE BID/ASK - REGLES EXACTES TRADER DALE
==============================================================

DEFINITIONS FONDAMENTALES (a respecter absolument) :
  BID = Sellers AGRESSIFS (market sell) + Buyers PASSIFS (limit buy)
  ASK = Buyers AGRESSIFS (market buy) + Sellers PASSIFS (limit sell)

  COULEUR DE CELLULE (footprint) :
  - Cellule VERTE : Ask > Bid dans cette cellule = buyers agressifs dominent
  - Cellule ROUGE : Bid > Ask dans cette cellule = sellers agressifs dominent

  DELTA PAR BOUGIE = Ask - Bid (difference globale par footprint)
  - Delta POSITIF (vert) = Ask > Bid = buyers agressifs dominaient ce footprint
  - Delta NEGATIF (rouge) = Bid > Ask = sellers agressifs dominaient ce footprint

IMBALANCES (signal cle Trader Dale) :
  - Ask >= 300% de Bid = BUYING IMBALANCE (marque en bleu sur Ask)
    -> Buyers TRES agressifs : ils veulent entrer a tout prix
  - Bid >= 300% de Ask = SELLING IMBALANCE (marque en bleu sur Bid)
    -> Sellers TRES agressifs : ils veulent sortir a tout prix
  - Comparaison DIAGONALE (chaque cellule Ask comparee au Bid de la cellule en-dessous)

STACKED IMBALANCES (3+ imbalances empilees) :
  - 3+ Buying Imbalances en pile = zone SUPPORT tres forte (institutionnels acheteurs massifs)
  - 3+ Selling Imbalances en pile = zone RESISTANCE tres forte (institutionnels vendeurs massifs)
  - Ma logique : ces zones sont comme des zones de rechargement institutionnel
  - Si prix revient sur Stacked Imbalance -> reaction probable = trader au premier retest

HIGH VOLUME NODE (HVN) :
  - Cellule avec CONTOUR NOIR dans le footprint = volume le plus lourd de ce footprint
  - MULTIPLE NODE (jaune) : 2+ HVN au meme prix sur footprints consecutifs = S/R tres forte

UNFINISHED BUSINESS (aimant a prix) :
  - High forme sans 0 au Bid = Failed Auction High = ligne pointillee verte = le prix reviendra tester
  - Low forme sans 0 au Ask = Failed Auction Low = ligne pointillee rouge = le prix reviendra tester
  - Si Unfinished Business est ENTRE l'entree et le TP : risque que prix soit aspire vers lui

Lis les 5 dernieres valeurs Bid et Ask (colonnes les plus a droite)
Renseigne bid_sequence et ask_sequence

==============================================================
ETAPE 2 - LES 6 SETUPS ORDER FLOW (methode Trader Dale)
==============================================================

REGLE FONDAMENTALE (Trader Dale, page 72) :
  Les confirmations Order Flow fonctionnent UNIQUEMENT autour de zones S/R etablies.
  Sans zone S/R identifiee, les signaux isolats ne signifient rien.
  Cherche d'abord la zone S/R, ENSUITE cherche la confirmation.

--- SETUP 1 : DIVERGENCE PRIX / CUM.DELTA ---
Source : Trader Dale, pages 19-21 et 93-94

  Signal le plus puissant selon Trader Dale.
  Valide SEULEMENT pres d'une zone S/R.

  DIVERGENCE HAUSSIERE VRAIE :
  - Prix BAISSE (fait de nouveaux plus bas) MAIS Cum.Delta MONTE (ou est moins negatif)
  - = Les buyers entrent meme si le prix continue de baisser
  - = Pression acheteuse cachee -> retournement probable
  - Signal = BUY confirmation (attendre rebond du prix de 2-3 bougies)

  DIVERGENCE BAISSIERE VRAIE :
  - Prix MONTE (fait de nouveaux plus hauts) MAIS Cum.Delta BAISSE (ou est moins positif)
  - = Les sellers entrent meme si le prix continue de monter
  - = Pression vendeuse cachee -> retournement probable
  - Signal = SELL confirmation (attendre recul du prix)

  CONFIRMATION HAUSSIERE (pas une divergence) :
  - Prix monte + Cum.Delta monte = tendance confirmee = continuer BUY
  CONFIRMATION BAISSIERE (pas une divergence) :
  - Prix baisse + Cum.Delta baisse = tendance confirmee = continuer SELL

  ERREURS A EVITER :
  - Prix DOWNTREND 10+ bougies + Cum.Delta negatif = CONFIRMATION BEARISH (pas divergence)
  - Prix baisse + Cum.Delta negatif + 1-2 bougies vertes = rebond dans tendance (pas divergence)
  - Ne classifier en "divergence haussiere" que si le prix REMONTE VRAIMENT (3+ bougies)

--- SETUP 2 : ABSORPTION ---
Source : Trader Dale, pages 79-80

  L'absorption = la pression d'UN COTE est absorbee par l'autre cote.

  ABSORPTION ACHETEUSE (a un support) - VALIDE :
  - Sellers agressifs poussent fort (Bid eleve, Delta negatif) VERS un support
  - MAIS des Buyers absorbent TOUT : volumes ELEVES sur BID ET ASK (les deux !)
  - Prix NE DESCEND PAS malgre la pression vendeuse
  - Suivi de 2-3 bougies vertes de rebond
  - = Les institutionnels absorbent la pression vendeuse -> BUY fort

  ABSORPTION VENDEUSE (a une resistance) - VALIDE :
  - Buyers agressifs poussent fort (Ask eleve, Delta positif) VERS une resistance
  - MAIS des Sellers absorbent TOUT : volumes ELEVES sur BID ET ASK (les deux !)
  - Prix NE MONTE PAS malgre la pression acheteuse
  - Suivi de 2-3 bougies rouges de recul
  - = Les institutionnels absorbent la pression acheteuse -> SELL fort

  FAUSSE ABSORPTION :
  - Gros deltas negatifs dans un downtrend fort MAIS prix continue de baisser
  - = Ce n'est PAS de l'absorption, c'est juste du volume de vente agressif
  - NE PAS appeler absorption si le prix ne tient pas le niveau

--- SETUP 3 : ORDRES AGRESSIFS + DELTA ---
Source : Trader Dale, pages 84-86

  A une zone S/R, cherche des ordres agressifs qui CONFIRMENT la reaction :
  - Prix entre en RESISTANCE : cherche volumes ELEVES au BID = sellers agressifs qui sautent
    Delta negatif = confirmation sellers dominent -> SELL
  - Prix entre en SUPPORT : cherche volumes ELEVES au ASK = buyers agressifs qui sautent
    Delta positif = confirmation buyers dominent -> BUY
  - Encore mieux : Confirmation #1 (Limit order) PUIS Confirmation #3 (agressif) = signal majeur

--- SETUP 4 : STACKED IMBALANCES ---
  Voir section BID/ASK ci-dessus.
  Trading : attendre pullback sur la zone, entrer au premier retest.

--- SETUP 5 : MULTIPLE HIGH VOLUME NODES ---
  2+ HVN (contour noir) au meme prix sur footprints consecutifs = zone S/R forte.
  Mon logiciel les marque en JAUNE automatiquement.
  Trading : attendre pullback, entrer au premier retest de la zone jaune.

--- SETUP 6 : VOLUME CLUSTERS ---
  Zone sombre (volumes lourds) visible sur les footprints = institutions tres actives la.
  Dans un trend : Volume Cluster = support/resistance dans le trend.
  Dans une rejection : Volume Cluster = zone de rechargement institutionnel.

==============================================================
ETAPE 3 - CUM.DELTA : CONTEXTE DE SESSION
==============================================================

  Le Cum.Delta donne le CONTEXTE GLOBAL (pas un signal seul).
  Trader Dale l'utilise comme confirmateur de la direction institutionnelle dominante.

  FORTEMENT NEGATIF (< -500) : vendeurs dominent la session
    -> Contexte baissier. Divergence haussiere dans ce contexte = signal tres puissant.
  MODEREMENT NEGATIF (-100 a -500) : legers vendeurs
  NEUTRE (-100 a +100) : equilibre -> regarder tendance recente
  MODEREMENT POSITIF (+100 a +500) : legers acheteurs
  FORTEMENT POSITIF (> +500) : acheteurs dominent la session

==============================================================
ETAPE 4 - VALUE AREA / POC / VOLUME PROFILE SHAPE
==============================================================

  VALUE AREA HIGH (VAH) = resistance institutionnelle
    - Prix approche VAH depuis le bas = resistance -> SELL ou attendre confirmation
    - Prix casse VAH avec imbalances = breakout -> BUY fort

  VALUE AREA LOW (VAL) = support institutionnel
    - Prix approche VAL depuis le haut = support -> BUY ou attendre confirmation
    - Prix casse VAL avec imbalances = breakdown -> SELL fort

  POC = aimant a prix (point d'equilibre institutionnel)
    - Prix au-dessus POC = structure haussiere / En-dessous = baissiere

  FORME DU VOLUME PROFILE (si visible) :
    - Forme en D = balance/consolidation = grand mouvement imminent
    - Forme en P = acheteurs ont pris le controle, puis rotation = contexte haussier
    - Forme en b = vendeurs ont pris le controle, puis rotation = contexte baissier
    - Profil fin = trend fort, peu d'accumulation

==============================================================
ETAPE 5 - UNFINISHED BUSINESS (aimants a prix)
==============================================================

  Si tu vois des lignes pointillees vertes ou rouges sur le chart :
  - Ligne pointillee = Unfinished Business = le prix REVIENDRA tester cette zone
  - Si Unfinished Business est SOUS le prix ET tu veux BUY = risque d'etre aspire vers le bas
  - Si Unfinished Business est AU-DESSUS du prix ET tu veux SELL = risque d'etre aspire vers le haut
  - Utiliser comme info pour le TP ou le SL, pas comme signal seul

==============================================================
ETAPE 6 - INTENTION INSTITUTIONNELLE (Bid/Ask + Delta)
==============================================================

  PRESSION NETTE = Ask_moyen - Bid_moyen (5 dernieres bougies)
  -> Pression positive = buyers agressifs dominent
  -> Pression negative = sellers agressifs dominent

  ASYMETRIE (signal precoce le plus puissant) :
  -> Ask >> Bid + prix immobile = sellers PASSIFS absorbent les acheteurs agressifs
     = Distribution cachee = SELL imminent
  -> Bid >> Ask + prix immobile = buyers PASSIFS absorbent les vendeurs agressifs
     = Accumulation cachee = BUY imminent
  -> Ask >> Bid + prix qui monte = ACHAT_FORT (acheteurs agressifs dominent)
  -> Bid >> Ask + prix qui baisse = VENTE_FORTE (vendeurs agressifs dominent)

  ACCELERATION DELTA :
  -> Delta qui ACCELERE dans sens trend = momentum qui s'amplifie
  -> Delta qui DECELERE = attention retournement possible

  INTENTION FINALE :
  ACHAT_FORT   : Ask >> Bid + Delta positif accelere + prix monte
  ACHAT_CACHE  : Bid eleve + prix immobile ou baisse legere = accumulation cachee
  VENTE_FORTE  : Bid >> Ask + Delta negatif accelere + prix baisse
  VENTE_CACHEE : Ask eleve + prix immobile ou monte legerement = distribution cachee
  EQUILIBRE    : ratio proche de 1, delta stable
  TRANSITION   : acceleration change de sens

==============================================================
ETAPE 7 - SIGNAUX DIRECTIONNELS (fleches)
==============================================================

  Fleche verte UP = signal BUY
  Fleche rouge DOWN = signal SELL
  Fleche cyan/bleue UP = signal BUY institutionnel fort
  Fleche cyan/bleue DOWN = signal SELL institutionnel fort

  REGLE : Les fleches CONFIRMENT un setup identifie, elles ne declenchent pas seules.
  Plusieurs fleches cyan consecutives + confirmation S/R = signal institutionnel majeur.

==============================================================
ETAPE 8 - NIVEAUX DE TRADING
==============================================================

  Support     = dernier bas significatif OU VAL OU Stacked Imbalance achat OU Multiple Node
  Resistance  = dernier haut significatif OU VAH OU Stacked Imbalance vente OU Multiple Node
  POC         = niveau de plus fort volume de la session
  Unfinished Business = aimant a prix (voir etape 5)

  BUY  : Entry = prix actuel ou pullback sur support, SL = sous support, TP avant resistance
  SELL : Entry = prix actuel ou rebond sur resistance, SL = au-dessus resistance, TP avant support

==============================================================
ETAPE 9 - DECISION FINALE
==============================================================

  SIGNAUX BUY FORTS :
    - Prix UPTREND + Cum.Delta positif = tendance confirmee -> BUY
    - Prix baisse + Cum.Delta monte (divergence haussiere) pres d'un support -> BUY
    - Absorption acheteuse a un support (Bid+Ask eleves, prix tient, rebond) -> BUY
    - Stacked Buying Imbalances + pullback sur la zone -> BUY premier retest
    - Multiple Node jaune + pullback -> BUY premier retest
    - Acheteurs agressifs (Ask >> Bid) + Delta positif pres d'un support -> BUY

  SIGNAUX SELL FORTS :
    - Prix DOWNTREND + Cum.Delta negatif = tendance confirmee -> SELL
    - Prix monte + Cum.Delta baisse (divergence baissiere) pres d'une resistance -> SELL
    - Absorption vendeuse a une resistance (Bid+Ask eleves, prix tient, recul) -> SELL
    - Stacked Selling Imbalances + rebond sur la zone -> SELL premier retest
    - Vendeurs agressifs (Bid >> Ask) + Delta negatif pres d'une resistance -> SELL

  ATTENDRE :
    - Aucune zone S/R claire identifiee
    - Signaux contradictoires entre setups
    - 1-2 bougies de rebond insuffisantes pour divergence
    - Cum.Delta neutre + range sans direction
    - Session Asie (liquidite faible)

  PIEGES CRITIQUES :
    PIEGE 1 : Downtrend fort + fleche BUY isolee = trap haussier -> SELL ou ATTENDRE
    PIEGE 2 : Gros deltas negatifs dans downtrend = volume vente (pas absorption)
    PIEGE 3 : Prix baisse + Cum.Delta negatif = CONFIRMATION BEARISH (pas divergence)
    PIEGE 4 : Unfinished Business entre entree et TP = risque etre aspire vers lui

  Session :
    Overlap Londres/NY -> +10 confiance
    Asie -> -15 confiance, ATTENDRE si < 50
    Weekend -> ATTENDRE

==============================================================
FORMAT JSON - retourne exactement ceci, rien d'autre
==============================================================
{
  "signal": "BUY" ou "SELL" ou "ATTENDRE",
  "asset": "symbole exact",
  "timeframe": "timeframe visible",
  "current_price": prix axe droit (number),
  "confidence": 0-100,

  "price_trend": "UPTREND" | "DOWNTREND" | "RANGE",
  "price_trend_explanation": "description des hauts/bas sur 15 bougies",

  "cum_delta_cell_color": "RED" ou "GREEN",
  "cum_delta": valeur avec signe (number, ex: -306),
  "cum_delta_context": "FORTEMENT_NEGATIF" | "NEGATIF" | "NEUTRE" | "POSITIF" | "FORTEMENT_POSITIF",

  "divergence_type": "HAUSSIERE" | "BAISSIERE" | "CONFIRMATION_BULL" | "CONFIRMATION_BEAR" | "NEUTRE",
  "divergence_explanation": "prix fait X, Cum.Delta fait Y = signal Z",
  "divergence_signal": "BUY" | "SELL" | "NEUTRE",

  "absorption_detected": true | false,
  "absorption_type": "ACHETEUSE" | "VENDEUSE" | null,
  "absorption_explanation": "niveau + bid+ask eleves ensemble + comportement prix apres",

  "imbalances_detected": "BUYING" | "SELLING" | "STACKED_BUYING" | "STACKED_SELLING" | "NONE",
  "imbalances_explanation": "description des imbalances visibles (cellules bleues)",

  "hvn_multiple_nodes": true | false,
  "hvn_explanation": "HVN (contour noir) ou Multiple Nodes (jaune) detectes et leur niveau",

  "unfinished_business": true | false,
  "unfinished_business_level": niveau ou null,
  "unfinished_business_risk": "RISK_BUY" | "RISK_SELL" | "NEUTRE" | null,

  "volume_profile_shape": "D" | "P" | "b" | "THIN" | "NON_VISIBLE",

  "value_area_position": "HAUT" | "BAS" | "MILIEU" | "NON_VISIBLE",
  "value_area_signal": "DISTRIBUTION_RESISTANCE" | "ACCUMULATION_SUPPORT" | "BREAKOUT_BULL" | "BREAKDOWN_BEAR" | "NEUTRE" | "NON_VISIBLE",
  "value_area_explanation": "position VAH/VAL/POC + impact signal",

  "delta_bias": "HAUSSIER" | "BAISSIER" | "NEUTRE",
  "delta_last": "derniere valeur ex: -3",
  "delta_sequence": "10 derniers deltas gauche->droite",
  "delta_recent_trend": "POSITIF" | "NEGATIF" | "MIXTE",
  "delta_acceleration": "ACCELERE" | "DECELERE" | "STABLE",

  "bid_sequence": "5 dernieres valeurs Bid",
  "ask_sequence": "5 dernieres valeurs Ask",
  "bid_ask_pressure": "ACHAT_FORT" | "ACHAT_MODERE" | "EQUILIBRE" | "VENTE_MODERE" | "VENTE_FORTE",

  "intention": "ACHAT_FORT" | "ACHAT_CACHE" | "VENTE_FORTE" | "VENTE_CACHEE" | "EQUILIBRE" | "TRANSITION",
  "intention_score": 0-100,
  "intention_explanation": "ratio Bid/Ask + acceleration + asymetrie detectee",

  "buy_signals": nombre fleches BUY,
  "sell_signals": nombre fleches SELL,
  "institutional_signals": nombre fleches cyan,
  "institutional_direction": "BUY" | "SELL" | "MIXTE" | "AUCUN",

  "active_setup": "DIVERGENCE" | "ABSORPTION" | "STACKED_IMBALANCE" | "MULTIPLE_NODE" | "VOLUME_CLUSTER" | "AGGRESSIVE_ORDERS" | "AUCUN",
  "sr_zone_identified": true | false,
  "sr_zone_explanation": "zone S/R identifiee et comment (Volume Cluster, HVN, VAH/VAL...)",

  "confluence_score": 0-6,
  "confluence_elements": ["setups qui convergent vers le signal"],
  "anti_confluence": ["setups qui contredisent - OBLIGATOIRE"],

  "entry": prix entree (number ou null),
  "stop_loss": SL (number ou null),
  "tp1": TP1 (number ou null),
  "tp2": TP2 (number ou null),
  "key_support": support cle (number ou null),
  "key_resistance": resistance cle (number ou null),
  "poc": POC (number ou null),

  "orderflow_score": 0-100,
  "session": "${session.label}",
  "session_quality": "${session.quality}",

  "reasoning": {
    "setup_principal": "Quel setup Trader Dale est actif ? Divergence / Absorption / Stacked Imbalance / Multiple Node / Volume Cluster. JUSTIFICATION.",
    "sr_zone": "Quelle zone S/R est identifiee et comment ? Sans S/R = pas de confirmation valide.",
    "bid_ask_reading": "BID = sellers agressifs + buyers passifs. ASK = buyers agressifs + sellers passifs. Que montrent les sequences bid/ask recentes ?",
    "divergence": "Prix trend = X. Cum.Delta = Y. Vraie divergence ou confirmation de tendance ? JUSTIFICATION PRECISE.",
    "absorption": "Gros volumes sur BID ET ASK ensemble (les deux !) ? Prix tient le niveau ? Rebond confirme ?",
    "imbalances": "Cellules bleues visibles ? Buying ou Selling ? Stacked (3+) ? Niveau ?",
    "hvn_nodes": "Contours noirs visibles (HVN) ? Zones jaunes (Multiple Nodes) ? Niveaux ?",
    "intention": "Ratio Bid/Ask. Acceleration Delta. Asymetrie. Conclusion intention institutionnelle.",
    "synthese": "En 3 phrases : setup actif, zone S/R, signal final et pourquoi."
  },

  "synthesis": "1 phrase : setup Trader Dale actif + signal + zone S/R",
  "warnings": ["pieges ou contradictions identifies"]
}`;
}

// Routes Express
app.use(express.static(join(__dirname, 'public')));

app.get('/api/history', (_req, res) => {
  res.json(history.slice().reverse());
});

app.get('/api/session', (_req, res) => {
  const now = new Date();
  res.json(getSession(now.getUTCHours(), now.getUTCDay()));
});

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// WebSocket Live Analysis
wss.on('connection', (ws) => {
  console.log('[WS] Client connecte');
  send(ws, { type: 'connected' });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', message: 'JSON invalide' }); }

    if (msg.type !== 'frame' || !msg.data) return;

    const cumDeltaSign = msg.cum_delta_sign || 'auto'; // 'negative', 'positive', 'auto'

    send(ws, { type: 'analyzing' });

    const keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send(ws, { type: 'keepalive' });
    }, 12000);

    try {
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
              text: `Analyse ce chart Belkhayate OrderFlow NinjaTrader.

${cumDeltaSign !== 'auto' ? `
!!! SIGNE CUM.DELTA CONFIRME PAR LE TRADER (PRIORITE ABSOLUE) !!!
Le trader a regarde les cellules de la ligne Cum.Delta dans NinjaTrader.
Les cellules sont ${cumDeltaSign === 'negative' ? 'ROUGES = valeur NEGATIVE' : 'VERTES = valeur POSITIVE'}.
REGLE : lis le nombre dans la cellule Cum.Delta (ligne 3 depuis le bas), puis applique le signe ${cumDeltaSign === 'negative' ? 'NEGATIF (mets un - devant)' : 'POSITIF'}.
cum_delta_cell_color = "${cumDeltaSign === 'negative' ? 'RED' : 'GREEN'}"
` : `
RAPPELS AVANT ANALYSE :
1. COULEUR CELLULE = SIGNE : rouge -> negatif, vert -> positif
2. Cum.Delta = 3eme ligne depuis le bas (grandes valeurs +/-200 a +/-2000)
`}

Retourne UNIQUEMENT le JSON.`
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
        return send(ws, { type: 'error', message: 'Erreur parsing Claude', raw: rawText.slice(0, 500) });
      }

      const entry = { ...parsed, timestamp: Date.now() };
      history.push(entry);
      if (history.length > MAX_HISTORY) history.shift();

      send(ws, { type: 'signal', payload: entry, timestamp: Date.now() });
      console.log(`[SIGNAL] ${parsed.asset} - ${parsed.signal} - conf:${parsed.confidence}%`);

    } catch (err) {
      clearInterval(keepAlive);
      const msg2 = err instanceof Error ? err.message : 'Erreur inconnue';
      console.error('[ERR]', msg2);
      send(ws, { type: 'error', message: msg2 });
    }
  });

  ws.on('close', () => console.log('[WS] Client deconnecte'));
  ws.on('error', (e) => console.error('[WS Error]', e.message));
});

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// Start
const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`OrderFlow Live Analysis - http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY non defini - analyses desactivees');
  }
});
