import { GoogleGenAI } from '@google/genai';

/**
 * Fallback deterministic tactical analysis when GEMINI_API_KEY is not configured or network call fails.
 */
function generateDeterministicInsights(match, commentaryList) {
  const { homeTeam, awayTeam, homeScore, awayScore, sport, status } = match;
  const totalComments = commentaryList.length;

  let homeProb = 50;
  let awayProb = 50;
  const scoreDiff = (homeScore || 0) - (awayScore || 0);

  if (scoreDiff > 0) {
    homeProb = Math.min(88, 55 + scoreDiff * 12);
    awayProb = 100 - homeProb;
  } else if (scoreDiff < 0) {
    awayProb = Math.min(88, 55 + Math.abs(scoreDiff) * 12);
    homeProb = 100 - awayProb;
  }

  // Factor in recent goals or cards from commentary
  const recentEvents = commentaryList.slice(0, 5);
  const recentGoal = recentEvents.find(c => c.eventType === 'goal' || c.eventType === 'wicket' || c.eventType === 'six');
  const recentCard = recentEvents.find(c => c.eventType === 'card' || c.eventType === 'foul');

  let favored = 'Balanced';
  if (homeProb > awayProb) favored = homeTeam;
  else if (awayProb > homeProb) favored = awayTeam;

  const keyPoints = [];
  if (scoreDiff === 0) {
    keyPoints.push(`Both ${homeTeam} and ${awayTeam} are locked in a tense tactical stalemate.`);
  } else {
    keyPoints.push(`${favored} is capitalizing on transitional superiority with a ${Math.abs(scoreDiff)}-point advantage.`);
  }

  if (recentGoal) {
    keyPoints.push(`Crucial breakthrough delivered by ${recentGoal.actor || recentGoal.team || 'key attackers'} in recent action.`);
  } else {
    keyPoints.push(`Defensive discipline has defined the midfield battle with high-intensity pressing.`);
  }

  if (recentCard) {
    keyPoints.push(`Disciplinary pressure mounting following recent fouls and card warnings.`);
  } else {
    keyPoints.push(`Clean, calculated game management from both coaching setups.`);
  }

  return {
    summary: `${homeTeam} vs ${awayTeam} is operating at high intensity. With the score currently at ${homeScore} - ${awayScore}, ${favored === 'Balanced' ? 'neither side has firmly seized control' : `${favored} holds tactical control`}.`,
    momentum: {
      favoredTeam: favored,
      homeWinProbability: homeProb,
      awayWinProbability: awayProb,
      description: scoreDiff === 0 
        ? 'Momentum is neutral with continuous counter-pressing from both sides.' 
        : `Momentum firmly tilts toward ${favored} following recent scoring efficiency.`,
    },
    keyTacticalPoints: keyPoints,
    standoutPlayers: recentEvents
      .filter(c => c.actor)
      .slice(0, 3)
      .map(c => `${c.actor} (${c.team || 'Star'})`)
      .concat([`${homeTeam} Playmaker`, `${awayTeam} Goalkeeper`])
      .slice(0, 2),
    predictedOutcome: status === 'finished'
      ? `Match concluded ${homeScore} - ${awayScore}.`
      : scoreDiff > 0
        ? `${homeTeam} favored to maintain lead and close out a ${homeScore}-${awayScore} victory.`
        : scoreDiff < 0
          ? `${awayTeam} poised to secure the win under sustained counter-attack pressure.`
          : `A tightly contested finish likely ending in a draw or 1-goal decider.`,
    generatedBy: 'deterministic-fallback'
  };
}

/**
 * Generates AI Tactical Insights using Gemini 3.8 Flash with strict JSON schema constraints.
 */
export async function generateMatchInsights(match, commentaryList) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return generateDeterministicInsights(match, commentaryList);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const recentEventsSummary = commentaryList.slice(0, 10).map(c => 
      `- Minute ${c.minute || 'N/A'}: [${c.eventType || 'play'}] ${c.team ? `(${c.team}) ` : ''}${c.message} (Actor: ${c.actor || 'N/A'})`
    ).join('\n');

    const prompt = `Analyze this real-time sports match and produce a tactical intelligence breakdown:
Sport: ${match.sport}
Home Team: ${match.homeTeam} (Score: ${match.homeScore})
Away Team: ${match.awayTeam} (Score: ${match.awayScore})
Status: ${match.status}

Recent Live Match Events & Commentary:
${recentEventsSummary || 'No commentary events logged yet.'}

Output a strictly conforming JSON object with this exact structure:
{
  "summary": "2-3 sentence tactical summary of the current state of play",
  "momentum": {
    "favoredTeam": "Exact team name or 'Balanced'",
    "homeWinProbability": 60,
    "awayWinProbability": 40,
    "description": "Short explanation of momentum swing"
  },
  "keyTacticalPoints": [
    "Tactical observation 1",
    "Tactical observation 2",
    "Tactical observation 3"
  ],
  "standoutPlayers": [
    "Player name or role 1",
    "Player name or role 2"
  ],
  "predictedOutcome": "Prediction of final outcome or next critical event",
  "generatedBy": "gemini-3.8-flash"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        systemInstruction: 'You are an elite sports tactical analyst (Opta / ESPN style). Output ONLY valid, parseable JSON conforming strictly to the requested schema. Never output markdown code fences, raw text, or JSX.'
      }
    });

    const text = response.text?.trim();
    if (!text) {
      return generateDeterministicInsights(match, commentaryList);
    }

    const parsed = JSON.parse(text);
    return {
      ...parsed,
      generatedBy: 'gemini-3.8-flash'
    };
  } catch (err) {
    console.error('Failed to generate Gemini AI insights, falling back to deterministic engine:', err?.message || err);
    return generateDeterministicInsights(match, commentaryList);
  }
}
