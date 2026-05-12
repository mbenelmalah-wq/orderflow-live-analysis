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

  return `Tu es un trader institutionnel Order Flow expert forme a l'ecole des prop traders.
Tu analyses des charts NinjaTrader Belkhayate OrderFlow avec une precision chirurgicale.
Retourne UNIQUEMENT du JSON valide. Aucun texte avant ou apres.
Analyse UNIQUEMENT ce que tu vois sur cette image. Chaque analyse est independante.

HEURE UTC : ${utcHour}h - ${days[utcDay]} ${now.toUTCString()}
SESSION : ${session.label}

==============================================================
ETAPE 1 - LECTURE BRUTE (donnees factuelles, pas d'interpretation)
==============================================================

PRIX ACTUEL : rectangle surbrillant sur l'axe DROIT -> lis exactement (ex: 4701.2)
INSTRUMENT  : nom en haut a gauche (ex: GC JUN26)
CHRONOLOGIE : GAUCHE = ancien, DROITE = recent. Sequence toujours de gauche a droite.

REGLE COULEUR = SIGNE - PRIORITE ABSOLUE SUR TOUT TEXTE VISIBLE :
  CELLULE ROUGE = valeur NEGATIVE  ("306" rouge -> -306)
  CELLULE VERTE = valeur POSITIVE  ("306" vert  -> +306)
  Le tiret "-" peut etre invisible ou coupe. La COULEUR prime toujours.

STRUCTURE DU TABLEAU (bas -> haut, confirmee par l'utilisateur) :
  LIGNE 1 (bas) : Min. Delta  - petites valeurs negatives (-3, -12...)
  LIGNE 2       : Max. Delta  - petites valeurs positives (25, 44...)
  LIGNE 3       : Cum. Delta  - GRANDES valeurs (+/-200 a +/-2000) LECTURE PRIORITAIRE
  LIGNE 4       : Volume      - grandes valeurs positives (69, 200, 400...)
  LIGNE 5       : Delta       - petites valeurs mixtes (-7, 23, -14...)
  LIGNE 6       : Bid         - volumes bid
  LIGNE 7 (haut): Ask         - volumes ask

LECTURE CUM.DELTA (ligne 3, 3eme depuis le bas) :
  -> Cellule la plus a DROITE = valeur de session actuelle
  -> Couleur rouge = negatif / verte = positif
  -> Si |valeur| < 100 -> mauvaise ligne lue (refaire)
  -> Renseigne "cum_delta_cell_color": "RED" ou "GREEN"

TENDANCE DU PRIX (regarde les 15 dernieres bougies) :
  -> Prix fait des sommets et creux de PLUS EN PLUS HAUTS = UPTREND
  -> Prix fait des sommets et creux de PLUS EN PLUS BAS = DOWNTREND
  -> Prix oscille sans direction claire = RANGE
  -> Renseigne "price_trend": "UPTREND" | "DOWNTREND" | "RANGE"

DELTA/BOUGIE (ligne 5) : lis les 10 dernieres valeurs gauche -> droite
  -> Renseigne "delta_recent_trend": "POSITIF" | "NEGATIF" | "MIXTE"
     (les 3-4 dernieres bougies vont-elles dans le meme sens ?)

Fleches vertes UP = BUY | Fleches rouges DOWN = SELL
Fleches cyan/bleues UP = BUY institutionnel | Fleches cyan/bleues DOWN = SELL institutionnel

==============================================================
ETAPE 2 - LES 5 PILIERS DE L'ORDERFLOW (ordre de priorite reel)
==============================================================

PILIER 1 - DIVERGENCE PRIX / CUM.DELTA (signal le plus fort - prime sur tout)
-------------------------------------------------------------------------------
C'est LE signal institutionnel numero 1. Mais tu dois identifier le bon type.

DEFINITIONS EXACTES - LIRE ATTENTIVEMENT :

CONFIRMATION BAISSIERE (prix baisse + Cum.Delta negatif/baisse) :
  -> Prix fait des creux de plus en plus bas SUR LES 15 DERNIERES BOUGIES
  -> ET Cum.Delta est negatif ou de plus en plus negatif
  -> Ce n'est PAS une divergence. C'est une TENDANCE CONFIRMEE.
  -> Signal = SELL ou ATTENDRE (ne pas aller contre la tendance)
  EXEMPLE : prix descend de 4682 a 4668 (DOWNTREND) + Cum.Delta = -339 = CONFIRMATION BEARISH = SELL

CONFIRMATION HAUSSIERE (prix monte + Cum.Delta positif) :
  -> Prix fait des sommets de plus en plus hauts
  -> ET Cum.Delta positif ou de plus en plus positif
  -> Signal = BUY ou ATTENDRE

VRAIE DIVERGENCE HAUSSIERE (signal BUY contre-tendance) :
  CONDITION STRICTE : le prix doit faire des CREUX PLUS HAUTS (rebond) pendant que Cum.Delta RESTE negatif
  -> Prix : creux precedent a 4680, nouveau creux a 4685 (plus haut !) malgre pression vendeuse
  -> Cum.Delta : toujours negatif ou qui baisse
  -> Les acheteurs repoussent le prix vers le haut malgre les vendeurs
  -> Signal = BUY uniquement si le rebond du prix EST CONFIRME (2-3 bougies de hausse)
  ATTENTION : un simple rebond de 1-2 bougies dans un DOWNTREND fort n'est PAS une divergence haussiere

VRAIE DIVERGENCE BAISSIERE (signal SELL contre-tendance) :
  CONDITION STRICTE : prix fait des SOMMETS PLUS BAS pendant que Cum.Delta reste positif
  -> Signal = SELL uniquement si la baisse est confirmee

REGLE CRITIQUE :
  Prix DOWNTREND sur 10+ bougies + Cum.Delta negatif = CONFIRMATION BEARISH = SELL (pas BUY !)
  Prix UPTREND sur 10+ bougies + Cum.Delta positif = CONFIRMATION BULLISH = BUY (pas SELL !)
  Prix DOWNTREND + Cum.Delta negatif + 1 bougie verte = rebond dans downtrend = PAS une divergence = ATTENDRE
  Prix DOWNTREND + prix qui REBONDIT sur 3+ bougies + Cum.Delta negatif = VRAIE divergence haussiere = BUY

PILIER 2 - ABSORPTION (retournement a un niveau cle - conditions strictes)
---------------------------------------------------------------------------
L'absorption = gros delta dans un sens + prix qui NE BOUGE PAS = institutionnels absorbent.
ATTENTION : l'absorption n'est valide QUE si le prix TIENT le niveau PUIS repart dans le sens oppose.

ABSORPTION ACHETEUSE VALIDE (a un support) :
  CONDITION 1 : gros deltas negatifs (-30, -40, -50, -70) a un niveau de support identifiable
  CONDITION 2 : le prix TIENT ce niveau (ne fait pas de nouveaux plus bas apres les gros deltas)
  CONDITION 3 : les bougies suivantes montrent un rebond (au moins 2 bougies vertes)
  -> Signal = BUY fort SEULEMENT si les 3 conditions sont remplies

  FAUSSE ABSORPTION (piege) :
  Gros deltas negatifs dans un DOWNTREND fort
  MAIS le prix continue de baisser apres (ou reste lateral brievement puis baisse encore)
  -> Ce n'est PAS de l'absorption. C'est juste du volume de vente.
  -> Ne pas appeler cela "absorption" si le prix continue de baisser.
  EXEMPLE : deltas -71, -44 au milieu d'un downtrend de 15 bougies puis prix continue a baisser = FAUSSE ABSORPTION

ABSORPTION VENDEUSE VALIDE (a une resistance) :
  Gros deltas positifs + prix ne monte pas + bougies suivantes rouges = SELL fort

EPUISEMENT DU CUM.DELTA :
  Cum.Delta atteint une valeur extreme ET ralentit (les increments deviennent petits)
  MAIS le prix ne fait plus de nouveaux extremes -> epuisement possible -> retournement

PILIER 3 - CUM.DELTA : CONTEXTE DE SESSION (pas signal seul)
------------------------------------------------------------
Le Cum.Delta donne le CONTEXTE GLOBAL, pas le signal direct.

FORTEMENT NEGATIF (< -500) : dominance vendeuse sur la session
  -> CONTEXTE baissier MAIS pas automatiquement un SELL
  -> Une divergence haussiere dans ce contexte = retournement tres puissant

MODEREMENT NEGATIF (-100 a -500) : legere dominance vendeuse
  -> Contexte legrement baissier
  -> Signaux BUY valides si confirmes par divergence ou absorption

NEUTRE (-100 a +100) : session equilibree -> regarder tendance recente

MODEREMENT POSITIF (+100 a +500) : legere dominance acheteuse

FORTEMENT POSITIF (> +500) : dominance acheteuse
  -> Signaux SELL valides si confirmes par divergence baissiere

PILIER 4 - VALUE AREA / POC (zones institutionnelles)
------------------------------------------------------
Les bandes horizontales = zones de fort volume institutionnel.

VALUE AREA HIGH (VAH) = resistance institutionnelle
  Prix approche VAH depuis le bas : resistance forte -> SELL ou ATTENDRE
  Prix casse VAH avec volume : breakout haussier -> BUY fort

VALUE AREA LOW (VAL) = support institutionnel
  Prix approche VAL depuis le haut : support fort -> BUY ou ATTENDRE
  Prix casse VAL avec volume : breakdown baissier -> SELL fort

POC = aimant a prix (prix revient toujours vers le POC)
  Prix au-dessus POC = structure haussiere
  Prix en-dessous POC = structure baissiere

PILIER 5 - SIGNAUX DIRECTIONNELS (confirmation institutionnelle)
---------------------------------------------------------------
Les fleches ne declenchent PAS seules - elles CONFIRMENT les piliers 1-4.

Fleche cyan/bleue UP = algorithme detecte accumulation institutionnelle
  -> Confirme une divergence haussiere ou une absorption acheteuse
  -> Plusieurs fleches cyan consecutives = signal institutionnel majeur

REGLE ANTI-PIEGE :
  Fleche cyan BUY + Cum.Delta tres negatif + prix en resistance = piege haussier
  Fleche cyan BUY + Cum.Delta negatif + prix qui monte = divergence confirmee = BUY reel

==============================================================
ETAPE 3 - NIVEAUX DE TRADING (lus sur l'image)
==============================================================

Support = dernier bas significatif OU VAL OU zone d'absorption acheteuse
Resistance = dernier haut significatif OU VAH OU zone d'absorption vendeuse
POC = niveau de plus fort volume dans les bougies footprint

BUY  : Entry = prix actuel ou pullback sur support, Stop = sous support, TP1/TP2 = resistances
SELL : Entry = prix actuel ou rebond sur resistance, Stop = au-dessus resistance, TP1/TP2 = supports

==============================================================
ETAPE 4 - DECISION FINALE (matrice complete)
==============================================================

SIGNAUX BUY FORTS (confluence 3+ piliers) :
  Prix UPTREND confirme (10+ bougies) + Cum.Delta positif                  -> BUY fort (confirmation)
  Prix rebondit (3+ bougies hausse) depuis support + Cum.Delta negatif     -> BUY (divergence reelle)
  Prix tient support + gros deltas negatifs + rebond confirme ensuite      -> BUY (absorption valide)
  Plusieurs fleches cyan UP + prix en hausse confirme                      -> BUY confirme

SIGNAUX SELL FORTS (confluence 3+ piliers) :
  Prix DOWNTREND confirme (10+ bougies) + Cum.Delta negatif               -> SELL fort (confirmation)
  Prix fait sommets plus bas + Cum.Delta positif                           -> SELL (divergence reelle)
  Prix bloque resistance + gros deltas positifs + recul confirme           -> SELL (absorption valide)
  Plusieurs fleches cyan DOWN + prix en baisse confirme                    -> SELL confirme

ATTENDRE (signaux insuffisants) :
  Prix DOWNTREND + 1-2 bougies de rebond (pas assez pour divergence)
  Prix DOWNTREND + Cum.Delta negatif + signal BUY isole = rebond dans tendance -> ATTENDRE
  Signaux contradictoires entre les 5 piliers
  Cum.Delta neutre + prix en range sans direction
  Session Asie

PIEGES CRITIQUES A IDENTIFIER :
  PIEGE 1 : Prix DOWNTREND 10+ bougies + Cum.Delta negatif + fleche BUY = TRAP HAUSSIER
    -> La fleche BUY dans un downtrend fort = signal de continuation baissiere probable
    -> Reponse = SELL ou ATTENDRE, JAMAIS BUY
  PIEGE 2 : Gros deltas negatifs dans un downtrend = continuation vendeuse, pas absorption
    -> L'absorption n'est valide QUE si le prix rebondit apres (3+ bougies vertes)
  PIEGE 3 : Cum.Delta tres negatif + prix qui baisse = CONFIRMATION BEARISH, pas divergence
    -> La divergence haussiere = prix monte MALGRE Cum.Delta negatif (pas prix qui baisse)

Session :
  Overlap Londres/NY -> +10 confiance (max 95)
  Asie -> -15 confiance, ATTENDRE si < 50
  Weekend -> ATTENDRE force

==============================================================
FORMAT JSON - retourne exactement ceci, rien d'autre
==============================================================
{
  "signal": "BUY" ou "SELL" ou "ATTENDRE",
  "asset": "symbole exact",
  "timeframe": "gamme ou timeframe",
  "current_price": prix lu sur axe droit (number, jamais null),
  "confidence": 0-100,

  "price_trend": "UPTREND" ou "DOWNTREND" ou "RANGE",
  "price_trend_explanation": "description des hauts/bas recents observes sur les 15 dernieres bougies",

  "cum_delta_cell_color": "RED" ou "GREEN",
  "cum_delta": valeur avec signe couleur (number, ex: -306),
  "cum_delta_context": "FORTEMENT_NEGATIF" ou "NEGATIF" ou "NEUTRE" ou "POSITIF" ou "FORTEMENT_POSITIF",

  "divergence_type": "HAUSSIERE" ou "BAISSIERE" ou "CONFIRMATION_BULL" ou "CONFIRMATION_BEAR" ou "NEUTRE",
  "divergence_explanation": "prix fait X, Cum.Delta fait Y, donc le signal est Z",
  "divergence_signal": "BUY" ou "SELL" ou "NEUTRE",

  "absorption_detected": true ou false,
  "absorption_type": "ACHETEUSE" ou "VENDEUSE" ou null,
  "absorption_explanation": "si detectee : niveau, delta, comportement du prix",

  "cum_delta_trap": true ou false,
  "cum_delta_trap_explanation": "explication du piege si applicable",

  "value_area_position": "HAUT" ou "BAS" ou "MILIEU" ou "NON_VISIBLE",
  "value_area_signal": "DISTRIBUTION_RESISTANCE" ou "ACCUMULATION_SUPPORT" ou "BREAKOUT_BULL" ou "BREAKDOWN_BEAR" ou "NEUTRE" ou "NON_VISIBLE",
  "value_area_explanation": "position bande + impact sur signal",

  "delta_bias": "HAUSSIER" ou "BAISSIER" ou "NEUTRE",
  "delta_last": "derniere valeur delta (ex: -3)",
  "delta_sequence": "10 derniers deltas gauche vers droite",
  "delta_recent_trend": "POSITIF" ou "NEGATIF" ou "MIXTE",

  "buy_signals": nombre fleches BUY vertes,
  "sell_signals": nombre fleches SELL rouges,
  "institutional_signals": nombre fleches cyan/bleues,
  "institutional_direction": "BUY" ou "SELL" ou "MIXTE" ou "AUCUN",

  "confluence_score": 0-5,
  "confluence_elements": ["piliers qui convergent vers le signal"],
  "anti_confluence": ["piliers qui contredisent - OBLIGATOIRE a lister"],

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
    "pilier1_divergence": "Prix trend = X. Cum.Delta = Y. Relation prix/delta = divergence haussiere/baissiere/confirmation. Signal induit : BUY/SELL/NEUTRE. JUSTIFICATION DETAILLEE.",
    "pilier2_absorption": "Y a-t-il un niveau ou le prix tient malgre des deltas contraires ? Identification precise.",
    "pilier3_cum_delta_contexte": "Valeur Cum.Delta = X (cellule couleur). Contexte de session. Comment ce contexte modifie la lecture des autres piliers ?",
    "pilier4_value_area": "Position des bandes institutionnelles. VAH/VAL/POC par rapport au prix. Impact sur le biais directionnel.",
    "pilier5_signaux": "Nombre et direction des fleches institutionnelles. Convergent-elles avec les piliers 1-4 ?",
    "synthese_finale": "En 3 phrases max : quel est LE signal dominant, pourquoi il prime sur les autres, quel est le risque principal."
  },

  "synthesis": "1 phrase : signal + raison principale OrderFlow",
  "warnings": ["contradictions ou risques detectes"]
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

    const cumDeltaOverride = (msg.cum_delta_override !== undefined && msg.cum_delta_override !== null)
      ? msg.cum_delta_override : null;

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

${cumDeltaOverride !== null ? `
!!! VALEUR CUM.DELTA FOURNIE PAR LE TRADER (PRIORITE ABSOLUE) !!!
CUM.DELTA = ${cumDeltaOverride}
NE PAS lire le tableau pour le Cum.Delta. Utilise UNIQUEMENT cette valeur : ${cumDeltaOverride}
cum_delta_cell_color = "${cumDeltaOverride < 0 ? 'RED' : 'GREEN'}"
cum_delta = ${cumDeltaOverride}
Cette valeur a ete saisie manuellement par le trader depuis NinjaTrader. Elle est fiable a 100%.
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
